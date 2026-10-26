"""Create a local pairing key once. No health values are read or printed."""
from pathlib import Path
import secrets
from dotenv import dotenv_values

root=Path(__file__).resolve().parents[1]
path=root/'sleep_sync.env'
values=dotenv_values(path) if path.exists() else {}
if not values.get('SLEEP_SYNC_TOKEN'):
    with path.open('a',encoding='utf-8') as file:
        file.write('\nSLEEP_SYNC_TOKEN='+secrets.token_urlsafe(32)+'\n')
print('Pairing key is in sleep_sync.env. Do not upload this file.')
print('Restart Thalpos: the sleep bridge will start automatically with it.')
