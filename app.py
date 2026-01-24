import os
import re
import hmac
import hashlib
import json
import queue
from flask import Flask, request, jsonify, abort, Response, stream_with_context
from flask_sqlalchemy import SQLAlchemy
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

# --- 방송국 클래스 (MessageAnnouncer) ---
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
    status = db.Column(db.String(20), default="To Do")
    branch_url = db.Column(db.String(200))
    pr_url = db.Column(db.String(200))

    def to_dict(self):
        return {
            "key": self.key,
            "title": self.title,
            "status": self.status,
            "branch_url": self.branch_url,
            "pr_url": self.pr_url
        }

with app.app_context():
    db.create_all()

# --- 3. SSE 유틸리티 (수정됨 ✨) ---
def format_sse(data: str, event=None): # 리턴 타입 힌트 제거 (bytes 리턴함)
    msg = f'data: {data}\n\n'
    if event:
        msg = f'event: {event}\n{msg}'
    
    # [수정] Gunicorn 호환을 위해 반드시 바이트(bytes)로 인코딩해야 합니다!
    return msg.encode('utf-8')

def notify_frontend(ticket_key, status):
    data = json.dumps({'key': ticket_key, 'status': status})
    # format_sse가 이제 bytes를 리턴하므로 그대로 사용
    msg = format_sse(data, event="ticket_updated")
    announcer.announce(msg)
    print(f"📡 [SSE 방송] {ticket_key} 상태 변경 알림 전송")

# --- 4. API 엔드포인트 ---
@app.route('/api/tickets', methods=['GET'])
def get_tickets():
    tickets = Ticket.query.order_by(Ticket.id.desc()).all()
    return jsonify([t.to_dict() for t in tickets])

@app.route('/api/tickets', methods=['POST'])
def create_ticket():
    data = request.json
    last_ticket = Ticket.query.order_by(Ticket.id.desc()).first()
    next_id = 1 if not last_ticket else last_ticket.id + 1
    ticket_key = f"MY-{next_id}" 

    new_ticket = Ticket(key=ticket_key, title=data['title'])
    db.session.add(new_ticket)
    db.session.commit()
    
    # ✨ [추가된 부분] 티켓이 만들어지자마자 방송을 내보냅니다!
    print(f"📢 새 티켓 생성됨: {ticket_key}")
    notify_frontend(new_ticket.key, new_ticket.status)
    
    return jsonify(new_ticket.to_dict()), 201

@app.route('/stream')
def stream():
    def event_stream():
        messages = announcer.listen()
        
        # [수정] bytes로 변환된 데이터 전송
        yield format_sse('connected', event='ping')
        
        while True:
            msg = messages.get()
            yield msg # 이미 bytes 상태임

    return Response(stream_with_context(event_stream()), 
                    mimetype="text/event-stream",
                    direct_passthrough=True)

# --- 5. GitHub 웹훅 핸들러 ---
def verify_signature(request):
    signature = request.headers.get('X-Hub-Signature-256')
    if not signature: return False
    sha_name, signature = signature.split('=')
    if sha_name != 'sha256': return False
    mac = hmac.new(WEBHOOK_SECRET.encode(), request.data, hashlib.sha256)
    return hmac.compare_digest(mac.hexdigest(), signature)

@app.route('/webhook', methods=['POST'])
def webhook_handler():
    if not verify_signature(request):
        abort(403, "Invalid signature")

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
                ticket.status = "In Progress"
                ticket.branch_url = f"{repo_html_url}/tree/{branch_name}"
                db.session.commit()
                print(f"✅ [DB 업데이트] {ticket_key} -> 브랜치 연결됨")
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
                print(f"✅ [DB 업데이트] {ticket_key} -> PR 연결됨")
                notify_frontend(ticket_key, ticket.status)

if __name__ == '__main__':
    app.run(port=8000, debug=True, threaded=True)