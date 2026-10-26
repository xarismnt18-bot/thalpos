"""Start private loopback-only sleep service and show pairing key locally."""
import os
import secrets
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root))
from dotenv import load_dotenv

path = root/'sleep_sync.env'
if not path.exists():
    path.write_text('SLEEP_SYNC_TOKEN='+secrets.token_urlsafe(32)+'\n',encoding='utf-8')
load_dotenv(path)
print('Thalpos Sleep Sync — personal prototype')
print('Pairing key (enter only in your phone and local dashboard):')
print(os.environ['SLEEP_SYNC_TOKEN'])
print('The service stays on 127.0.0.1:8001. Use Tailscale Serve HTTPS; do not open router ports.')
import uvicorn
uvicorn.run('backend.wearable_api:configured_app',factory=True,host='127.0.0.1',port=8001,access_log=False)
