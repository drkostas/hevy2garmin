"""PostgreSQL implementation of the Database interface."""

from __future__ import annotations

import json
from datetime import datetime
from hevy2garmin._isotime import parse_iso

from hevy2garmin.db_interface import Database


def _ts_newer(new_ts: str, old_ts: str) -> bool:
    """Compare ISO timestamps safely (handles Z vs +00:00 differences)."""
    try:
        new_dt = parse_iso(new_ts)
        old_dt = parse_iso(old_ts)
        return new_dt > old_dt
    except (ValueError, TypeError):
        return new_ts > old_ts  # fallback to string comparison


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
                    CREATE TABLE IF NOT EXISTS pending_uploads (
                        hevy_id TEXT PRIMARY KEY,
                        phase TEXT NOT NULL,
                        next_step TEXT,
                        upload_id TEXT,
                        garmin_activity_id TEXT,
                        watch_activity_id TEXT,
                        pre_upload_ids JSONB NOT NULL DEFAULT '[]',
                        payload JSONB NOT NULL DEFAULT '{}',
                        resolution_source TEXT,
                        attempt_count INTEGER NOT NULL DEFAULT 0,
                        delete_attempt_count INTEGER NOT NULL DEFAULT 0,
                        last_error TEXT,
                        locked_until TIMESTAMPTZ,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
                cur.execute("ALTER TABLE synced_workouts ADD COLUMN IF NOT EXISTS hevy_updated_at TEXT")
                cur.execute("ALTER TABLE synced_workouts ADD COLUMN IF NOT EXISTS sync_method TEXT DEFAULT 'upload'")
                cur.execute("ALTER TABLE synced_workouts ADD COLUMN IF NOT EXISTS resolution_reason TEXT")
                cur.execute("ALTER TABLE synced_workouts ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ")
                cur.execute("ALTER TABLE synced_workouts ADD COLUMN IF NOT EXISTS resolution_source TEXT")
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS app_cache (
                        key TEXT PRIMARY KEY,
                        value JSONB NOT NULL,
                        updated_at TIMESTAMPTZ DEFAULT NOW()
                    )
                """)
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS synced_routines (
                        hevy_routine_id TEXT PRIMARY KEY,
                        garmin_workout_id TEXT,
                        title TEXT,
                        hevy_updated_at TEXT,
                        scheduled_date TEXT,
                        content_hash TEXT,
                        synced_at TIMESTAMPTZ DEFAULT NOW(),
                        status VARCHAR(20) DEFAULT 'success'
                    )
                """)
                cur.execute("ALTER TABLE synced_routines ADD COLUMN IF NOT EXISTS content_hash TEXT")
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS routine_schedules (
                        hevy_routine_id TEXT NOT NULL,
                        schedule_id TEXT NOT NULL,
                        scheduled_date TEXT,
                        PRIMARY KEY (hevy_routine_id, schedule_id)
                    )
                """)
            conn.commit()

    def is_synced(self, hevy_id: str) -> bool:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT 1 FROM synced_workouts WHERE hevy_id = %s", (hevy_id,))
                return cur.fetchone() is not None

    def get_garmin_id(self, hevy_id: str) -> str | None:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT garmin_activity_id FROM synced_workouts WHERE hevy_id = %s",
                    (hevy_id,),
                )
                row = cur.fetchone()
                return row["garmin_activity_id"] if row else None

    # ── Routine → Garmin planned-workout tracking ───────────────────────────
    def get_synced_routine(self, hevy_routine_id: str) -> dict | None:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT hevy_routine_id, garmin_workout_id, title, hevy_updated_at, "
                    "scheduled_date, content_hash, synced_at, status FROM synced_routines "
                    "WHERE hevy_routine_id = %s",
                    (hevy_routine_id,),
                )
                row = cur.fetchone()
                return dict(row) if row else None

    def list_synced_routines(self) -> list[dict]:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT hevy_routine_id, garmin_workout_id, title, hevy_updated_at, "
                    "scheduled_date, content_hash, synced_at, status FROM synced_routines"
                )
                return [dict(row) for row in cur.fetchall()]

    def set_routine_status(self, hevy_routine_id: str, status: str) -> None:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE synced_routines SET status = %s WHERE hevy_routine_id = %s",
                    (status, hevy_routine_id),
                )
            conn.commit()

    def is_routine_synced(self, hevy_routine_id: str, hevy_updated_at: str | None = None) -> bool:
        record = self.get_synced_routine(hevy_routine_id)
        if record is None:
            return False
        if hevy_updated_at and record.get("hevy_updated_at"):
            return not _ts_newer(hevy_updated_at, record["hevy_updated_at"])
        return True

    def mark_routine_synced(
        self,
        hevy_routine_id: str,
        garmin_workout_id: str | None = None,
        title: str = "",
        hevy_updated_at: str | None = None,
        scheduled_date: str | None = None,
        content_hash: str | None = None,
        status: str = "success",
    ) -> None:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO synced_routines
                        (hevy_routine_id, garmin_workout_id, title, hevy_updated_at, scheduled_date, content_hash, status)
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (hevy_routine_id) DO UPDATE SET
                        garmin_workout_id = EXCLUDED.garmin_workout_id,
                        title = EXCLUDED.title,
                        hevy_updated_at = EXCLUDED.hevy_updated_at,
                        scheduled_date = EXCLUDED.scheduled_date,
                        content_hash = EXCLUDED.content_hash,
                        synced_at = NOW(),
                        status = EXCLUDED.status
                    """,
                    (hevy_routine_id, garmin_workout_id, title, hevy_updated_at, scheduled_date, content_hash, status),
                )
            conn.commit()

    def delete_synced_routine(self, hevy_routine_id: str) -> bool:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM synced_routines WHERE hevy_routine_id = %s", (hevy_routine_id,)
                )
                deleted = cur.rowcount > 0
                cur.execute(
                    "DELETE FROM routine_schedules WHERE hevy_routine_id = %s", (hevy_routine_id,)
                )
            conn.commit()
            return deleted

    def add_routine_schedule(
        self, hevy_routine_id: str, schedule_id: str, scheduled_date: str | None = None
    ) -> None:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO routine_schedules (hevy_routine_id, schedule_id, scheduled_date) "
                    "VALUES (%s, %s, %s) ON CONFLICT (hevy_routine_id, schedule_id) DO NOTHING",
                    (hevy_routine_id, str(schedule_id), scheduled_date),
                )
            conn.commit()

    def get_routine_schedule_ids(self, hevy_routine_id: str) -> list[str]:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT schedule_id FROM routine_schedules WHERE hevy_routine_id = %s",
                    (hevy_routine_id,),
                )
                return [r["schedule_id"] for r in cur.fetchall()]

    def get_routine_scheduled_dates(self, hevy_routine_id: str) -> list[str]:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT DISTINCT scheduled_date FROM routine_schedules "
                    "WHERE hevy_routine_id = %s AND scheduled_date IS NOT NULL "
                    "ORDER BY scheduled_date ASC",
                    (hevy_routine_id,),
                )
                return [r["scheduled_date"] for r in cur.fetchall()]

    def clear_routine_schedules(self, hevy_routine_id: str) -> None:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM routine_schedules WHERE hevy_routine_id = %s", (hevy_routine_id,)
                )
            conn.commit()

    def delete_routine_schedule(self, hevy_routine_id: str, schedule_id: str) -> bool:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM routine_schedules WHERE hevy_routine_id = %s AND schedule_id = %s",
                    (hevy_routine_id, str(schedule_id)),
                )
                deleted = cur.rowcount > 0
            conn.commit()
            return deleted

    @staticmethod
    def _upcoming_from_where(on_or_after: str, title_query: str | None) -> tuple[str, list]:
        """Shared FROM/JOIN/WHERE for the upcoming-schedules get + count queries."""
        sql = (
            "FROM routine_schedules rs "
            "LEFT JOIN synced_routines sr ON rs.hevy_routine_id = sr.hevy_routine_id "
            "WHERE rs.scheduled_date >= %s"
        )
        params: list = [on_or_after]
        if title_query:
            # %% is an escaped literal % under psycopg2's parameter substitution.
            sql += " AND LOWER(sr.title) LIKE '%%' || LOWER(%s) || '%%'"
            params.append(title_query)
        return sql, params

    def get_upcoming_routine_schedules(
        self, on_or_after: str, limit: int, offset: int, title_query: str | None = None
    ) -> list[dict]:
        from_where, params = self._upcoming_from_where(on_or_after, title_query)
        sql = (
            "SELECT rs.hevy_routine_id, rs.schedule_id, rs.scheduled_date, sr.title "
            + from_where
            + " ORDER BY rs.scheduled_date ASC, sr.title ASC LIMIT %s OFFSET %s"
        )
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(sql, params + [limit, offset])
                return [dict(r) for r in cur.fetchall()]

    def count_upcoming_routine_schedules(
        self, on_or_after: str, title_query: str | None = None
    ) -> int:
        from_where, params = self._upcoming_from_where(on_or_after, title_query)
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT COUNT(*) AS n " + from_where, params)
                return cur.fetchone()["n"]

    def get_routine_stats(self) -> dict:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT COUNT(*) AS synced, COUNT(scheduled_date) AS scheduled FROM synced_routines"
                )
                row = cur.fetchone()
                return {"synced": row["synced"] or 0, "scheduled": row["scheduled"] or 0}

    def get_recent_synced_routines(self, limit: int = 5) -> list[dict]:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT hevy_routine_id, title, scheduled_date, garmin_workout_id, synced_at "
                    "FROM synced_routines ORDER BY synced_at DESC LIMIT %s",
                    (limit,),
                )
                return [dict(r) for r in cur.fetchall()]

    def mark_synced(
        self,
        hevy_id: str,
        garmin_activity_id: str | None = None,
        title: str = "",
        calories: int | None = None,
        avg_hr: int | None = None,
        hevy_updated_at: str | None = None,
        sync_method: str = "upload",
    ) -> None:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO synced_workouts (hevy_id, garmin_activity_id, title, calories, avg_hr, hevy_updated_at, sync_method)
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (hevy_id) DO UPDATE SET
                        garmin_activity_id = EXCLUDED.garmin_activity_id,
                        title = EXCLUDED.title,
                        calories = EXCLUDED.calories,
                        avg_hr = EXCLUDED.avg_hr,
                        hevy_updated_at = EXCLUDED.hevy_updated_at,
                        sync_method = EXCLUDED.sync_method,
                        status = 'success',
                        synced_at = NOW()
                    """,
                    (hevy_id, garmin_activity_id, title, calories, avg_hr, hevy_updated_at, sync_method),
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
            if old_ts and new_ts and _ts_newer(new_ts, old_ts):
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

    def claim_pending(self, hevy_id: str, payload: dict) -> bool:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO pending_uploads (hevy_id, phase, payload)
                    VALUES (%s, 'preparing', %s) ON CONFLICT (hevy_id) DO NOTHING
                """, (hevy_id, json.dumps(payload)))
                claimed = cur.rowcount == 1
            conn.commit()
        return claimed

    @staticmethod
    def _pending_dict(row) -> dict:
        result = dict(row)
        for key, empty in (("pre_upload_ids", []), ("payload", {})):
            if isinstance(result.get(key), str):
                result[key] = json.loads(result[key])
            elif result.get(key) is None:
                result[key] = empty
        return result

    def get_pending(self, hevy_id: str) -> dict | None:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM pending_uploads WHERE hevy_id=%s", (hevy_id,))
                row = cur.fetchone()
                return self._pending_dict(row) if row else None

    def list_pending(self) -> list[dict]:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM pending_uploads ORDER BY created_at DESC")
                return [self._pending_dict(row) for row in cur.fetchall()]

    def update_pending(self, hevy_id: str, **changes) -> None:
        allowed = {"phase", "next_step", "upload_id", "garmin_activity_id", "watch_activity_id", "pre_upload_ids", "payload", "resolution_source", "attempt_count", "delete_attempt_count", "last_error", "locked_until"}
        changes = {k: v for k, v in changes.items() if k in allowed}
        if not changes:
            return
        for key in ("pre_upload_ids", "payload"):
            if key in changes:
                changes[key] = json.dumps(changes[key])
        assignments = ", ".join(f"{key}=%s" for key in changes)
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(f"UPDATE pending_uploads SET {assignments}, updated_at=NOW() WHERE hevy_id=%s", (*changes.values(), hevy_id))
            conn.commit()

    def delete_pending(self, hevy_id: str) -> bool:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM pending_uploads WHERE hevy_id=%s", (hevy_id,)); deleted = cur.rowcount > 0
            conn.commit()
        return deleted

    def complete_pending(self, hevy_id: str, terminal: dict) -> None:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO synced_workouts
                      (hevy_id, garmin_activity_id, title, calories, avg_hr, hevy_updated_at, sync_method, status)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,'success')
                    ON CONFLICT (hevy_id) DO UPDATE SET garmin_activity_id=EXCLUDED.garmin_activity_id,
                      title=EXCLUDED.title, calories=EXCLUDED.calories, avg_hr=EXCLUDED.avg_hr,
                      hevy_updated_at=EXCLUDED.hevy_updated_at, sync_method=EXCLUDED.sync_method,
                      status='success', synced_at=NOW()
                """, (hevy_id, terminal.get("garmin_activity_id"), terminal.get("title", ""), terminal.get("calories"), terminal.get("avg_hr"), terminal.get("hevy_updated_at"), terminal.get("sync_method", "upload")))
                cur.execute("DELETE FROM pending_uploads WHERE hevy_id=%s", (hevy_id,))
            conn.commit()

    def resolve_terminal(self, hevy_id: str, *, status: str, garmin_activity_id: str | None = None, reason: str | None = None, source: str | None = None) -> None:
        if status not in {"manual", "skipped"}:
            raise ValueError("manual resolution status must be manual or skipped")
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO synced_workouts (hevy_id, garmin_activity_id, status, resolution_reason, resolved_at, resolution_source)
                    VALUES (%s,%s,%s,%s,NOW(),%s)
                    ON CONFLICT (hevy_id) DO UPDATE SET garmin_activity_id=EXCLUDED.garmin_activity_id,
                      status=EXCLUDED.status, resolution_reason=EXCLUDED.resolution_reason,
                      resolved_at=NOW(), resolution_source=EXCLUDED.resolution_source, synced_at=NOW()
                """, (hevy_id, garmin_activity_id, status, reason, source))
                cur.execute("DELETE FROM pending_uploads WHERE hevy_id=%s", (hevy_id,))
            conn.commit()

    def get_workout_states(self, hevy_ids: list[str]) -> dict[str, dict]:
        if not hevy_ids:
            return {}
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT hevy_id, status, garmin_activity_id, resolution_reason, resolution_source FROM synced_workouts WHERE hevy_id = ANY(%s)", (hevy_ids,))
                states = {
                    row["hevy_id"]: {
                        "kind": "terminal", "status": row["status"] or "success",
                        "garmin_activity_id": row["garmin_activity_id"],
                        "reason": row["resolution_reason"], "source": row["resolution_source"],
                    }
                    for row in cur.fetchall()
                }
                cur.execute("SELECT hevy_id, phase, next_step, last_error, attempt_count, delete_attempt_count, garmin_activity_id FROM pending_uploads WHERE hevy_id = ANY(%s)", (hevy_ids,))
                for row in cur.fetchall():
                    if row["hevy_id"] not in states:
                        states[row["hevy_id"]] = {
                            "kind": "pending", "status": row["phase"],
                            "next_step": row["next_step"], "last_error": row["last_error"],
                            "attempt_count": row["attempt_count"],
                            "delete_attempt_count": row["delete_attempt_count"],
                            "garmin_activity_id": row["garmin_activity_id"],
                        }
                return states

    def get_terminal_counts(self) -> dict[str, int]:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT COALESCE(status, 'success') AS status, COUNT(*) AS count FROM synced_workouts GROUP BY COALESCE(status, 'success')")
                raw = {row["status"]: row["count"] for row in cur.fetchall()}
        result = {"uploaded": raw.get("success", 0), "manual": raw.get("manual", 0), "skipped": raw.get("skipped", 0)}
        result["terminal"] = sum(result.values())
        return result

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
