"""Sync session state shared by the manual, cron and auto-sync paths.

The lock and the last-sync timestamp are process-wide on purpose: every sync
entry point — the Sync Now button, the Vercel cron endpoint, the routine routes
and the auto-sync loop — has to see the same lock, or two syncs run at once.

The mutable state is reached through the accessors below rather than imported
directly. ``from hevy2garmin.syncstate import _last_sync_time`` would copy the
*value* at import time, leaving the importer holding a snapshot that never
updates; the accessors keep a single canonical copy.
"""

from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timezone

from hevy2garmin import db

logger = logging.getLogger("hevy2garmin")

# Still a threading.Lock, not an asyncio one: it is shared with the manual and
# cron sync routes, and every acquire is non-blocking, so it never stalls the
# event loop. It also has to be released from the worker thread that runs the
# blocking sync.
_sync_executing = threading.Lock()  # Prevents concurrent sync execution
_sync_lock_acquired_at: float = 0  # time.time() when lock was acquired
_SYNC_LOCK_TIMEOUT = 300  # 5 minutes — force-release if exceeded
_last_sync_time: datetime | None = None


def acquire_sync_lock() -> bool:
    """Try to acquire the sync lock. Force-release if held too long (hung sync)."""
    global _sync_lock_acquired_at
    if _sync_executing.acquire(blocking=False):
        _sync_lock_acquired_at = time.time()
        return True
    # Check if the lock has been held too long (hung sync)
    if _sync_lock_acquired_at and (time.time() - _sync_lock_acquired_at) > _SYNC_LOCK_TIMEOUT:
        logger.warning("Sync lock held for >%ds — force-releasing (likely hung)", _SYNC_LOCK_TIMEOUT)
        try:
            _sync_executing.release()
        except RuntimeError:
            pass
        if _sync_executing.acquire(blocking=False):
            _sync_lock_acquired_at = time.time()
            return True
    return False


def release_sync_lock() -> None:
    """Release the sync lock.

    Raises ``RuntimeError`` if the lock is not held, same as releasing the lock
    directly — callers release from a ``finally`` that only runs after a
    successful acquire.
    """
    _sync_executing.release()


def mark_synced() -> None:
    """Stamp the completion time of a sync, for the auto-sync status display."""
    global _last_sync_time
    _last_sync_time = datetime.now(timezone.utc)


def get_last_sync_time() -> datetime | None:
    """When the last sync finished, or ``None`` if none has run in this process."""
    return _last_sync_time


def record_sync_log(result: dict, trigger: str = "manual") -> None:
    """Record a sync result to SQLite. Best-effort — never breaks a sync.

    Now that failure paths record too, this runs from inside exception
    handlers; a DB write raising there would replace a handled error with a
    500. The log is diagnostic, so losing a row is always the lesser loss.
    """
    try:
        db.record_sync_log(
            synced=result.get("synced", 0),
            skipped=result.get("skipped", 0),
            failed=result.get("failed", 0),
            trigger=trigger,
        )
    except Exception:
        logger.debug("sync_log record failed (trigger=%s)", trigger, exc_info=True)
