"""Private, opt-in sleep bridge. Run separately; never expose the main API.

One personal Health Connect source per snapshot; all routes require pairing.
No health payloads are logged or sent to MQTT/Telegram.
"""
import hashlib
import hmac
import os
import sqlite3
import threading
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Annotated, Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.staticfiles import StaticFiles
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, ValidationError, model_validator
from backend.sleep_quality import ASLEEP, DEFAULT_IDEAL, asleep_environment, night_scores

StageName = Literal['unknown', 'awake', 'sleeping', 'out_of_bed', 'awake_in_bed', 'light', 'deep', 'rem']


class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid')


class Stage(StrictModel):
    start: AwareDatetime
    end: AwareDatetime
    stage: StageName

    @model_validator(mode='after')
    def interval(self):
        if self.end <= self.start:
            raise ValueError('Stage end must follow start')
        return self


class Session(StrictModel):
    record_id: str = Field(min_length=1, max_length=200)
    modified: AwareDatetime
    start: AwareDatetime
    end: AwareDatetime
    stages: list[Stage] = Field(max_length=2000)

    @model_validator(mode='after')
    def valid_stages(self):
        if not 0 < (self.end - self.start).total_seconds() <= 86400:
            raise ValueError('Sleep session must be positive and at most 24 hours')
        previous = self.start
        for stage in sorted(self.stages, key=lambda x: x.start):
            if stage.start < previous or stage.end > self.end:
                raise ValueError('Stages overlap or fall outside the session')
            previous = stage.end
        self.stages.sort(key=lambda x: x.start)
        return self


class Snapshot(StrictModel):
    schema_version: Literal[1]
    source: str = Field(min_length=1, max_length=200)
    room: str = Field(min_length=1, max_length=80)
    range_start: AwareDatetime
    range_end: AwareDatetime
    sessions: list[Session] = Field(max_length=200)

    @model_validator(mode='after')
    def valid_snapshot(self):
        if not 0 < (self.range_end - self.range_start).total_seconds() <= 8 * 86400:
            raise ValueError('Snapshot window must be positive and at most 8 days')
        now = datetime.now(timezone.utc)
        if self.range_end.timestamp() > now.timestamp() + 300:
            raise ValueError('Snapshot is in the future')
        if self.range_start.timestamp() < now.timestamp() - 31 * 86400:
            raise ValueError('Snapshot is older than 31 days')
        if len({s.record_id for s in self.sessions}) != len(self.sessions):
            raise ValueError('Duplicate record IDs in snapshot')
        if sum(len(s.stages) for s in self.sessions) > 12000:
            raise ValueError('Too many stages')
        for session in self.sessions:
            if session.start >= self.range_end or session.end <= self.range_start:
                raise ValueError('Session does not overlap snapshot window')
            if session.end.timestamp() > now.timestamp() + 300:
                raise ValueError('Sleep session is in the future')
            if session.modified.timestamp() > now.timestamp() + 300:
                raise ValueError('Modification time is in the future')
        return self


class Rating(StrictModel):
    """How rested the user felt on waking, 1 (exhausted) to 5 (fully rested); null clears it."""
    room: str = Field(min_length=1, max_length=80)
    night: date
    rating: int | None = Field(default=None, ge=1, le=5)

    @model_validator(mode='after')
    def recent(self):
        today = datetime.now().date()
        if not today - timedelta(days=90) <= self.night <= today + timedelta(days=1):
            raise ValueError('Rating must be for a night in the last 90 days')
        return self


def night_key(end_ts):
    """The night is named by the local date the user woke up on."""
    return datetime.fromtimestamp(end_ts).date().isoformat()


class SleepStore:
    def __init__(self, path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(path), check_same_thread=False)
        self.lock = threading.Lock()
        with self.db:
            self.db.execute('CREATE TABLE IF NOT EXISTS sessions (source TEXT, record_id TEXT, room TEXT, '
                            'start REAL, end REAL, modified REAL, payload TEXT, PRIMARY KEY(source, record_id))')
            self.db.execute('CREATE TABLE IF NOT EXISTS sync_state (source TEXT PRIMARY KEY, synced REAL)')
            # Keyed by wake-up date, not record ID: Mi Fitness can re-issue a night under a new ID.
            self.db.execute('CREATE TABLE IF NOT EXISTS ratings (room TEXT, night TEXT, rating INTEGER, updated REAL, '
                            'PRIMARY KEY(room, night))')

    def sync(self, snapshot):
        """Reconcile a complete paginated snapshot, including removed source records."""
        source = snapshot.source
        with self.lock, self.db:
            existing = self.db.execute('SELECT record_id FROM sessions WHERE source=? AND start<? AND end>?',
                                      (source, snapshot.range_end.timestamp(), snapshot.range_start.timestamp())).fetchall()
            ids = {s.record_id for s in snapshot.sessions}
            removed = 0
            for (record_id,) in existing:
                if record_id not in ids:
                    self.db.execute('DELETE FROM sessions WHERE source=? AND record_id=?', (source, record_id))
                    removed += 1
            for s in snapshot.sessions:
                self.db.execute('INSERT INTO sessions VALUES (?,?,?,?,?,?,?) ON CONFLICT(source,record_id) '
                                'DO UPDATE SET room=excluded.room,start=excluded.start,end=excluded.end,'
                                'modified=excluded.modified,payload=excluded.payload WHERE excluded.modified>=sessions.modified',
                                (source, s.record_id, snapshot.room, s.start.timestamp(), s.end.timestamp(),
                                 s.modified.timestamp(), s.model_dump_json()))
            now = datetime.now(timezone.utc).timestamp()
            self.db.execute('INSERT OR REPLACE INTO sync_state VALUES (?,?)', (source, now))
            self.db.execute('DELETE FROM sessions WHERE end<?', (now - 90 * 86400,))
            self.db.execute('DELETE FROM ratings WHERE night<?', (night_key(now - 90 * 86400),))
        return {'received': len(ids), 'removed': removed, 'synced_at': now}

    def reports(self, history_path, room, days, target_hours=8.0, ideal=None):
        ideal=ideal or DEFAULT_IDEAL
        cutoff = datetime.now(timezone.utc).timestamp() - days * 86400
        with self.lock:
            records = self.db.execute('SELECT source,payload FROM sessions WHERE end>? AND room=?', (cutoff, room)).fetchall()
            ratings = dict(self.db.execute('SELECT night,rating FROM ratings WHERE room=?', (room,)).fetchall())
        sessions = [(source, Session.model_validate_json(payload)) for source, payload in records]
        # Keep every raw record, but never sum overlapping versions as separate nights.
        # Newest source revision wins; tie-break by longest interval then stable ID.
        sessions.sort(key=lambda item: (item[1].modified.timestamp(), (item[1].end-item[1].start).total_seconds(),
                                        item[0], item[1].record_id), reverse=True)
        selected, excluded = [], []
        for source, session in sessions:
            if any(session.start < other.end and session.end > other.start for _, other in selected):
                excluded.append(session)
            else:
                selected.append((source, session))
        reports = []
        for source, session in sorted(selected, key=lambda item: item[1].start, reverse=True):
            start, end = session.start.timestamp(), session.end.timestamp()
            rows = read_environment(history_path, room, start, end)
            totals = {}
            stages = []
            for stage in session.stages:
                a, b = stage.start.timestamp(), stage.end.timestamp()
                minutes = (b-a)/60
                totals[stage.stage] = totals.get(stage.stage, 0) + minutes
                samples = [row for row in rows if a <= row[0] < b] if stage.stage in ASLEEP else []
                stages.append({'start': a, 'end': b, 'stage': stage.stage,
                               'environment': environment_summary(samples, a, b)})
            environment,series,room_score=asleep_environment(rows,stages,ideal)
            index=night_scores(totals,(end-start)/60,environment,room_score,target_hours,ideal)
            asleep = sum(v for k,v in totals.items() if k in ('light','deep','rem','sleeping'))
            covered = sum(totals.values())
            night = night_key(end)
            reports.append({'id': hashlib.sha256(f'{source}:{session.record_id}'.encode()).hexdigest()[:24],
                            'source': source, 'room': room, 'start': start, 'end': end, 'stages': stages,
                            'night': night, 'rating': ratings.get(night),
                            'stage_minutes': {k: round(v,1) for k,v in totals.items()},
                            'asleep_minutes': round(asleep,1),
                            'unclassified_minutes': round(max(0,(end-start)/60-covered),1),
                            'awake_periods': sum(s.stage=='awake' and (i==0 or session.stages[i-1].stage!='awake'
                                              or session.stages[i-1].end < s.start) for i,s in enumerate(session.stages)),
                            'environment':environment, 'series':series,'quality_index':index,
                            'overlap_warning': any(s.start<session.end and s.end>session.start for s in excluded)})
        return {'sessions': reports, 'excluded_overlapping': len(excluded),
                'notice': 'Wearable estimates, not a medical assessment. Overlapping versions are excluded, not added.'}

    def rate(self, rating):
        with self.lock, self.db:
            if rating.rating is None:
                self.db.execute('DELETE FROM ratings WHERE room=? AND night=?', (rating.room, rating.night.isoformat()))
            else:
                self.db.execute('INSERT OR REPLACE INTO ratings VALUES (?,?,?,?)',
                                (rating.room, rating.night.isoformat(), rating.rating, datetime.now(timezone.utc).timestamp()))
        return {'night': rating.night.isoformat(), 'rating': rating.rating}

    def clear(self):
        with self.lock, self.db:
            self.db.execute('DELETE FROM ratings')
            self.db.execute('DELETE FROM sessions')
            self.db.execute('DELETE FROM sync_state')
        return {'deleted': True}


def read_environment(path, room, start, end):
    """Read-only access to existing telemetry; never invent missing samples."""
    if not Path(path).exists():
        return []
    try:
        with sqlite3.connect(Path(path).resolve().as_uri()+'?mode=ro', uri=True) as db:
            return db.execute('SELECT ts,temperature,humidity FROM readings WHERE room=? AND ts>=? AND ts<? ORDER BY ts',
                              (room,start,end)).fetchall()
    except sqlite3.OperationalError:
        return []


def environment_summary(rows, start, end):
    # 30 s sample cadence. Cap coverage to one sample per slot; gaps are not filled.
    slots = {int((row[0]-start)//30) for row in rows}
    return {'samples': len(rows), 'coverage': round(min(1,len(slots)*30/(end-start)),3),
            'temperature_avg': round(sum(r[1] for r in rows)/len(rows),2) if rows else None,
            'humidity_avg': round(sum(r[2] for r in rows)/len(rows),2) if rows else None}


def create_app(store, history_path, token, ui_dir=None):
    app = FastAPI(title='Thalpos private sleep bridge', docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware('http')
    async def private_responses(request, call_next):
        response = await call_next(request)
        response.headers['Cache-Control'] = 'no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        return response

    def paired(authorization: Annotated[str | None, Header()] = None):
        if not token or len(token) < 32:
            raise HTTPException(503, 'Sleep pairing has not been configured')
        value = authorization.removeprefix('Bearer ') if authorization and authorization.startswith('Bearer ') else ''
        if not hmac.compare_digest(value.encode(), token.encode()):
            raise HTTPException(401, 'Invalid sleep pairing key', headers={'WWW-Authenticate':'Bearer'})

    @app.get('/status', dependencies=[Depends(paired)])
    def status():
        return {'ready': True, 'schema_version': 1}

    @app.post('/sync', dependencies=[Depends(paired)])
    async def sync(request: Request):
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw)>2_000_000:
                raise HTTPException(413, 'Snapshot is too large')
        try:
            snapshot = Snapshot.model_validate_json(raw)
        except ValidationError:
            # Avoid reflecting sensitive raw health values in validation errors.
            raise HTTPException(422, 'Invalid sleep snapshot: check intervals, stages and date range') from None
        return store.sync(snapshot)

    @app.get('/sessions', dependencies=[Depends(paired)])
    def sessions(room: str = Query(min_length=1,max_length=80), days: int = Query(14,ge=1,le=90),
                 target_hours: float = Query(8,ge=4,le=12,allow_inf_nan=False)):
        return store.reports(history_path,room,days,target_hours)

    @app.put('/ratings', dependencies=[Depends(paired)])
    async def rate(request: Request):
        raw = await request.body()
        if len(raw) > 2000:
            raise HTTPException(413, 'Rating is too large')
        try:
            rating = Rating.model_validate_json(raw)
        except ValidationError:
            # Same rule as /sync: never echo submitted health values back.
            raise HTTPException(422, 'Invalid rating: use 1-5 (or null) for a night in the last 90 days') from None
        return store.rate(rating)

    @app.delete('/sessions', dependencies=[Depends(paired)])
    def delete():
        return store.clear()

    # Only static application assets are public within the private tailnet.
    # Every endpoint that reads or changes wearable data remains authenticated.
    if ui_dir and Path(ui_dir).is_dir():
        app.mount('/ui', StaticFiles(directory=str(ui_dir),html=True),name='sleep-ui')

    return app


def configured_app():
    from dotenv import load_dotenv
    root = Path(__file__).resolve().parents[1]
    load_dotenv(root/'sleep_sync.env', override=False)
    return create_app(SleepStore(root/'data/wearable_sleep.db'),
                      Path(os.getenv('SLEEP_HISTORY_DB',str(root/'data/history.db'))), os.getenv('SLEEP_SYNC_TOKEN',''),
                      os.getenv('SLEEP_UI_DIR'))
