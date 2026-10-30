"""
Backs up the Thalpos data (sensor history, sleep nights, settings) into one zip.

    python tools/backup_data.py

The SQLite databases are copied with SQLite's own backup API, so a backup taken
while the backend is writing is still a consistent snapshot. Every snapshot is
checked with PRAGMA integrity_check before it goes into the zip.

Settings (all optional, from the environment or .env):
    BACKUP_DIR   where the zips go (default: backups/ in the project folder).
                 Point it at a OneDrive/Google Drive folder to keep a copy off this disk.
    BACKUP_KEEP  how many zips to keep; older ones are deleted (default: 8)
"""
import datetime as dt
import os
import sqlite3
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DATABASES = ("history.db", "wearable_sleep.db")
PLAIN_FILES = ("preferences.json", "settings.json", "daily_stats.json", "alert_state.json")
PREFIX = "thalpos-backup-"


def _load_dotenv() -> None:
    env = ROOT / ".env"
    if not env.exists():
        return
    for line in env.read_text(encoding="utf-8").splitlines():
        key, sep, value = line.partition("=")
        if sep and not line.lstrip().startswith("#"):
            os.environ.setdefault(key.strip(), value.strip())


def _snapshot(source: Path, target: Path) -> None:
    src = sqlite3.connect(source)  # the backup API only reads from it
    dst = sqlite3.connect(target)
    try:
        src.backup(dst)
        result = dst.execute("PRAGMA integrity_check").fetchone()[0]
        if result != "ok":
            raise RuntimeError(f"{source.name}: integrity check failed ({result})")
    finally:
        dst.close()
        src.close()


def _prune(backup_dir: Path, keep: int) -> list[Path]:
    zips = sorted(backup_dir.glob(f"{PREFIX}*.zip"))
    removed = zips[:-keep] if keep > 0 else []
    for old in removed:
        old.unlink()
    return removed


def run_backup(data_dir: Path, backup_dir: Path, keep: int, now: dt.datetime | None = None) -> Path:
    now = now or dt.datetime.now()
    backup_dir.mkdir(parents=True, exist_ok=True)
    target = backup_dir / f"{PREFIX}{now:%Y%m%d-%H%M%S}.zip"
    partial = target.with_suffix(".zip.part")
    with tempfile.TemporaryDirectory() as tmp, zipfile.ZipFile(partial, "w", zipfile.ZIP_DEFLATED) as zf:
        for name in DATABASES:
            source = data_dir / name
            if source.exists():
                snapshot = Path(tmp) / name
                _snapshot(source, snapshot)
                zf.write(snapshot, name)
        for name in PLAIN_FILES:
            source = data_dir / name
            if source.exists():
                zf.write(source, name)
    if not zipfile.ZipFile(partial).namelist():
        partial.unlink()
        raise RuntimeError(f"nothing to back up in {data_dir}")
    partial.replace(target)  # a half-written zip never looks like a finished backup
    _prune(backup_dir, keep)
    return target


def main() -> int:
    _load_dotenv()
    backup_dir = Path(os.getenv("BACKUP_DIR") or ROOT / "backups")
    keep = int(os.getenv("BACKUP_KEEP", "8"))
    try:
        target = run_backup(DATA_DIR, backup_dir, keep)
    except Exception as exc:  # noqa: BLE001 - report any failure in the log and exit non-zero
        print(f"BACKUP FAILED: {exc}")
        return 1
    with zipfile.ZipFile(target) as zf:
        contents = ", ".join(zf.namelist())
    print(f"Backup OK: {target} ({target.stat().st_size // 1024} KB: {contents})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
