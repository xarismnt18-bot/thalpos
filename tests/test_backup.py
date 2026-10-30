import datetime as dt
import sqlite3
import sys
import zipfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
from backup_data import run_backup  # noqa: E402


def _make_db(path: Path, rows: int) -> None:
    db = sqlite3.connect(path)
    db.execute("CREATE TABLE readings (ts REAL PRIMARY KEY, temperature REAL)")
    db.executemany("INSERT INTO readings VALUES (?, ?)", [(i, 20.0 + i) for i in range(rows)])
    db.commit()
    db.close()


def test_backup_contains_consistent_db_snapshots_and_settings(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    _make_db(data / "history.db", 50)
    _make_db(data / "wearable_sleep.db", 3)
    (data / "preferences.json").write_text('{"x": 1}', encoding="utf-8")

    target = run_backup(data, tmp_path / "backups", keep=8)

    with zipfile.ZipFile(target) as zf:
        assert set(zf.namelist()) == {"history.db", "wearable_sleep.db", "preferences.json"}
        zf.extract("history.db", tmp_path / "restored")
    restored = sqlite3.connect(tmp_path / "restored" / "history.db")
    assert restored.execute("SELECT COUNT(*) FROM readings").fetchone()[0] == 50
    restored.close()


def test_backup_works_while_the_backend_holds_the_db_open(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    _make_db(data / "history.db", 10)
    writer = sqlite3.connect(data / "history.db")
    writer.execute("INSERT INTO readings VALUES (100, 25.0)")  # uncommitted write in progress
    try:
        target = run_backup(data, tmp_path / "backups", keep=8)
    finally:
        writer.rollback()
        writer.close()
    assert "history.db" in zipfile.ZipFile(target).namelist()


def test_only_the_newest_backups_are_kept(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    _make_db(data / "history.db", 1)
    backups = tmp_path / "backups"
    start = dt.datetime(2026, 10, 1, 12, 0, 0)
    for week in range(5):
        run_backup(data, backups, keep=3, now=start + dt.timedelta(weeks=week))

    kept = sorted(p.name for p in backups.glob("*.zip"))
    assert kept == [
        "thalpos-backup-20261015-120000.zip",
        "thalpos-backup-20261022-120000.zip",
        "thalpos-backup-20261029-120000.zip",
    ]
    assert not list(backups.glob("*.part"))


def test_empty_data_folder_fails_instead_of_writing_an_empty_zip(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    with pytest.raises(RuntimeError):
        run_backup(data, tmp_path / "backups", keep=8)
    assert not list((tmp_path / "backups").iterdir())
