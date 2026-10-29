"""Manual window declarations, shared across devices; never sensor readings."""
import sqlite3
import threading
import time

CONFIRM_AFTER_SEC = 2 * 3600


class WindowStateStore:
    def __init__(self, path):
        self.db = sqlite3.connect(str(path), check_same_thread=False)
        self.lock = threading.Lock()
        with self.db:
            self.db.execute('CREATE TABLE IF NOT EXISTS window_events '
                            '(id INTEGER PRIMARY KEY, room TEXT NOT NULL, at REAL NOT NULL, '
                            'is_open INTEGER NOT NULL, since REAL NOT NULL, action TEXT NOT NULL)')
            self.db.execute('CREATE INDEX IF NOT EXISTS window_room_time ON window_events(room,at)')

    def snapshot(self, room, hours=24, now=None):
        now = time.time() if now is None else now
        with self.lock:
            latest = self.db.execute('SELECT at,is_open,since FROM window_events WHERE room=? ORDER BY id DESC LIMIT 1', (room,)).fetchone()
            events = self.db.execute('SELECT id,at,is_open,action FROM window_events WHERE room=? AND at>=? ORDER BY id DESC LIMIT 1000',
                                     (room,now-hours*3600)).fetchall()
        return {'room':room, 'source':'manual', 'server_now':now, 'state':('open' if latest[1] else 'closed') if latest else 'unknown',
                'updated':latest[0] if latest else None, 'since':latest[2] if latest else None,
                'needs_confirmation':bool(latest and now-latest[0]>=CONFIRM_AFTER_SEC),
                'events':[{'id':i,'ts':t,'is_open':bool(o),'action':a} for i,t,o,a in reversed(events)]}

    def declare(self, room, is_open, now=None):
        now = time.time() if now is None else now
        with self.lock, self.db:
            previous = self.db.execute('SELECT is_open,since FROM window_events WHERE room=? ORDER BY id DESC LIMIT 1', (room,)).fetchone()
            same = previous is not None and bool(previous[0]) == is_open
            since = previous[1] if same else now
            self.db.execute('INSERT INTO window_events(room,at,is_open,since,action) VALUES (?,?,?,?,?)',
                            (room,now,int(is_open),since,'confirmed' if same else 'changed'))
            self.db.execute('DELETE FROM window_events WHERE at<?', (now-30*86400,))
        return self.snapshot(room,now=now)
