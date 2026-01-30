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

# --- DB 모델 (1:N 구조로 변경) ---

class Project(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    code = db.Column(db.String(10), unique=True, nullable=False)
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

    # ✨ [신규] 1:N 관계 설정 (브랜치 여러 개, PR 여러 개)
    branches = db.relationship('Branch', backref='ticket', cascade="all, delete-orphan", lazy=True)
    pull_requests = db.relationship('PullRequest', backref='ticket', cascade="all, delete-orphan", lazy=True)

    def to_dict(self):
        return {
            "key": self.key,
            "title": self.title,
            "content": self.content,
            "status": self.status,
            "order_index": self.order_index,
            "project_code": self.project.code,
            # 리스트 형태로 변환해서 보냄
            "branches": [b.to_dict() for b in self.branches],
            "pull_requests": [pr.to_dict() for pr in self.pull_requests]
        }

# ✨ [신규] 브랜치 테이블
class Branch(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    ticket_id = db.Column(db.Integer, db.ForeignKey('ticket.id'), nullable=False)
    name = db.Column(db.String(200), nullable=False) # 브랜치명
    url = db.Column(db.String(200), nullable=False)

    def to_dict(self):
        return {"name": self.name, "url": self.url}

# ✨ [신규] PR 테이블
class PullRequest(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    ticket_id = db.Column(db.Integer, db.ForeignKey('ticket.id'), nullable=False)
    title = db.Column(db.String(200), nullable=False)
    url = db.Column(db.String(200), nullable=False)
    is_merged = db.Column(db.Boolean, default=False)
    state = db.Column(db.String(20)) # open, closed

    def to_dict(self):
        return {"title": self.title, "url": self.url, "is_merged": self.is_merged, "state": self.state}

with app.app_context():
    db.create_all()

# --- 유틸리티 ---
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

def get_github_token():
    payload = {'iat': int(time.time()), 'exp': int(time.time()) + (10 * 60), 'iss': GITHUB_APP_ID}
    encoded_jwt = jwt.encode(payload, GITHUB_PRIVATE_KEY, algorithm='RS256')
    headers = {'Authorization': f'Bearer {encoded_jwt}', 'Accept': 'application/vnd.github.v3+json'}
    resp = requests.get('https://api.github.com/app/installations', headers=headers)
    if resp.status_code != 200: return None
    installations = resp.json()
    if not installations: return None
    installation_id = installations[0]['id']
    token_url = f'https://api.github.com/app/installations/{installation_id}/access_tokens'
    resp = requests.post(token_url, headers=headers)
    return resp.json()['token']

def extract_ticket_key(text):
    if not text: return None
    match = re.search(r'\b([A-Z]+-\d+)\b', text)
    if match: return match.group(1)
    return None

# --- ✨ [핵심] 스캔 로직 수정 (중복 방지하며 추가) ---
def scan_github_for_ticket(ticket_key):
    print(f"🔍 [전체 스캔] {ticket_key} 탐색 중...")
    try:
        token = get_github_token()
        if not token: return
        headers = {"Authorization": f"token {token}", "Accept": "application/vnd.github.v3+json"}
        
        # 리포지토리 목록
        repo_resp = requests.get("https://api.github.com/installation/repositories?per_page=100", headers=headers)
        if repo_resp.status_code != 200: return
        
        for repo in repo_resp.json().get('repositories', []):
            repo_full_name = repo['full_name']
            repo_html_url = repo['html_url']
            
            # 1. 브랜치 검색
            branches_resp = requests.get(f"https://api.github.com/repos/{repo_full_name}/branches", headers=headers)
            if branches_resp.status_code == 200:
                for branch_data in branches_resp.json():
                    if extract_ticket_key(branch_data['name']) == ticket_key:
                        with app.app_context():
                            ticket = Ticket.query.filter_by(key=ticket_key).first()
                            if ticket:
                                # 중복 체크 후 추가
                                existing = Branch.query.filter_by(ticket_id=ticket.id, name=branch_data['name']).first()
                                if not existing:
                                    new_branch = Branch(ticket_id=ticket.id, name=branch_data['name'], url=f"{repo_html_url}/tree/{branch_data['name']}")
                                    db.session.add(new_branch)
                                    db.session.commit()
                                    notify_frontend(ticket_key)

            # 2. PR 검색
            prs_resp = requests.get(f"https://api.github.com/repos/{repo_full_name}/pulls?state=all&per_page=100", headers=headers)
            if prs_resp.status_code == 200:
                for pr_data in prs_resp.json():
                    key_title = extract_ticket_key(pr_data['title'])
                    key_branch = extract_ticket_key(pr_data['head']['ref'])
                    
                    if ticket_key in [key_title, key_branch]:
                        with app.app_context():
                            ticket = Ticket.query.filter_by(key=ticket_key).first()
                            if ticket:
                                # 중복 체크 (URL 기준)
                                existing_pr = PullRequest.query.filter_by(ticket_id=ticket.id, url=pr_data['html_url']).first()
                                is_merged = pr_data.get('merged_at') is not None
                                
                                if existing_pr:
                                    # 상태 업데이트
                                    existing_pr.state = pr_data['state']
                                    existing_pr.is_merged = is_merged
                                else:
                                    new_pr = PullRequest(
                                        ticket_id=ticket.id,
                                        title=pr_data['title'],
                                        url=pr_data['html_url'],
                                        state=pr_data['state'],
                                        is_merged=is_merged
                                    )
                                    db.session.add(new_pr)
                                
                                # 하나라도 머지되면 티켓 완료 처리 (옵션)
                                if is_merged: ticket.status = "Done"
                                db.session.commit()
                                notify_frontend(ticket_key)
    except Exception as e:
        print(f"⚠️ 스캔 에러: {e}")

# --- API 엔드포인트 ---
@app.route('/api/projects', methods=['GET', 'POST'])
def manage_projects():
    if request.method == 'GET':
        projects = Project.query.all()
        return jsonify([p.to_dict() for p in projects])
    if request.method == 'POST':
        data = request.json
        code = data['code'].upper()
        if Project.query.filter_by(code=code).first(): return jsonify({"error": "Duplicate Code"}), 400
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
    project = Project.query.get(project_id)
    if not project: return jsonify({"error": "Project not found"}), 404
    
    project.last_ticket_number += 1
    next_num = project.last_ticket_number
    ticket_key = f"{project.code}-{next_num}"
    
    max_order = db.session.query(func.max(Ticket.order_index)).filter_by(project_id=project_id).scalar() or 0
    new_ticket = Ticket(project_id=project.id, key=ticket_key, ticket_number=next_num, title=data.get('title'), order_index=max_order+1)
    
    db.session.add(new_ticket)
    db.session.commit()
    notify_frontend(new_ticket.key)
    threading.Thread(target=scan_github_for_ticket, args=(ticket_key,)).start()
    return jsonify(new_ticket.to_dict()), 201

@app.route('/api/tickets/<string:key>', methods=['PUT'])
def update_ticket(key):
    data = request.json
    ticket = Ticket.query.filter_by(key=key).first()
    if not ticket: return jsonify({"error": "Not found"}), 404
    if 'status' in data: ticket.status = data['status']
    if 'content' in data: ticket.content = data['content']
    if 'title' in data: ticket.title = data['title']
    db.session.commit()
    notify_frontend(ticket.key)
    return jsonify(ticket.to_dict())

@app.route('/api/tickets/<string:key>', methods=['DELETE'])
def delete_ticket(key):
    ticket = Ticket.query.filter_by(key=key).first()
    if not ticket: return jsonify({"error": "Not found"}), 404
    db.session.delete(ticket)
    db.session.commit()
    notify_frontend(key, "ticket_updated")
    return jsonify({"message": "Deleted"}), 200

@app.route('/api/tickets/batch', methods=['PUT'])
def update_tickets_batch():
    for item in request.json:
        ticket = Ticket.query.filter_by(key=item['key']).first()
        if ticket:
            ticket.status = item['status']
            ticket.order_index = item['order_index']
    db.session.commit()
    announcer.announce(format_sse(json.dumps({"message": "refresh"}), event="Batch Updated"))
    return jsonify({"message": "Batch success"})

@app.route('/api/tickets/<string:key>/scan', methods=['POST'])
def scan_ticket_manually(key):
    ticket = Ticket.query.filter_by(key=key).first()
    if not ticket: return jsonify({"error": "Not found"}), 404
    threading.Thread(target=scan_github_for_ticket, args=(key,)).start()
    return jsonify({"message": "Scanning"}), 202

@app.route('/stream')
def stream():
    def event_stream():
        messages = announcer.listen()
        yield format_sse('connected', event='ping')
        while True: yield messages.get()
    return Response(stream_with_context(event_stream()), mimetype="text/event-stream")

@app.route('/webhook', methods=['POST'])
def webhook_handler():
    signature = request.headers.get('X-Hub-Signature-256')
    if not signature: abort(403)
    sha, sig = signature.split('=')
    mac = hmac.new(WEBHOOK_SECRET.encode(), request.data, hashlib.sha256)
    if not hmac.compare_digest(mac.hexdigest(), sig): abort(403)

    event = request.headers.get('X-GitHub-Event')
    payload = request.json

    if event == 'create' and payload.get('ref_type') == 'branch':
        handle_branch_event(payload, 'create')
    elif event == 'delete' and payload.get('ref_type') == 'branch':
        handle_branch_event(payload, 'delete')
    elif event == 'pull_request':
        handle_pr_event(payload)
        
    return "OK", 200

# ✨ [수정] 핸들러들도 1:N 구조에 맞춰 수정
def handle_branch_event(payload, action):
    branch_name = payload['ref']
    ticket_key = extract_ticket_key(branch_name)
    if ticket_key:
        with app.app_context():
            ticket = Ticket.query.filter_by(key=ticket_key).first()
            if ticket:
                if action == 'create':
                    # 중복 방지
                    if not Branch.query.filter_by(ticket_id=ticket.id, name=branch_name).first():
                        new_branch = Branch(ticket_id=ticket.id, name=branch_name, url=f"{payload['repository']['html_url']}/tree/{branch_name}")
                        db.session.add(new_branch)
                        print(f"🔗 브랜치 추가: {branch_name}")
                elif action == 'delete':
                    # 해당 브랜치만 삭제
                    branch = Branch.query.filter_by(ticket_id=ticket.id, name=branch_name).first()
                    if branch:
                        db.session.delete(branch)
                        print(f"🗑️ 브랜치 삭제: {branch_name}")
                
                db.session.commit()
                notify_frontend(ticket_key)

def handle_pr_event(payload):
    pr = payload['pull_request']
    keys = set()
    k1 = extract_ticket_key(pr['title'])
    k2 = extract_ticket_key(pr['head']['ref'])
    if k1: keys.add(k1)
    if k2: keys.add(k2)
    
    for key in keys:
        with app.app_context():
            ticket = Ticket.query.filter_by(key=key).first()
            if ticket:
                existing_pr = PullRequest.query.filter_by(ticket_id=ticket.id, url=pr['html_url']).first()
                is_merged = pr.get('merged') is True
                
                if existing_pr:
                    existing_pr.state = pr['state']
                    existing_pr.is_merged = is_merged
                    existing_pr.title = pr['title']
                else:
                    new_pr = PullRequest(ticket_id=ticket.id, title=pr['title'], url=pr['html_url'], state=pr['state'], is_merged=is_merged)
                    db.session.add(new_pr)
                
                if is_merged: ticket.status = "Done"
                db.session.commit()
                notify_frontend(key)

if __name__ == '__main__':
    app.run(port=3000, debug=True, threaded=True)