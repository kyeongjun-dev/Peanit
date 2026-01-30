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

# --- 2. DB 모델 수정 ---
class Project(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)   # 프로젝트 이름 (예: "쇼핑몰 구축")
    code = db.Column(db.String(10), unique=True, nullable=False) # 프로젝트 코드 (예: "SHOP")
    tickets = db.relationship('Ticket', backref='project', lazy=True)

    def to_dict(self):
        return {"id": self.id, "name": self.name, "code": self.code}

class Ticket(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    project_id = db.Column(db.Integer, db.ForeignKey('project.id'), nullable=False) # ✨ 소속 프로젝트 ID
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
            "order_index": self.order_index,
            "branch_url": self.branch_url,
            "pr_url": self.pr_url,
            "project_code": self.project.code # 프론트에서 색상 구분등에 쓸 수 있음
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
# ✨ [신규] 프로젝트 목록 조회 및 생성
@app.route('/api/projects', methods=['GET', 'POST'])
def manage_projects():
    if request.method == 'GET':
        projects = Project.query.all()
        return jsonify([p.to_dict() for p in projects])
    
    if request.method == 'POST':
        data = request.json
        # 코드는 대문자로 저장
        code = data['code'].upper()
        if Project.query.filter_by(code=code).first():
            return jsonify({"error": "이미 존재하는 프로젝트 코드입니다."}), 400
            
        new_project = Project(name=data['name'], code=code)
        db.session.add(new_project)
        db.session.commit()
        return jsonify(new_project.to_dict()), 201

# ✨ [수정] 티켓 목록 조회 (특정 프로젝트의 티켓만 가져오기)
@app.route('/api/tickets', methods=['GET'])
def get_tickets():
    project_id = request.args.get('projectId') # 쿼리 파라미터로 받음
    if not project_id:
        return jsonify([]) # 프로젝트 선택 안되면 빈 배열
    
    # 해당 프로젝트의 티켓만, 순서대로 조회
    tickets = Ticket.query.filter_by(project_id=project_id).order_by(Ticket.order_index.asc()).all()
    return jsonify([t.to_dict() for t in tickets])

# ✨ [수정] 티켓 생성 (프로젝트 코드 기반 키 생성)
@app.route('/api/tickets', methods=['POST'])
def create_ticket():
    data = request.json
    project_id = data.get('projectId')
    title = data.get('title')

    project = Project.query.get(project_id)
    if not project:
        return jsonify({"error": "Project not found"}), 404

    # 해당 프로젝트 내에서 가장 높은 번호 찾기 (키 생성을 위해)
    # 예: "ABC-1", "ABC-2" ... -> 현재 ABC 프로젝트에 몇 개 있는지 카운트
    ticket_count = Ticket.query.filter_by(project_id=project_id).count()
    next_num = ticket_count + 1
    ticket_key = f"{project.code}-{next_num}"

    # 해당 프로젝트 내에서의 순서(order_index) 계산
    max_order = db.session.query(db.func.max(Ticket.order_index))\
        .filter_by(project_id=project_id).scalar() or 0

    new_ticket = Ticket(
        project_id=project.id,
        key=ticket_key, 
        title=title, 
        order_index=max_order + 1
    )
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
    프론트엔드에서 보낸 티켓 리스트(순서 및 상태 포함)대로 DB를 싹 업데이트합니다.
    """
    tickets_data = request.json 
    print(f"📦 [배치 업데이트 요청] {len(tickets_data)}개 데이터 수신")

    changed_ticket_key = None 

    for item in tickets_data:
        ticket = Ticket.query.filter_by(key=item['key']).first()
        if ticket:
            ticket.status = item['status']
            ticket.order_index = item['order_index']
            
    try:
        db.session.commit()
        
        # ✨ [추가된 부분] 변경 사항이 저장되면 모든 브라우저에 '방송'을 합니다.
        # 프론트엔드가 'Batch Updated'라는 이벤트를 기다리고 있으므로, 그 이름으로 보냅니다.
        msg = format_sse(json.dumps({"message": "refresh_all"}), event="Batch Updated")
        announcer.announce(msg)
        
        print("✅ [DB 저장 및 알림 전송 완료]")
        return jsonify({"message": "Batch update success"})
        
    except Exception as e:
        db.session.rollback()
        print(f"❌ [DB 저장 실패] {e}")
        return jsonify({"error": str(e)}), 500

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