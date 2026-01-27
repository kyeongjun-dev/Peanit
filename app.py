import os
import re
import hmac
import hashlib
import json
import time
import jwt
import requests
import queue
from flask import Flask, request, jsonify, abort, Response, stream_with_context
from flask_sqlalchemy import SQLAlchemy
from flask_cors import CORS
from dotenv import load_dotenv
import threading

# --- 1. 설정 및 환경변수 로드 ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(BASE_DIR, ".env"))

app = Flask(__name__)
CORS(app)

app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///tickets.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
db = SQLAlchemy(app)

GITHUB_APP_ID = os.getenv('GITHUB_APP_ID')
WEBHOOK_SECRET = os.getenv('WEBHOOK_SECRET')
raw_private_key = os.getenv('GITHUB_PRIVATE_KEY')
GITHUB_PRIVATE_KEY = raw_private_key.replace('\\n', '\n') if raw_private_key else None

# --- 방송국 클래스 ---
class MessageAnnouncer:
    def __init__(self):
        self.listeners = []
    def listen(self):
        q = queue.Queue(maxsize=5)
        self.listeners.append(q)
        return q
    def announce(self, msg):
        for i in reversed(range(len(self.listeners))):
            try:
                self.listeners[i].put_nowait(msg)
            except queue.Full:
                del self.listeners[i]

announcer = MessageAnnouncer()

# --- 2. DB 모델 ---
class Ticket(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    key = db.Column(db.String(20), unique=True, nullable=False)
    title = db.Column(db.String(200), nullable=False)
    content = db.Column(db.Text, default="")
    status = db.Column(db.String(20), default="To Do")
    order_index = db.Column(db.Integer, default=0)
    branch_url = db.Column(db.String(200))
    pr_url = db.Column(db.String(200))

    def to_dict(self):
        return {
            "key": self.key,
            "title": self.title,
            "content": self.content,
            "status": self.status,
            "order_index": self.order_index, # ✨
            "branch_url": self.branch_url,
            "pr_url": self.pr_url
        }

with app.app_context():
    db.create_all()

# --- 3. SSE 유틸리티 ---
def format_sse(data: str, event=None):
    msg = f'data: {data}\n\n'
    if event:
        msg = f'event: {event}\n{msg}'
    return msg.encode('utf-8')

def notify_frontend(ticket_key, status):
    data = json.dumps({'key': ticket_key, 'status': status})
    msg = format_sse(data, event="ticket_updated")
    announcer.announce(msg)
    print(f"📡 [SSE 방송] {ticket_key} 상태 변경 알림 전송")

# --- 4. GitHub API 유틸리티 (전체 스캔) ---
def get_github_token():
    payload = {'iat': int(time.time()), 'exp': int(time.time()) + (10 * 60), 'iss': GITHUB_APP_ID}
    encoded_jwt = jwt.encode(payload, GITHUB_PRIVATE_KEY, algorithm='RS256')
    headers = {'Authorization': f'Bearer {encoded_jwt}', 'Accept': 'application/vnd.github.v3+json'}

    resp = requests.get('https://api.github.com/app/installations', headers=headers)
    resp.raise_for_status()
    installations = resp.json()
    if not installations: return None
        
    installation_id = installations[0]['id']
    token_url = f'https://api.github.com/app/installations/{installation_id}/access_tokens'
    resp = requests.post(token_url, headers=headers)
    return resp.json()['token']

def check_existing_branch(ticket_key):
    """설치된 모든 리포지토리를 순회하며 브랜치 검색"""
    print(f"🔍 [검색 시작] {ticket_key} 브랜치 찾는 중...")
    try:
        token = get_github_token()
        if not token: return

        headers = {"Authorization": f"token {token}", "Accept": "application/vnd.github.v3+json"}
        
        # 앱이 설치된 리포지토리 목록 조회
        repos_url = "https://api.github.com/installation/repositories?per_page=100"
        repo_resp = requests.get(repos_url, headers=headers)
        if repo_resp.status_code != 200: return
        
        repositories = repo_resp.json().get('repositories', [])

        for repo in repositories:
            repo_full_name = repo['full_name']
            repo_html_url = repo['html_url']
            
            branches_url = f"https://api.github.com/repos/{repo_full_name}/branches"
            branches_resp = requests.get(branches_url, headers=headers)
            
            if branches_resp.status_code == 200:
                for branch in branches_resp.json():
                    if ticket_key in branch['name']:
                        # 찾음! DB 업데이트
                        with app.app_context():
                            ticket = Ticket.query.filter_by(key=ticket_key).first()
                            if ticket:
                                ticket.branch_url = f"{repo_html_url}/tree/{branch['name']}"
                                # if ticket.status == "To Do": ticket.status = "In Progress"
                                db.session.commit()
                                print(f"🔗 [자동 연결 완료] {repo_full_name} -> {branch['name']}")
                                notify_frontend(ticket.key, ticket.status)
                        return # 찾으면 종료
    except Exception as e:
        print(f"⚠️ 브랜치 스캔 실패: {e}")

# --- 5. API 엔드포인트 ---
@app.route('/api/tickets', methods=['GET'])
def get_tickets():
    # order_index 오름차순 (0, 1, 2...)
    tickets = Ticket.query.order_by(Ticket.order_index.asc()).all()
    return jsonify([t.to_dict() for t in tickets])

@app.route('/api/tickets', methods=['POST'])
def create_ticket():
    data = request.json
    last_ticket_id = Ticket.query.order_by(Ticket.id.desc()).first()
    next_id = 1 if not last_ticket_id else last_ticket_id.id + 1
    ticket_key = f"MY-{next_id}" 

    # ✨ 새 티켓은 맨 아래(가장 큰 index + 1)에 추가
    max_order = db.session.query(db.func.max(Ticket.order_index)).scalar() or 0

    new_ticket = Ticket(key=ticket_key, title=data['title'], order_index=max_order + 1)
    db.session.add(new_ticket)
    db.session.commit()
    
    notify_frontend(new_ticket.key, new_ticket.status)

    # 비동기 브랜치 검색
    thread = threading.Thread(target=check_existing_branch, args=(ticket_key,))
    thread.start()
    
    return jsonify(new_ticket.to_dict()), 201

@app.route('/api/tickets/<string:key>', methods=['PUT'])
def update_ticket(key):
    data = request.json
    ticket = Ticket.query.filter_by(key=key).first()
    if not ticket: return jsonify({"error": "Ticket not found"}), 404
        
    if 'status' in data: ticket.status = data['status']
    if 'content' in data: ticket.content = data['content']
    if 'title' in data: ticket.title = data['title']

    db.session.commit()
    notify_frontend(ticket.key, ticket.status)
    return jsonify(ticket.to_dict())

# 3. ✨ [신규] 배치 업데이트 API (순서 변경용)
@app.route('/api/tickets/batch', methods=['PUT'])
def update_tickets_batch():
    """
    프론트엔드에서 보낸 티켓 리스트(순서 포함)대로 DB를 싹 업데이트합니다.
    """
    tickets_data = request.json # [{key: 'MY-1', status: 'To Do', order_index: 0}, ...]

    changed_ticket_key = None # 알림용 (하나만 보냄)

    for item in tickets_data:
        ticket = Ticket.query.filter_by(key=item['key']).first()
        if ticket:
            # 상태나 순서가 바뀌었으면 업데이트
            if ticket.status != item['status'] or ticket.order_index != item['order_index']:
                ticket.status = item['status']
                ticket.order_index = item['order_index']
                changed_ticket_key = ticket.key # 변경된 놈 기억

    db.session.commit()

    # 변경 사항이 있으면 방송 (단순하게 '목록 갱신해라' 신호만 줘도 됨)
    if changed_ticket_key:
        notify_frontend(changed_ticket_key, "Batch Updated")

    return jsonify({"message": "Batch update success"})

@app.route('/stream')
def stream():
    def event_stream():
        messages = announcer.listen()
        yield format_sse('connected', event='ping')
        while True:
            msg = messages.get()
            yield msg
    return Response(stream_with_context(event_stream()), mimetype="text/event-stream", direct_passthrough=True)

# --- 6. GitHub 웹훅 핸들러 ---
def verify_signature(request):
    signature = request.headers.get('X-Hub-Signature-256')
    if not signature: return False
    sha_name, signature = signature.split('=')
    if sha_name != 'sha256': return False
    mac = hmac.new(WEBHOOK_SECRET.encode(), request.data, hashlib.sha256)
    return hmac.compare_digest(mac.hexdigest(), signature)

@app.route('/webhook', methods=['POST'])
def webhook_handler():
    if not verify_signature(request): abort(403, "Invalid signature")
    event_type = request.headers.get('X-GitHub-Event')
    payload = request.json

    if event_type == 'create' and payload.get('ref_type') == 'branch':
        handle_branch_creation(payload)
    elif event_type == 'pull_request' and payload['action'] in ['opened', 'edited']:
        handle_pull_request(payload)
    return "OK", 200

def handle_branch_creation(payload):
    branch_name = payload['ref']
    repo_html_url = payload['repository']['html_url']
    match = re.search(r'([A-Z]+-\d+)', branch_name)
    if match:
        ticket_key = match.group(1)
        with app.app_context():
            ticket = Ticket.query.filter_by(key=ticket_key).first()
            if ticket:
                # ticket.status = "In Progress"
                ticket.branch_url = f"{repo_html_url}/tree/{branch_name}"
                db.session.commit()
                notify_frontend(ticket_key, "In Progress")

def handle_pull_request(payload):
    pr = payload['pull_request']
    match = re.search(r'([A-Z]+-\d+)', pr['title'])
    if match:
        ticket_key = match.group(1)
        with app.app_context():
            ticket = Ticket.query.filter_by(key=ticket_key).first()
            if ticket:
                ticket.pr_url = pr['html_url']
                db.session.commit()
                notify_frontend(ticket_key, ticket.status)

if __name__ == '__main__':
    app.run(port=3000, debug=True, threaded=True)