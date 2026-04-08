"""SQLite implementation of the Database interface."""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime
from pathlib import Path

from hevy2garmin.db_interface import Database


def _ts_newer(new_ts: str, old_ts: str) -> bool:
    """Compare ISO timestamps safely (handles Z vs +00:00 differences)."""
    try:
        new_dt = datetime.fromisoformat(new_ts.replace("Z", "+00:00"))
        old_dt = datetime.fromisoformat(old_ts.replace("Z", "+00:00"))
        return new_dt > old_dt
    except (ValueError, TypeError):
        return new_ts > old_ts

DEFAULT_DB_PATH = Path("~/.hevy2garmin/sync.db").expanduser()


class SQLiteDatabase(Database):
    """SQLite-backed storage for tracking synced workouts."""

    def __init__(self, db_path: Path = DEFAULT_DB_PATH) -> None:
        self.db_path = Path(db_path)

    def _get_conn(self) -> sqlite3.Connection:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(self.db_path))
        conn.execute("""
            CREATE TABLE IF NOT EXISTS synced_workouts (
                hevy_id TEXT PRIMARY KEY,
                garmin_activity_id TEXT,
                title TEXT,
                synced_at TEXT DEFAULT (datetime('now')),
                calories INTEGER,
                avg_hr INTEGER,
                status TEXT DEFAULT 'success'
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS sync_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                time TEXT DEFAULT (datetime('now')),
                synced INTEGER DEFAULT 0,
                skipped INTEGER DEFAULT 0,
                failed INTEGER DEFAULT 0,
                trigger TEXT DEFAULT 'manual'
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS hr_cache (
                hevy_id TEXT PRIMARY KEY,
                data TEXT NOT NULL,
                cached_at TEXT DEFAULT (datetime('now'))
            )
        """)
        # Migration: add hevy_updated_at if missing
        try:
            conn.execute("ALTER TABLE synced_workouts ADD COLUMN hevy_updated_at TEXT")
        except Exception:
            pass  # Column already exists
        conn.execute("""
            CREATE TABLE IF NOT EXISTS app_cache (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT DEFAULT (datetime('now'))
            )
        """)
        conn.commit()
        return conn

    def is_synced(self, hevy_id: str) -> bool:
        conn = self._get_conn()
        row = conn.execute(
            "SELECT 1 FROM synced_workouts WHERE hevy_id = ?", (hevy_id,)
        ).fetchone()
        conn.close()
        return row is not None

    def get_garmin_id(self, hevy_id: str) -> str | None:
        conn = self._get_conn()
        row = conn.execute(
            "SELECT garmin_activity_id FROM synced_workouts WHERE hevy_id = ?",
            (hevy_id,),
        ).fetchone()
        conn.close()
        return row[0] if row else None

    def mark_synced(
        self,
        hevy_id: str,
        garmin_activity_id: str | None = None,
        title: str = "",
        calories: int | None = None,
        avg_hr: int | None = None,
        hevy_updated_at: str | None = None,
    ) -> None:
        conn = self._get_conn()
        conn.execute(
            """
            INSERT OR REPLACE INTO synced_workouts (hevy_id, garmin_activity_id, title, calories, avg_hr, hevy_updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (hevy_id, garmin_activity_id, title, calories, avg_hr, hevy_updated_at),
        )
        conn.commit()
        conn.close()

    def get_stale_synced(self, workouts: list[dict]) -> list[str]:
        """Return hevy_ids of synced workouts edited on Hevy since sync."""
        if not workouts:
            return []
        conn = self._get_conn()
        placeholders = ",".join("?" for _ in workouts)
        hevy_ids = [w.get("id", "") for w in workouts]
        rows = conn.execute(
            f"SELECT hevy_id, hevy_updated_at FROM synced_workouts WHERE hevy_id IN ({placeholders}) AND hevy_updated_at IS NOT NULL",
            hevy_ids,
        ).fetchall()
        conn.close()
        stored = {r[0]: r[1] for r in rows}
        stale = []
        for w in workouts:
            wid = w.get("id", "")
            old_ts = stored.get(wid)
            new_ts = w.get("updated_at") or ""
            if old_ts and new_ts and _ts_newer(new_ts, old_ts):
                stale.append(wid)
        return stale

    def unsync(self, hevy_id: str) -> bool:
        conn = self._get_conn()
        cur = conn.execute("DELETE FROM synced_workouts WHERE hevy_id = ?", (hevy_id,))
        deleted = cur.rowcount > 0
        conn.commit()
        conn.close()
        return deleted

    def unsync_all(self) -> int:
        conn = self._get_conn()
        cur = conn.execute("DELETE FROM synced_workouts")
        count = cur.rowcount
        conn.commit()
        conn.close()
        return count

    def get_synced_count(self) -> int:
        conn = self._get_conn()
        count = conn.execute("SELECT COUNT(*) FROM synced_workouts").fetchone()[0]
        conn.close()
        return count

    def get_recent_synced(self, limit: int = 10) -> list[dict]:
        conn = self._get_conn()
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT * FROM synced_workouts ORDER BY synced_at DESC LIMIT ?", (limit,)
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]

    def record_sync_log(
        self,
        synced: int = 0,
        skipped: int = 0,
        failed: int = 0,
        trigger: str = "manual",
    ) -> None:
        conn = self._get_conn()
        conn.execute(
            "INSERT INTO sync_log (synced, skipped, failed, trigger) VALUES (?, ?, ?, ?)",
            (synced, skipped, failed, trigger),
        )
        conn.commit()
        conn.close()

    def get_sync_log(self, limit: int = 20) -> list[dict]:
        conn = self._get_conn()
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT * FROM sync_log ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]

    def get_cached_hr(self, hevy_id: str) -> dict | None:
        conn = self._get_conn()
        row = conn.execute(
            "SELECT data FROM hr_cache WHERE hevy_id = ?", (hevy_id,)
        ).fetchone()
        conn.close()
        if row:
            return json.loads(row[0])
        return None

    def cache_hr(self, hevy_id: str, data: dict) -> None:
        conn = self._get_conn()
        conn.execute(
            "INSERT OR REPLACE INTO hr_cache (hevy_id, data) VALUES (?, ?)",
            (hevy_id, json.dumps(data)),
        )
        conn.commit()
        conn.close()

    def get_app_config(self, key: str) -> dict | None:
        conn = self._get_conn()
        row = conn.execute(
            "SELECT value FROM app_cache WHERE key = ?", (key,)
        ).fetchone()
        conn.close()
        if row:
            return json.loads(row[0])
        return None

    def set_app_config(self, key: str, value: dict) -> None:
        conn = self._get_conn()
        conn.execute(
            "INSERT OR REPLACE INTO app_cache (key, value, updated_at) VALUES (?, ?, datetime('now'))",
            (key, json.dumps(value)),
        )
        conn.commit()
        conn.close()
