"""Configure local paths without printing the pairing secret."""
import argparse
import secrets
from pathlib import Path
from dotenv import dotenv_values

parser = argparse.ArgumentParser()
parser.add_argument('--history',required=True)
parser.add_argument('--ui',required=True)
args=parser.parse_args()
root=Path(__file__).resolve().parents[1]
path=root/'sleep_sync.env'
values=dotenv_values(path) if path.exists() else {}
token=values.get('SLEEP_SYNC_TOKEN') or secrets.token_urlsafe(32)
history=Path(args.history).resolve()
ui=Path(args.ui).resolve()
if not history.is_file() or not ui.is_dir():
    raise SystemExit('History file or UI directory was not found')
path.write_text(f'SLEEP_SYNC_TOKEN={token}\nSLEEP_HISTORY_DB="{history.as_posix()}"\nSLEEP_UI_DIR="{ui.as_posix()}"\n',encoding='utf-8')
print('Personal sleep configuration saved. Pairing key remains in sleep_sync.env.')
