"""SQLite storage: a candle cache (closed bars only) and paper-trading state."""

import json
import sqlite3
import threading
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "paper_trader.db"


class Store:
    def __init__(self, path: Path = DB_PATH) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._lock = threading.Lock()
        self._db.executescript("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS candles (
                source TEXT, coin TEXT, interval TEXT, time INTEGER,
                open REAL, high REAL, low REAL, close REAL, volume REAL,
                PRIMARY KEY (source, coin, interval, time)
            );
            -- Time ranges [start, end) that are fully present in `candles`.
            CREATE TABLE IF NOT EXISTS coverage (
                source TEXT, coin TEXT, interval TEXT, start INTEGER, end INTEGER
            );
            CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
        """)

    # ---- candle cache -------------------------------------------------------

    def is_covered(self, source: str, coin: str, interval: str, start: int, end: int) -> bool:
        with self._lock:
            row = self._db.execute(
                "SELECT 1 FROM coverage WHERE source=? AND coin=? AND interval=? AND start<=? AND end>=?",
                (source, coin, interval, start, end),
            ).fetchone()
        return row is not None

    def get_candles(self, source: str, coin: str, interval: str, start: int, end: int) -> list[dict]:
        with self._lock:
            rows = self._db.execute(
                "SELECT time, open, high, low, close, volume FROM candles "
                "WHERE source=? AND coin=? AND interval=? AND time>=? AND time<? ORDER BY time",
                (source, coin, interval, start, end),
            ).fetchall()
        keys = ("time", "open", "high", "low", "close", "volume")
        return [dict(zip(keys, r)) for r in rows]

    def put_candles(self, source: str, coin: str, interval: str, start: int, end: int,
                    candles: list[dict]) -> None:
        """Store candles and mark [start, end) as covered, merging overlapping ranges."""
        if end <= start:
            return
        with self._lock, self._db:
            self._db.executemany(
                "INSERT OR REPLACE INTO candles VALUES (?,?,?,?,?,?,?,?,?)",
                [(source, coin, interval, c["time"], c["open"], c["high"], c["low"],
                  c["close"], c["volume"]) for c in candles if start <= c["time"] < end],
            )
            key = (source, coin, interval)
            overlapping = self._db.execute(
                "SELECT rowid, start, end FROM coverage "
                "WHERE source=? AND coin=? AND interval=? AND start<=? AND end>=?",
                (*key, end, start),
            ).fetchall()
            new_start = min([start] + [r[1] for r in overlapping])
            new_end = max([end] + [r[2] for r in overlapping])
            self._db.executemany("DELETE FROM coverage WHERE rowid=?", [(r[0],) for r in overlapping])
            self._db.execute("INSERT INTO coverage VALUES (?,?,?,?,?)", (*key, new_start, new_end))

    # ---- key/value (paper trading state) ------------------------------------

    def get_json(self, key: str):
        with self._lock:
            row = self._db.execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else None

    def put_json(self, key: str, value) -> None:
        with self._lock, self._db:
            self._db.execute("INSERT OR REPLACE INTO kv VALUES (?,?)", (key, json.dumps(value)))
