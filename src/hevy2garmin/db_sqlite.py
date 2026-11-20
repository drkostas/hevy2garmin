"""SQLite implementation of the Database interface."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from hevy2garmin._isotime import parse_iso
from hevy2garmin.db_interface import Database, NoWritableDatabaseError


def _ts_newer(new_ts: str, old_ts: str) -> bool:
    """Compare ISO timestamps safely (handles Z vs +00:00 differences)."""
    try:
        new_dt = parse_iso(new_ts)
        old_dt = parse_iso(old_ts)
        return new_dt > old_dt
    except (ValueError, TypeError):
        return new_ts > old_ts


DEFAULT_DB_PATH = Path("~/.hevy2garmin/sync.db").expanduser()


class SQLiteDatabase(Database):
    """SQLite-backed storage for tracking synced workouts."""

    def __init__(self, db_path: Path = DEFAULT_DB_PATH) -> None:
        self.db_path = Path(db_path)

    def _get_conn(self) -> sqlite3.Connection:
        try:
            self.db_path.parent.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            # Serverless (Vercel/Lambda) home is read-only — the cryptic
            # FileNotFoundError/OSError here is what users saw as a blank
            # dashboard / 500 on deploy (#145). Surface an actionable message.
            raise NoWritableDatabaseError(
                "Cannot create a local SQLite database under ~/.hevy2garmin on "
                "this read-only filesystem. Serverless deployments need Postgres: "
                "add a Neon database (Vercel → Storage) so DATABASE_URL / "
                "POSTGRES_URL is set, then redeploy."
            ) from e
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
        try:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS pending_uploads (
                hevy_id TEXT PRIMARY KEY,
                phase TEXT NOT NULL,
                next_step TEXT,
                upload_id TEXT,
                garmin_activity_id TEXT,
                watch_activity_id TEXT,
                pre_upload_ids TEXT NOT NULL DEFAULT '[]',
                payload TEXT NOT NULL DEFAULT '{}',
                resolution_source TEXT,
                attempt_count INTEGER NOT NULL DEFAULT 0,
                delete_attempt_count INTEGER NOT NULL DEFAULT 0,
                last_error TEXT,
                locked_until TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                )
            """)
        except sqlite3.OperationalError as exc:
            # A legacy database may intentionally be mounted read-only for
            # status/dashboard views. Reads remain backward compatible.
            if "readonly" not in str(exc).lower():
                raise
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
        except sqlite3.OperationalError:
            pass  # Column already exists
        # Migration: add sync_method column (merge mode)
        try:
            conn.execute("ALTER TABLE synced_workouts ADD COLUMN sync_method TEXT DEFAULT 'upload'")
        except sqlite3.OperationalError:
            pass  # Column already exists
        for column, definition in (
            ("resolution_reason", "TEXT"),
            ("resolved_at", "TEXT"),
            ("resolution_source", "TEXT"),
        ):
            try:
                conn.execute(f"ALTER TABLE synced_workouts ADD COLUMN {column} {definition}")
            except sqlite3.OperationalError:
                pass
        conn.execute("""
            CREATE TABLE IF NOT EXISTS app_cache (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT DEFAULT (datetime('now'))
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS synced_routines (
                hevy_routine_id TEXT PRIMARY KEY,
                garmin_workout_id TEXT,
                title TEXT,
                hevy_updated_at TEXT,
                scheduled_date TEXT,
                content_hash TEXT,
                synced_at TEXT DEFAULT (datetime('now')),
                status TEXT DEFAULT 'success'
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS routine_schedules (
                hevy_routine_id TEXT NOT NULL,
                schedule_id TEXT NOT NULL,
                scheduled_date TEXT,
                PRIMARY KEY (hevy_routine_id, schedule_id)
            )
        """)
        # Migration: add content_hash to routine tables created before it existed.
        try:
            conn.execute("ALTER TABLE synced_routines ADD COLUMN content_hash TEXT")
        except sqlite3.OperationalError:
            pass  # Column already exists
        conn.commit()
        return conn

    def is_synced(self, hevy_id: str) -> bool:
        conn = self._get_conn()
        row = conn.execute("SELECT 1 FROM synced_workouts WHERE hevy_id = ?", (hevy_id,)).fetchone()
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

    def known_garmin_activity_ids(self, exclude_hevy_id: str | None = None) -> set[str]:
        conn = self._get_conn()
        rows = conn.execute(
            "SELECT garmin_activity_id, hevy_id FROM synced_workouts "
            "WHERE garmin_activity_id IS NOT NULL "
            "UNION "
            "SELECT garmin_activity_id, hevy_id FROM pending_uploads "
            "WHERE garmin_activity_id IS NOT NULL"
        ).fetchall()
        conn.close()
        return {
            str(gid)
            for gid, hid in rows
            if gid is not None and (exclude_hevy_id is None or str(hid) != str(exclude_hevy_id))
        }

    # ── Routine → Garmin planned-workout tracking ───────────────────────────
    def get_synced_routine(self, hevy_routine_id: str) -> dict | None:
        conn = self._get_conn()
        row = conn.execute(
            "SELECT hevy_routine_id, garmin_workout_id, title, hevy_updated_at, "
            "scheduled_date, content_hash, synced_at, status FROM synced_routines "
            "WHERE hevy_routine_id = ?",
            (hevy_routine_id,),
        ).fetchone()
        conn.close()
        if row is None:
            return None
        keys = (
            "hevy_routine_id",
            "garmin_workout_id",
            "title",
            "hevy_updated_at",
            "scheduled_date",
            "content_hash",
            "synced_at",
            "status",
        )
        return dict(zip(keys, row))

    def list_synced_routines(self) -> list[dict]:
        conn = self._get_conn()
        rows = conn.execute(
            "SELECT hevy_routine_id, garmin_workout_id, title, hevy_updated_at, "
            "scheduled_date, content_hash, synced_at, status FROM synced_routines"
        ).fetchall()
        conn.close()
        keys = (
            "hevy_routine_id",
            "garmin_workout_id",
            "title",
            "hevy_updated_at",
            "scheduled_date",
            "content_hash",
            "synced_at",
            "status",
        )
        return [dict(zip(keys, row)) for row in rows]

    def set_routine_status(self, hevy_routine_id: str, status: str) -> None:
        conn = self._get_conn()
        conn.execute(
            "UPDATE synced_routines SET status = ? WHERE hevy_routine_id = ?",
            (status, hevy_routine_id),
        )
        conn.commit()
        conn.close()

    def is_routine_synced(self, hevy_routine_id: str, hevy_updated_at: str | None = None) -> bool:
        record = self.get_synced_routine(hevy_routine_id)
        if record is None:
            return False
        if hevy_updated_at and record.get("hevy_updated_at"):
            # Edited on Hevy since last sync → treat as not synced (re-create).
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
        conn = self._get_conn()
        conn.execute(
            """
            INSERT INTO synced_routines
                (hevy_routine_id, garmin_workout_id, title, hevy_updated_at, scheduled_date, content_hash, status)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(hevy_routine_id) DO UPDATE SET
                garmin_workout_id = excluded.garmin_workout_id,
                title = excluded.title,
                hevy_updated_at = excluded.hevy_updated_at,
                scheduled_date = excluded.scheduled_date,
                content_hash = excluded.content_hash,
                synced_at = datetime('now'),
                status = excluded.status
            """,
            (
                hevy_routine_id,
                garmin_workout_id,
                title,
                hevy_updated_at,
                scheduled_date,
                content_hash,
                status,
            ),
        )
        conn.commit()
        conn.close()

    def delete_synced_routine(self, hevy_routine_id: str) -> bool:
        conn = self._get_conn()
        cur = conn.execute(
            "DELETE FROM synced_routines WHERE hevy_routine_id = ?", (hevy_routine_id,)
        )
        deleted = cur.rowcount > 0
        conn.execute("DELETE FROM routine_schedules WHERE hevy_routine_id = ?", (hevy_routine_id,))
        conn.commit()
        conn.close()
        return deleted

    def add_routine_schedule(
        self, hevy_routine_id: str, schedule_id: str, scheduled_date: str | None = None
    ) -> None:
        conn = self._get_conn()
        conn.execute(
            "INSERT INTO routine_schedules (hevy_routine_id, schedule_id, scheduled_date) "
            "VALUES (?, ?, ?) ON CONFLICT(hevy_routine_id, schedule_id) DO NOTHING",
            (hevy_routine_id, str(schedule_id), scheduled_date),
        )
        conn.commit()
        conn.close()

    def get_routine_schedule_ids(self, hevy_routine_id: str) -> list[str]:
        conn = self._get_conn()
        rows = conn.execute(
            "SELECT schedule_id FROM routine_schedules WHERE hevy_routine_id = ?",
            (hevy_routine_id,),
        ).fetchall()
        conn.close()
        return [r[0] for r in rows]

    def get_routine_scheduled_dates(self, hevy_routine_id: str) -> list[str]:
        conn = self._get_conn()
        rows = conn.execute(
            "SELECT DISTINCT scheduled_date FROM routine_schedules "
            "WHERE hevy_routine_id = ? AND scheduled_date IS NOT NULL "
            "ORDER BY scheduled_date ASC",
            (hevy_routine_id,),
        ).fetchall()
        conn.close()
        return [r[0] for r in rows]

    def clear_routine_schedules(self, hevy_routine_id: str) -> None:
        conn = self._get_conn()
        conn.execute("DELETE FROM routine_schedules WHERE hevy_routine_id = ?", (hevy_routine_id,))
        conn.commit()
        conn.close()

    def delete_routine_schedule(self, hevy_routine_id: str, schedule_id: str) -> bool:
        conn = self._get_conn()
        cur = conn.execute(
            "DELETE FROM routine_schedules WHERE hevy_routine_id = ? AND schedule_id = ?",
            (hevy_routine_id, str(schedule_id)),
        )
        deleted = cur.rowcount > 0
        conn.commit()
        conn.close()
        return deleted

    @staticmethod
    def _upcoming_from_where(on_or_after: str, title_query: str | None) -> tuple[str, list]:
        """Shared FROM/JOIN/WHERE for the upcoming-schedules get + count queries."""
        sql = (
            "FROM routine_schedules rs "
            "LEFT JOIN synced_routines sr ON rs.hevy_routine_id = sr.hevy_routine_id "
            "WHERE rs.scheduled_date >= ?"
        )
        params: list = [on_or_after]
        if title_query:
            sql += " AND LOWER(sr.title) LIKE '%' || LOWER(?) || '%'"
            params.append(title_query)
        return sql, params

    def get_upcoming_routine_schedules(
        self, on_or_after: str, limit: int, offset: int, title_query: str | None = None
    ) -> list[dict]:
        from_where, params = self._upcoming_from_where(on_or_after, title_query)
        sql = (
            "SELECT rs.hevy_routine_id, rs.schedule_id, rs.scheduled_date, sr.title "
            + from_where
            + " ORDER BY rs.scheduled_date ASC, sr.title ASC LIMIT ? OFFSET ?"
        )
        conn = self._get_conn()
        rows = conn.execute(sql, params + [limit, offset]).fetchall()
        conn.close()
        keys = ("hevy_routine_id", "schedule_id", "scheduled_date", "title")
        return [dict(zip(keys, r)) for r in rows]

    def count_upcoming_routine_schedules(
        self, on_or_after: str, title_query: str | None = None
    ) -> int:
        from_where, params = self._upcoming_from_where(on_or_after, title_query)
        conn = self._get_conn()
        row = conn.execute("SELECT COUNT(*) " + from_where, params).fetchone()
        conn.close()
        return row[0] or 0

    def get_routine_stats(self) -> dict:
        conn = self._get_conn()
        row = conn.execute("SELECT COUNT(*), COUNT(scheduled_date) FROM synced_routines").fetchone()
        conn.close()
        return {"synced": row[0] or 0, "scheduled": row[1] or 0}

    def get_recent_synced_routines(self, limit: int = 5) -> list[dict]:
        conn = self._get_conn()
        rows = conn.execute(
            "SELECT hevy_routine_id, title, scheduled_date, garmin_workout_id, synced_at "
            "FROM synced_routines ORDER BY synced_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
        conn.close()
        keys = ("hevy_routine_id", "title", "scheduled_date", "garmin_workout_id", "synced_at")
        return [dict(zip(keys, r)) for r in rows]

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
        conn = self._get_conn()
        conn.execute(
            """
            INSERT INTO synced_workouts (hevy_id, garmin_activity_id, title, calories, avg_hr, hevy_updated_at, sync_method, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'success')
            ON CONFLICT(hevy_id) DO UPDATE SET
                garmin_activity_id=excluded.garmin_activity_id,
                title=excluded.title, calories=excluded.calories,
                avg_hr=excluded.avg_hr, hevy_updated_at=excluded.hevy_updated_at,
                sync_method=excluded.sync_method, status='success',
                synced_at=datetime('now')
            """,
            (hevy_id, garmin_activity_id, title, calories, avg_hr, hevy_updated_at, sync_method),
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
        rows = conn.execute("SELECT * FROM sync_log ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        conn.close()
        return [dict(r) for r in rows]

    def get_cached_hr(self, hevy_id: str) -> dict | None:
        conn = self._get_conn()
        row = conn.execute("SELECT data FROM hr_cache WHERE hevy_id = ?", (hevy_id,)).fetchone()
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
        row = conn.execute("SELECT value FROM app_cache WHERE key = ?", (key,)).fetchone()
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

    def claim_pending(self, hevy_id: str, payload: dict) -> bool:
        conn = self._get_conn()
        cur = conn.execute(
            "INSERT OR IGNORE INTO pending_uploads (hevy_id, phase, payload) VALUES (?, 'preparing', ?)",
            (hevy_id, json.dumps(payload)),
        )
        claimed = cur.rowcount == 1
        conn.commit()
        conn.close()
        return claimed

    @staticmethod
    def _pending_dict(row: sqlite3.Row) -> dict:
        result = dict(row)
        result["pre_upload_ids"] = json.loads(result.get("pre_upload_ids") or "[]")
        result["payload"] = json.loads(result.get("payload") or "{}")
        return result

    def get_pending(self, hevy_id: str) -> dict | None:
        conn = self._get_conn()
        conn.row_factory = sqlite3.Row
        row = conn.execute("SELECT * FROM pending_uploads WHERE hevy_id=?", (hevy_id,)).fetchone()
        conn.close()
        return self._pending_dict(row) if row else None

    def list_pending(self) -> list[dict]:
        conn = self._get_conn()
        conn.row_factory = sqlite3.Row
        rows = conn.execute("SELECT * FROM pending_uploads ORDER BY created_at DESC").fetchall()
        conn.close()
        return [self._pending_dict(row) for row in rows]

    def update_pending(self, hevy_id: str, **changes) -> None:
        allowed = {
            "phase",
            "next_step",
            "upload_id",
            "garmin_activity_id",
            "watch_activity_id",
            "pre_upload_ids",
            "payload",
            "resolution_source",
            "attempt_count",
            "delete_attempt_count",
            "last_error",
            "locked_until",
        }
        changes = {k: v for k, v in changes.items() if k in allowed}
        if not changes:
            return
        for key in ("pre_upload_ids", "payload"):
            if key in changes:
                changes[key] = json.dumps(changes[key])
        assignments = ", ".join(f"{key}=?" for key in changes)
        conn = self._get_conn()
        conn.execute(
            f"UPDATE pending_uploads SET {assignments}, updated_at=datetime('now') WHERE hevy_id=?",
            (*changes.values(), hevy_id),
        )
        conn.commit()
        conn.close()

    def delete_pending(self, hevy_id: str) -> bool:
        conn = self._get_conn()
        cur = conn.execute("DELETE FROM pending_uploads WHERE hevy_id=?", (hevy_id,))
        conn.commit()
        conn.close()
        return cur.rowcount > 0

    def complete_pending(self, hevy_id: str, terminal: dict) -> None:
        conn = self._get_conn()
        conn.execute(
            """
            INSERT INTO synced_workouts
              (hevy_id, garmin_activity_id, title, calories, avg_hr, hevy_updated_at, sync_method, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'success')
            ON CONFLICT(hevy_id) DO UPDATE SET
              garmin_activity_id=excluded.garmin_activity_id, title=excluded.title,
              calories=excluded.calories, avg_hr=excluded.avg_hr,
              hevy_updated_at=excluded.hevy_updated_at, sync_method=excluded.sync_method,
              status='success', synced_at=datetime('now')
        """,
            (
                hevy_id,
                terminal.get("garmin_activity_id"),
                terminal.get("title", ""),
                terminal.get("calories"),
                terminal.get("avg_hr"),
                terminal.get("hevy_updated_at"),
                terminal.get("sync_method", "upload"),
            ),
        )
        conn.execute("DELETE FROM pending_uploads WHERE hevy_id=?", (hevy_id,))
        conn.commit()
        conn.close()

    def resolve_terminal(
        self,
        hevy_id: str,
        *,
        status: str,
        garmin_activity_id: str | None = None,
        reason: str | None = None,
        source: str | None = None,
    ) -> None:
        if status not in {"manual", "skipped"}:
            raise ValueError("manual resolution status must be manual or skipped")
        conn = self._get_conn()
        conn.execute(
            """
            INSERT INTO synced_workouts (hevy_id, garmin_activity_id, status, resolution_reason, resolved_at, resolution_source)
            VALUES (?, ?, ?, ?, datetime('now'), ?)
            ON CONFLICT(hevy_id) DO UPDATE SET garmin_activity_id=excluded.garmin_activity_id,
              status=excluded.status, resolution_reason=excluded.resolution_reason,
              resolved_at=datetime('now'), resolution_source=excluded.resolution_source,
              synced_at=datetime('now')
        """,
            (hevy_id, garmin_activity_id, status, reason, source),
        )
        conn.execute("DELETE FROM pending_uploads WHERE hevy_id=?", (hevy_id,))
        conn.commit()
        conn.close()

    def get_workout_states(self, hevy_ids: list[str]) -> dict[str, dict]:
        if not hevy_ids:
            return {}
        placeholders = ",".join("?" for _ in hevy_ids)
        conn = self._get_conn()
        conn.row_factory = sqlite3.Row
        terminal = conn.execute(
            f"SELECT hevy_id, status, garmin_activity_id, resolution_reason, resolution_source FROM synced_workouts WHERE hevy_id IN ({placeholders})",
            hevy_ids,
        ).fetchall()
        states = {
            row["hevy_id"]: {
                "kind": "terminal",
                "status": row["status"] or "success",
                "garmin_activity_id": row["garmin_activity_id"],
                "reason": row["resolution_reason"],
                "source": row["resolution_source"],
            }
            for row in terminal
        }
        try:
            pending = conn.execute(
                f"SELECT hevy_id, phase, next_step, last_error, attempt_count, delete_attempt_count, garmin_activity_id FROM pending_uploads WHERE hevy_id IN ({placeholders})",
                hevy_ids,
            ).fetchall()
        except sqlite3.OperationalError:
            pending = []
        conn.close()
        for row in pending:
            if row["hevy_id"] not in states:
                states[row["hevy_id"]] = {
                    "kind": "pending",
                    "status": row["phase"],
                    "next_step": row["next_step"],
                    "last_error": row["last_error"],
                    "attempt_count": row["attempt_count"],
                    "delete_attempt_count": row["delete_attempt_count"],
                    "garmin_activity_id": row["garmin_activity_id"],
                }
        return states

    def get_terminal_counts(self) -> dict[str, int]:
        conn = self._get_conn()
        rows = conn.execute(
            "SELECT COALESCE(status, 'success'), COUNT(*) FROM synced_workouts GROUP BY COALESCE(status, 'success')"
        ).fetchall()
        conn.close()
        raw = dict(rows)
        result = {
            "uploaded": raw.get("success", 0),
            "manual": raw.get("manual", 0),
            "skipped": raw.get("skipped", 0),
        }
        result["terminal"] = sum(result.values())
        return result
