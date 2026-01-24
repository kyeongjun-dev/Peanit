import os
import hmac
import hashlib
import time
import jwt
import requests
import re
from flask import Flask, request, jsonify, abort
from dotenv import load_dotenv

# 0. 환경 변수 로드 (경로 안전하게 지정)
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(BASE_DIR, ".env"))

app = Flask(__name__)

# 환경 변수 가져오기
GITHUB_APP_ID = os.getenv('GITHUB_APP_ID')
# 줄바꿈 처리 및 None 체크
raw_private_key = os.getenv('GITHUB_PRIVATE_KEY')
if raw_private_key:
    GITHUB_PRIVATE_KEY = raw_private_key.replace('\\n', '\n')
else:
    print("⚠️ 경고: GITHUB_PRIVATE_KEY가 .env 파일에 없습니다.")
    GITHUB_PRIVATE_KEY = None
    
WEBHOOK_SECRET = os.getenv('WEBHOOK_SECRET')

# 1. 웹훅 서명 검증 (보안 필수)
def verify_signature(request):
    signature = request.headers.get('X-Hub-Signature-256')
    if not signature:
        return False
    
    sha_name, signature = signature.split('=')
    if sha_name != 'sha256':
        return False
        
    mac = hmac.new(WEBHOOK_SECRET.encode(), request.data, hashlib.sha256)
    return hmac.compare_digest(mac.hexdigest(), signature)

# 2. GitHub App 인증 토큰 발급 (JWT -> Installation Token)
def get_installation_access_token(installation_id):
    payload = {
        'iat': int(time.time()),
        'exp': int(time.time()) + (10 * 60), # 10분 유효
        'iss': GITHUB_APP_ID
    }
    encoded_jwt = jwt.encode(payload, GITHUB_PRIVATE_KEY, algorithm='RS256')
    
    headers = {
        'Authorization': f'Bearer {encoded_jwt}',
        'Accept': 'application/vnd.github.v3+json'
    }
    url = f'https://api.github.com/app/installations/{installation_id}/access_tokens'
    response = requests.post(url, headers=headers)
    response.raise_for_status()
    
    return response.json()['token']

# 3. 메인 웹훅 라우트 (분기 처리)
@app.route('/webhook', methods=['POST'])
def webhook_handler():
    # 보안 검증
    if not verify_signature(request):
        abort(403, "Invalid signature")

    event_type = request.headers.get('X-GitHub-Event')
    payload = request.json
    
    print(f"📩 이벤트 수신: {event_type}")

    # Case A: PR이 열리거나 수정됨
    if event_type == 'pull_request' and payload['action'] in ['opened', 'edited']:
        handle_pull_request(payload)
    
    # Case B: 브랜치가 생성됨 (새로 추가된 부분 ✨)
    elif event_type == 'create' and payload.get('ref_type') == 'branch':
        handle_branch_creation(payload)

    return "OK", 200

# 4-1. 비즈니스 로직: PR 처리
def handle_pull_request(payload):
    pr = payload['pull_request']
    installation_id = payload['installation']['id']
    repo_full_name = payload['repository']['full_name']
    pr_number = pr['number']
    title = pr['title']
    body = pr['body'] or ""

    # 정규식: 대문자-숫자 패턴 (예: MY-101, FE-99)
    match = re.search(r'([A-Z]+-\d+)', title)
    
    if match:
        ticket_id = match.group(1)
        ticket_url = f"https://my-system.com/tickets/{ticket_id}"
        link_md = f"> 🔗 **티켓 연결:** [{ticket_id}]({ticket_url})"

        if ticket_url not in body:
            token = get_installation_access_token(installation_id)
            new_body = f"{link_md}\n\n{body}"
            api_url = f"https://api.github.com/repos/{repo_full_name}/pulls/{pr_number}"
            
            requests.patch(
                api_url,
                json={'body': new_body},
                headers={
                    'Authorization': f'token {token}',
                    'Accept': 'application/vnd.github.v3+json'
                }
            )
            print(f"✅ [PR 연결 완료] {title} -> {ticket_id}")

# 4-2. 비즈니스 로직: 브랜치 생성 처리 (새로 추가된 함수 ✨)
def handle_branch_creation(payload):
    branch_name = payload['ref']  # 예: feature/MY-101-login
    sender = payload['sender']['login']
    
    # 정규식: 대문자-숫자 패턴
    match = re.search(r'([A-Z]+-\d+)', branch_name)
    
    if match:
        ticket_id = match.group(1)
        print(f"✅ [브랜치 감지 성공] 티켓 번호: {ticket_id}")
        print(f"   - 브랜치명: {branch_name}")
        print(f"   - 생성자: {sender}")
        
        # TODO: 여기서 DB에 '이 티켓에 브랜치가 생겼음'을 저장하는 로직을 추가하면 됩니다.
        # 예: save_branch_info(ticket_id, branch_name)
        
    else:
        print(f"ℹ️ 브랜치 생성됨({branch_name}), 하지만 티켓 번호 없음.")

if __name__ == '__main__':
    app.run(port=3000)