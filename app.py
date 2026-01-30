import os
import re
import hmac
import hashlib
import json
import time
import jwt
import requests
import queue
import threading
from flask import Flask, request, jsonify, abort, Response, stream_with_context
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import func
from flask_cors import CORS
from dotenv import load_dotenv

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
class Project(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    code = db.Column(db.String(10), unique=True, nullable=False)
    
    # ✨ [신규] 마지막으로 발급된 티켓 번호를 프로젝트가 기억합니다.
    last_ticket_number = db.Column(db.Integer, default=0)
    
    tickets = db.relationship('Ticket', backref='project', lazy=True)

    def to_dict(self):
        return {"id": self.id, "name": self.name, "code": self.code}

class Ticket(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    project_id = db.Column(db.Integer, db.ForeignKey('project.id'), nullable=False)
    key = db.Column(db.String(20), unique=True, nullable=False)
    ticket_number = db.Column(db.Integer, nullable=False)
    
    title = db.Column(db.String(200), nullable=False)
    content = db.Column(db.Text, default="")
    status = db.Column(db.String(20), default="To Do")
    order_index = db.Column(db.Integer, default=0)
    
    branch_url = db.Column(db.String(200))
    pr_url = db.Column(db.String(200))
    is_merged = db.Column(db.Boolean, default=False)

    def to_dict(self):
        return {
            "key": self.key,
            "title": self.title,
            "content": self.content,
            "status": self.status,
            "order_index": self.order_index,
            "branch_url": self.branch_url,
            "pr_url": self.pr_url,
            "is_merged": self.is_merged,
            "project_code": self.project.code
        }

with app.app_context():
    db.create_all()

# --- 3. SSE 유틸리티 ---
def format_sse(data: str, event=None):
    msg = f'data: {data}\n\n'
    if event:
        msg = f'event: {event}\n{msg}'
    return msg.encode('utf-8')

def notify_frontend(data, event_type="ticket_updated"):
    if isinstance(data, dict):
        msg_body = json.dumps(data)
    else:
        msg_body = json.dumps({'key': data, 'action': 'reload'})
    msg = format_sse(msg_body, event=event_type)
    announcer.announce(msg)

# --- 4. GitHub API 유틸리티 ---
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

def extract_ticket_key(text):
    if not text: return None
    match = re.search(r'\b([A-Z]+-\d+)\b', text)
    if match:
        return match.group(1)
    return None

def scan_github_for_ticket(ticket_key):
    print(f"🔍 [전체 스캔 시작] {ticket_key} 관련 브랜치/PR 찾는 중...")
    try:
        token = get_github_token()
        if not token: return

        headers = {"Authorization": f"token {token}", "Accept": "application/vnd.github.v3+json"}
        repos_url = "https://api.github.com/installation/repositories?per_page=100"
        repo_resp = requests.get(repos_url, headers=headers)
        if repo_resp.status_code != 200: return
        
        repositories = repo_resp.json().get('repositories', [])

        for repo in repositories:
            repo_full_name = repo['full_name']
            repo_html_url = repo['html_url']
            
            # 1. 브랜치 검색
            branches_url = f"https://api.github.com/repos/{repo_full_name}/branches"
            branches_resp = requests.get(branches_url, headers=headers)
            if branches_resp.status_code == 200:
                for branch in branches_resp.json():
                    found_key = extract_ticket_key(branch['name'])
                    if found_key == ticket_key:
                        with app.app_context():
                            ticket = Ticket.query.filter_by(key=ticket_key).first()
                            if ticket and not ticket.branch_url and not ticket.is_merged:
                                ticket.branch_url = f"{repo_html_url}/tree/{branch['name']}"
                                db.session.commit()
                                print(f"🔗 [자동 연결] 브랜치 발견: {branch['name']}")
                                notify_frontend(ticket.key)

            # 2. PR 검색
            prs_url = f"https://api.github.com/repos/{repo_full_name}/pulls?state=all&per_page=100"
            prs_resp = requests.get(prs_url, headers=headers)
            if prs_resp.status_code == 200:
                for pr in prs_resp.json():
                    key_from_title = extract_ticket_key(pr['title'])
                    key_from_branch = extract_ticket_key(pr['head']['ref'])
                    
                    if ticket_key in [key_from_title, key_from_branch]:
                        with app.app_context():
                            ticket = Ticket.query.filter_by(key=ticket_key).first()
                            if ticket:
                                ticket.pr_url = pr['html_url']
                                if pr.get('merged_at'):
                                    ticket.is_merged = True
                                    ticket.status = "Done"
                                    ticket.branch_url = None
                                    print(f"✅ [자동 연결] 머지된 PR 발견: {pr['title']}")
                                else:
                                    print(f"🔗 [자동 연결] 진행중 PR 발견: {pr['title']}")
                                
                                db.session.commit()
                                notify_frontend(ticket.key)
                        break 
    except Exception as e:
        print(f"⚠️ GitHub 스캔 실패: {e}")

# --- 5. API 엔드포인트 ---

@app.route('/api/projects', methods=['GET', 'POST'])
def manage_projects():
    if request.method == 'GET':
        projects = Project.query.all()
        return jsonify([p.to_dict() for p in projects])
    
    if request.method == 'POST':
        data = request.json
        code = data['code'].upper()
        if Project.query.filter_by(code=code).first():
            return jsonify({"error": "이미 존재하는 프로젝트 코드입니다."}), 400
            
        new_project = Project(name=data['name'], code=code)
        db.session.add(new_project)
        db.session.commit()
        
        notify_frontend(new_project.code, "project_updated")
        
        return jsonify(new_project.to_dict()), 201

@app.route('/api/tickets', methods=['GET'])
def get_tickets():
    project_id = request.args.get('projectId')
    if not project_id: return jsonify([])
    tickets = Ticket.query.filter_by(project_id=project_id).order_by(Ticket.order_index.asc()).all()
    return jsonify([t.to_dict() for t in tickets])

@app.route('/api/tickets', methods=['POST'])
def create_ticket():
    data = request.json
    project_id = data.get('projectId')
    title = data.get('title')

    project = Project.query.get(project_id)
    if not project: return jsonify({"error": "Project not found"}), 404

    # ✨ [수정] 프로젝트 모델에 저장된 카운터를 증가시켜 사용 (번호 재사용 방지)
    project.last_ticket_number += 1
    next_num = project.last_ticket_number
    
    ticket_key = f"{project.code}-{next_num}"

    # 순서는 여전히 현재 티켓들 기준 맨 뒤로
    max_order = db.session.query(func.max(Ticket.order_index)).filter_by(project_id=project_id).scalar() or 0

    new_ticket = Ticket(
        project_id=project.id,
        key=ticket_key, 
        ticket_number=next_num,
        title=title, 
        order_index=max_order + 1
    )
    db.session.add(new_ticket)
    db.session.commit()
    
    notify_frontend(new_ticket.key)
    threading.Thread(target=scan_github_for_ticket, args=(ticket_key,)).start()
    
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
    notify_frontend(ticket.key)
    return jsonify(ticket.to_dict())

@app.route('/api/tickets/<string:key>', methods=['DELETE'])
def delete_ticket(key):
    ticket = Ticket.query.filter_by(key=key).first()
    if not ticket: return jsonify({"error": "Ticket not found"}), 404
    try:
        db.session.delete(ticket)
        db.session.commit()
        notify_frontend(key, "ticket_updated")
        return jsonify({"message": "Deleted successfully"}), 200
    except Exception as e:
        db.session.rollback()
        return jsonify({"error": str(e)}), 500

@app.route('/api/tickets/batch', methods=['PUT'])
def update_tickets_batch():
    tickets_data = request.json 
    for item in tickets_data:
        ticket = Ticket.query.filter_by(key=item['key']).first()
        if ticket:
            ticket.status = item['status']
            ticket.order_index = item['order_index']
    db.session.commit()
    msg = format_sse(json.dumps({"message": "refresh_all"}), event="Batch Updated")
    announcer.announce(msg)
    return jsonify({"message": "Batch update success"})

@app.route('/api/tickets/<string:key>/scan', methods=['POST'])
def scan_ticket_manually(key):
    ticket = Ticket.query.filter_by(key=key).first()
    if not ticket: return jsonify({"error": "Ticket not found"}), 404
    threading.Thread(target=scan_github_for_ticket, args=(key,)).start()
    return jsonify({"message": "Scanning started..."}), 202

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
    elif event_type == 'pull_request':
        handle_pull_request(payload)
    elif event_type == 'delete' and payload.get('ref_type') == 'branch':
        handle_branch_deletion(payload)
        
    return "OK", 200

def handle_branch_creation(payload):
    branch_name = payload['ref']
    repo_html_url = payload['repository']['html_url']
    ticket_key = extract_ticket_key(branch_name)
    if ticket_key:
        with app.app_context():
            ticket = Ticket.query.filter_by(key=ticket_key).first()
            if ticket:
                ticket.branch_url = f"{repo_html_url}/tree/{branch_name}"
                db.session.commit()
                notify_frontend(ticket_key)

def handle_branch_deletion(payload):
    branch_name = payload['ref']
    ticket_key = extract_ticket_key(branch_name)
    if ticket_key:
        with app.app_context():
            ticket = Ticket.query.filter_by(key=ticket_key).first()
            if ticket:
                print(f"🗑️ 브랜치 삭제됨 ({branch_name}) -> 티켓 연결 해제")
                ticket.branch_url = None
                db.session.commit()
                notify_frontend(ticket_key)

def handle_pull_request(payload):
    action = payload['action']
    pr = payload['pull_request']
    ticket_key = extract_ticket_key(pr['title'])
    if not ticket_key: ticket_key = extract_ticket_key(pr['head']['ref'])
        
    if ticket_key:
        with app.app_context():
            ticket = Ticket.query.filter_by(key=ticket_key).first()
            if ticket:
                ticket.pr_url = pr['html_url']
                if action == 'closed' and pr.get('merged') is True:
                    ticket.is_merged = True
                    ticket.status = "Done"
                    ticket.branch_url = None
                db.session.commit()
                notify_frontend(ticket_key)

if __name__ == '__main__':
    app.run(port=3000, debug=True, threaded=True)