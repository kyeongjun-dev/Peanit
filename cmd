source venv/bin/activate
pip install flask gunicorn requests pyjwt cryptography
gunicorn --workers 1 -k gevent --bind 0.0.0.0:3000 --timeout 10 --keep-alive 10 app:app --log-level debug
ngrok http 3000