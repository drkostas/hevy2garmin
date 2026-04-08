"""Database layer for tracking synced workouts.

Auto-selects backend based on DATABASE_URL env var:
- If DATABASE_URL is set: PostgreSQL via psycopg2
- Otherwise: SQLite at ~/.hevy2garmin/sync.db

Module-level functions are backwards-compatible wrappers around the
singleton Database instance.
"""

from __future__ import annotations

import os
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from hevy2garmin.db_interface import Database

_instance: Database | None = None

# Vercel Neon integration sets env vars with a custom prefix (default: STORAGE).
# Check all common names so users don't have to change the prefix.
# Prefer pooled URLs (pgbouncer) for faster connections on serverless
_POSTGRES_URL_VARS = [
    "POSTGRES_URL",       # Neon pooled (pgbouncer) — fastest for serverless
    "DATABASE_URL",
    "STORAGE_URL",
    "NEON_DATABASE_URL",
]


def get_database_url() -> str | None:
    """Find a Postgres connection URL from common env var names."""
    for var in _POSTGRES_URL_VARS:
        url = os.environ.get(var)
        if url and ("postgres" in url or "neon" in url):
            return url
    return None


def get_db() -> Database:
    """Get or create the singleton Database instance."""
    global _instance
    if _instance is None:
        database_url = get_database_url()
        if database_url:
            from hevy2garmin.db_postgres import PostgresDatabase

            _instance = PostgresDatabase(database_url)
        else:
            from hevy2garmin.db_sqlite import SQLiteDatabase

            _instance = SQLiteDatabase()
    return _instance


def reset() -> None:
    """Clear the singleton so the next call to get_db() re-creates it."""
    global _instance
    _instance = None


# ── Backwards-compatible module-level wrappers ──────────────────────────────
# These accept **kw to silently swallow the old db_path= keyword argument.


def is_synced(hevy_id: str, **kw) -> bool:
    """Check if a Hevy workout has already been synced."""
    return get_db().is_synced(hevy_id)


def get_garmin_id(hevy_id: str, **kw) -> str | None:
    """Get the Garmin activity ID for a synced workout."""
    return get_db().get_garmin_id(hevy_id)


def mark_synced(
    hevy_id: str,
    garmin_activity_id: str | None = None,
    title: str = "",
    calories: int | None = None,
    avg_hr: int | None = None,
    **kw,
) -> None:
    """Record a successfully synced workout."""
    return get_db().mark_synced(hevy_id, garmin_activity_id, title, calories, avg_hr)


def unsync(hevy_id: str, **kw) -> bool:
    """Remove a sync record. Returns True if a record was deleted."""
    return get_db().unsync(hevy_id)


def unsync_all(**kw) -> int:
    """Remove all sync records. Returns count of deleted records."""
    return get_db().unsync_all()


def get_synced_count(**kw) -> int:
    """Get total number of synced workouts."""
    return get_db().get_synced_count()


def get_recent_synced(limit: int = 10, **kw) -> list[dict]:
    """Get recently synced workouts."""
    return get_db().get_recent_synced(limit)


def record_sync_log(
    synced: int = 0,
    skipped: int = 0,
    failed: int = 0,
    trigger: str = "manual",
    **kw,
) -> None:
    """Persist a sync run result."""
    return get_db().record_sync_log(synced, skipped, failed, trigger)


def get_sync_log(limit: int = 20, **kw) -> list[dict]:
    """Get recent sync log entries."""
    return get_db().get_sync_log(limit)


def get_cached_hr(hevy_id: str, **kw) -> dict | None:
    """Get cached HR data for a workout. Returns None if not cached."""
    return get_db().get_cached_hr(hevy_id)


def cache_hr(hevy_id: str, data: dict, **kw) -> None:
    """Cache HR data for a workout."""
    return get_db().cache_hr(hevy_id, data)
