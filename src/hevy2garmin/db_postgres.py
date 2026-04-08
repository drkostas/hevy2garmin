"""PostgreSQL implementation of the Database interface."""

from __future__ import annotations

import json

from hevy2garmin.db_interface import Database


class PostgresDatabase(Database):
    """Postgres-backed storage for tracking synced workouts."""

    def __init__(self, database_url: str) -> None:
        self.database_url = database_url
        self._conn_cache = None
        self._ensure_tables()

    def _get_conn(self):
        import psycopg2
        from psycopg2.extras import RealDictCursor

        # Reuse connection if still alive (avoids Neon cold-start per query)
        if self._conn_cache is not None:
            try:
                self._conn_cache.cursor().execute("SELECT 1")
                return self._conn_cache
            except Exception:
                try:
                    self._conn_cache.close()
                except Exception:
                    pass
                self._conn_cache = None

        conn = psycopg2.connect(self.database_url, cursor_factory=RealDictCursor)
        self._conn_cache = conn
        return conn

    def _ensure_tables(self) -> None:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS synced_workouts (
                        hevy_id TEXT PRIMARY KEY,
                        garmin_activity_id TEXT,
                        title TEXT,
                        synced_at TIMESTAMPTZ DEFAULT NOW(),
                        calories INTEGER,
                        avg_hr INTEGER,
                        status VARCHAR(20) DEFAULT 'success'
                    )
                """)
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS sync_log (
                        id BIGSERIAL PRIMARY KEY,
                        time TIMESTAMPTZ DEFAULT NOW(),
                        synced INTEGER DEFAULT 0,
                        skipped INTEGER DEFAULT 0,
                        failed INTEGER DEFAULT 0,
                        trigger VARCHAR(50) DEFAULT 'manual'
                    )
                """)
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS hr_cache (
                        hevy_id TEXT PRIMARY KEY,
                        data JSONB NOT NULL,
                        cached_at TIMESTAMPTZ DEFAULT NOW()
                    )
                """)
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS platform_credentials (
                        platform VARCHAR(50) PRIMARY KEY,
                        auth_type VARCHAR(20) NOT NULL DEFAULT 'oauth',
                        credentials JSONB NOT NULL DEFAULT '{}',
                        connected_at TIMESTAMPTZ,
                        expires_at TIMESTAMPTZ,
                        status VARCHAR(20) DEFAULT 'disconnected'
                    )
                """)
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS custom_mappings (
                        hevy_name TEXT PRIMARY KEY,
                        category INTEGER NOT NULL,
                        subcategory INTEGER NOT NULL DEFAULT 0
                    )
                """)
                # Migration: add hevy_updated_at if missing
                try:
                    cur.execute("ALTER TABLE synced_workouts ADD COLUMN hevy_updated_at TEXT")
                except Exception:
                    conn.rollback()
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS app_cache (
                        key TEXT PRIMARY KEY,
                        value JSONB NOT NULL,
                        updated_at TIMESTAMPTZ DEFAULT NOW()
                    )
                """)
            conn.commit()

    def is_synced(self, hevy_id: str) -> bool:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT 1 FROM synced_workouts WHERE hevy_id = %s", (hevy_id,))
                return cur.fetchone() is not None

    def get_synced_ids(self, hevy_ids: list[str]) -> dict[str, str | None]:
        """Batch check sync status. Returns {hevy_id: garmin_activity_id} for synced ones."""
        if not hevy_ids:
            return {}
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT hevy_id, garmin_activity_id FROM synced_workouts WHERE hevy_id = ANY(%s)",
                    (hevy_ids,)
                )
                return {r["hevy_id"]: r["garmin_activity_id"] for r in cur.fetchall()}

    def get_garmin_id(self, hevy_id: str) -> str | None:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT garmin_activity_id FROM synced_workouts WHERE hevy_id = %s",
                    (hevy_id,),
                )
                row = cur.fetchone()
                return row["garmin_activity_id"] if row else None

    def mark_synced(
        self,
        hevy_id: str,
        garmin_activity_id: str | None = None,
        title: str = "",
        calories: int | None = None,
        avg_hr: int | None = None,
        hevy_updated_at: str | None = None,
    ) -> None:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO synced_workouts (hevy_id, garmin_activity_id, title, calories, avg_hr, hevy_updated_at)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    ON CONFLICT (hevy_id) DO UPDATE SET
                        garmin_activity_id = EXCLUDED.garmin_activity_id,
                        title = EXCLUDED.title,
                        calories = EXCLUDED.calories,
                        avg_hr = EXCLUDED.avg_hr,
                        hevy_updated_at = EXCLUDED.hevy_updated_at,
                        synced_at = NOW()
                    """,
                    (hevy_id, garmin_activity_id, title, calories, avg_hr, hevy_updated_at),
                )
            conn.commit()

    def get_stale_synced(self, workouts: list[dict]) -> list[str]:
        """Return hevy_ids of synced workouts edited on Hevy since sync."""
        if not workouts:
            return []
        hevy_ids = [w.get("id", "") for w in workouts]
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT hevy_id, hevy_updated_at FROM synced_workouts WHERE hevy_id = ANY(%s) AND hevy_updated_at IS NOT NULL",
                    (hevy_ids,)
                )
                stored = {r["hevy_id"]: r["hevy_updated_at"] for r in cur.fetchall()}
        stale = []
        for w in workouts:
            wid = w.get("id", "")
            old_ts = stored.get(wid)
            new_ts = w.get("updated_at") or ""
            if old_ts and new_ts and new_ts > old_ts:
                stale.append(wid)
        return stale

    def unsync(self, hevy_id: str) -> bool:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM synced_workouts WHERE hevy_id = %s", (hevy_id,))
                deleted = cur.rowcount > 0
            conn.commit()
        return deleted

    def unsync_all(self) -> int:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM synced_workouts")
                count = cur.rowcount
            conn.commit()
        return count

    def get_synced_count(self) -> int:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT COUNT(*) AS cnt FROM synced_workouts")
                return cur.fetchone()["cnt"]

    def get_recent_synced(self, limit: int = 10) -> list[dict]:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT * FROM synced_workouts ORDER BY synced_at DESC LIMIT %s", (limit,)
                )
                return [dict(r) for r in cur.fetchall()]

    def record_sync_log(
        self,
        synced: int = 0,
        skipped: int = 0,
        failed: int = 0,
        trigger: str = "manual",
    ) -> None:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO sync_log (synced, skipped, failed, trigger) VALUES (%s, %s, %s, %s)",
                    (synced, skipped, failed, trigger),
                )
            conn.commit()

    def get_sync_log(self, limit: int = 20) -> list[dict]:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM sync_log ORDER BY id DESC LIMIT %s", (limit,))
                return [dict(r) for r in cur.fetchall()]

    def get_cached_hr(self, hevy_id: str) -> dict | None:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT data FROM hr_cache WHERE hevy_id = %s", (hevy_id,))
                row = cur.fetchone()
                if row:
                    data = row["data"]
                    return json.loads(data) if isinstance(data, str) else data
                return None

    def cache_hr(self, hevy_id: str, data: dict) -> None:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO hr_cache (hevy_id, data) VALUES (%s, %s)
                    ON CONFLICT (hevy_id) DO UPDATE SET data = EXCLUDED.data, cached_at = NOW()
                    """,
                    (hevy_id, json.dumps(data)),
                )
            conn.commit()

    # ── App config (settings, mappings) ────────────────────────────────────

    def get_app_config(self, key: str) -> dict | None:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT value FROM app_cache WHERE key = %s", (key,))
                row = cur.fetchone()
                if row:
                    v = row["value"]
                    return json.loads(v) if isinstance(v, str) else v
                return None

    def set_app_config(self, key: str, value: dict) -> None:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO app_cache (key, value) VALUES (%s, %s)
                    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
                    """,
                    (key, json.dumps(value)),
                )
            conn.commit()

    def get_custom_mappings(self) -> dict[str, tuple[int, int]]:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT hevy_name, category, subcategory FROM custom_mappings")
                return {r["hevy_name"]: (r["category"], r["subcategory"]) for r in cur.fetchall()}

    def save_custom_mapping(self, hevy_name: str, category: int, subcategory: int) -> None:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO custom_mappings (hevy_name, category, subcategory) VALUES (%s, %s, %s)
                    ON CONFLICT (hevy_name) DO UPDATE SET category = EXCLUDED.category, subcategory = EXCLUDED.subcategory
                    """,
                    (hevy_name, category, subcategory),
                )
            conn.commit()

    def delete_custom_mapping(self, hevy_name: str) -> None:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM custom_mappings WHERE hevy_name = %s", (hevy_name,))
            conn.commit()
