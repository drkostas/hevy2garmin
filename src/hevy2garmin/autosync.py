"""The scheduled auto-sync loop: sleep, sync, repeat.

Takes the shared sync lock from :mod:`hevy2garmin.syncstate`, so a scheduled
sync can never overlap a manual or cron one.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

from fastapi.concurrency import run_in_threadpool

from hevy2garmin import db, syncstate
from hevy2garmin.config import load_config, save_config
from hevy2garmin.sync import sync

logger = logging.getLogger("hevy2garmin")

_autosync_task: asyncio.Task | None = None


def run_once() -> int | None:
    """Execute one scheduled sync.

    Returns the interval (minutes) to wait before the next run, or ``None`` when
    the loop should stop — auto-sync was turned off, or the Hevy key is invalid.
    Blocking on purpose: the caller runs it off the event loop.
    """
    config = load_config()
    auto_cfg = config.get("auto_sync", {})
    if not auto_cfg.get("enabled", False):
        return None

    interval = auto_cfg.get("interval_minutes", 30)

    if not syncstate.acquire_sync_lock():
        logger.info("Auto-sync: skipped — another sync is running")
        return interval

    logger.info("Auto-sync: running scheduled sync")
    hevy_auth_failed = False
    try:
        result = sync(limit=10, dry_run=False, record_log=False, respect_grace=True)
    except Exception as e:
        from hevy2garmin.hevy import HevyAuthError
        if isinstance(e, HevyAuthError):
            logger.error("Auto-sync: Hevy API key invalid — disabling auto-sync. %s", e)
            config["auto_sync"]["enabled"] = False
            save_config(config)
            # Also persist to DB (Vercel filesystem is read-only)
            if db.get_database_url():
                try:
                    import json as _json
                    _db = db.get_db()
                    if hasattr(_db, '_get_conn'):
                        with _db._get_conn() as conn:
                            with conn.cursor() as cur:
                                cur.execute("""
                                    INSERT INTO platform_credentials (platform, auth_type, credentials, status)
                                    VALUES ('auto_sync', 'config', %s, 'active')
                                    ON CONFLICT (platform) DO UPDATE SET credentials = EXCLUDED.credentials
                                """, (_json.dumps({"enabled": False, "interval_minutes": config.get("auto_sync", {}).get("interval_minutes", 120)}),))
                            conn.commit()
                except Exception:
                    pass
            hevy_auth_failed = True
        result = {"synced": 0, "skipped": 0, "failed": 1, "error": str(e)}
    finally:
        syncstate.release_sync_lock()

    if hevy_auth_failed:
        return None  # Stop the loop

    syncstate.mark_synced()
    syncstate.record_sync_log(result, trigger="auto")
    return interval


async def _loop(interval_minutes: int) -> None:
    """Sleep, sync, repeat until auto-sync is turned off or the task is cancelled.

    The interval is re-read from the config on every pass, so changing it takes
    effect from the next cycle without restarting the loop.
    """
    while True:
        await asyncio.sleep(interval_minutes * 60)
        next_interval = await run_in_threadpool(run_once)
        if next_interval is None:
            logger.info("Auto-sync: loop stopped")
            return
        interval_minutes = next_interval


def schedule(interval_minutes: int) -> None:
    """(Re)start the auto-sync loop. Requires a running event loop."""
    global _autosync_task
    stop()
    _autosync_task = asyncio.create_task(_loop(interval_minutes))


def stop() -> None:
    """Cancel the auto-sync loop if one is running."""
    global _autosync_task
    if _autosync_task is not None:
        _autosync_task.cancel()
        _autosync_task = None


def status() -> dict[str, Any]:
    """Build auto-sync status dict for templates."""
    config = load_config()
    auto_cfg = config.get("auto_sync", {})
    enabled = auto_cfg.get("enabled", False)
    interval = auto_cfg.get("interval_minutes", 30)

    # On cloud, read persisted state from DB (filesystem config doesn't persist)
    if db.get_database_url():
        try:
            import json as _json
            _db = db.get_db()
            if hasattr(_db, '_get_conn'):
                with _db._get_conn() as conn:
                    with conn.cursor() as cur:
                        cur.execute("SELECT credentials FROM platform_credentials WHERE platform = 'auto_sync' LIMIT 1")
                        row = cur.fetchone()
                        if row and row.get("credentials"):
                            creds = row["credentials"] if isinstance(row["credentials"], dict) else _json.loads(row["credentials"])
                            enabled = creds.get("enabled", False)
                            interval = creds.get("interval_minutes", 120)
        except Exception:
            pass

    status_dict: dict[str, Any] = {
        "enabled": enabled,
        "interval_minutes": interval,
        "last_sync": None,
        "next_sync": None,
    }

    last_sync_time = syncstate.get_last_sync_time()
    if last_sync_time:
        elapsed = datetime.now(timezone.utc) - last_sync_time
        minutes_ago = int(elapsed.total_seconds() / 60)
        if minutes_ago < 1:
            status_dict["last_sync"] = "just now"
        elif minutes_ago < 60:
            status_dict["last_sync"] = f"{minutes_ago} min ago"
        else:
            hours_ago = minutes_ago // 60
            status_dict["last_sync"] = f"{hours_ago}h {minutes_ago % 60}m ago"

        if enabled:
            remaining = interval - minutes_ago
            if remaining <= 0:
                status_dict["next_sync"] = "soon"
            elif remaining < 60:
                status_dict["next_sync"] = f"in {remaining} min"
            else:
                status_dict["next_sync"] = f"in {remaining // 60}h {remaining % 60}m"

    return status_dict
