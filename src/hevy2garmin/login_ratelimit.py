"""Dashboard login rate-limiting with exponential backoff.

Protects ``POST /login`` from brute-force guessing. Tracks failed attempts per
client IP (plus a global counter that blunts distributed guessing from many
spoofed IPs) and enforces a short lockout that backs off exponentially. State
lives in the ``app_config`` key-value store so it survives serverless restarts,
mirroring :mod:`hevy2garmin.ratelimit`.

Tuned for a single human admin: the legit admin knows the password, so 5 tries
is plenty and lockouts are minutes (not the hours of the Garmin limiter, which
guards a third-party account). Short caps avoid self-DoS if the admin fumbles.

All functions take a ``db`` (a Database exposing ``get_app_config`` /
``set_app_config``) and are **best-effort: a storage failure NEVER raises and
NEVER locks the admin out** — same guarantee as ``ratelimit.py``.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from hevy2garmin._isotime import parse_iso

logger = logging.getLogger("hevy2garmin")

_PREFIX = "login_fail:"
_GLOBAL_KEY = _PREFIX + "__global__"

_MAX_FAILS = 5             # per-IP failures before the first lockout
_BASE_SECONDS = 60        # first lockout: 1 minute
_MAX_SECONDS = 15 * 60    # cap per-IP lockout at 15 minutes
_GLOBAL_MAX_FAILS = 50    # aggregate failures (all IPs) before a soft global lockout
_GLOBAL_SECONDS = 15 * 60  # global soft lockout window
_WINDOW_SECONDS = 15 * 60  # counters reset if the last failure is older than this


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _remaining(db, key: str) -> int:
    """Seconds left in ``key``'s lockout, or 0. Best-effort → 0 on any error."""
    try:
        state = db.get_app_config(key)
    except Exception:
        return 0
    if not state or not state.get("until"):
        return 0
    try:
        until = parse_iso(state["until"])
    except Exception:
        return 0
    remaining = (until - _now()).total_seconds()
    return int(remaining) if remaining > 0 else 0


def _bump(db, key: str, max_fails: int, base: int, cap: int) -> int:
    """Record one failure against ``key`` with a rolling window and exponential
    backoff. Returns the resulting lockout length in seconds (0 if not locked)."""
    now = _now()
    try:
        state = db.get_app_config(key) or {}
    except Exception:
        state = {}

    fails = int(state.get("fails", 0))
    ts = state.get("ts")
    if ts:
        try:
            if (now - parse_iso(ts)).total_seconds() > _WINDOW_SECONDS:
                fails = 0  # rolling window elapsed since last failure → start over
        except Exception:
            pass
    fails += 1

    lock_secs = 0
    until_iso = None
    if fails >= max_fails:
        over = fails - max_fails  # 0 on the first lockout, grows on repeats
        lock_secs = min(base * (2 ** over), cap)
        until_iso = (now + timedelta(seconds=lock_secs)).isoformat()

    try:
        db.set_app_config(key, {"fails": fails, "until": until_iso, "ts": now.isoformat()})
    except Exception:
        logger.debug("could not persist login-failure state for %s", key, exc_info=True)
    return lock_secs


def lockout_remaining(db, client_key: str) -> int:
    """Seconds the given client must wait before another login attempt.

    The effective lockout is the longer of the per-IP and global windows.
    Best-effort → 0 on any error (never blocks the admin on a DB failure).
    """
    return max(_remaining(db, _PREFIX + client_key), _remaining(db, _GLOBAL_KEY))


def record_failure(db, client_key: str) -> int:
    """Record a failed login for ``client_key`` (and the global counter).

    Returns the per-IP lockout seconds that just applied (0 if not yet locked).
    Callers that want the effective wait should call :func:`lockout_remaining`
    afterwards, since the global counter may trip independently.
    """
    per_ip = _bump(db, _PREFIX + client_key, _MAX_FAILS, _BASE_SECONDS, _MAX_SECONDS)
    # Tradeoff: the global counter can, via a spoofed X-Forwarded-For, briefly lock
    # out the legit admin too (availability DoS). Acceptable for a single-admin tool
    # — it only delays login by minutes and never persists past the rolling window.
    _bump(db, _GLOBAL_KEY, _GLOBAL_MAX_FAILS, _GLOBAL_SECONDS, _GLOBAL_SECONDS)
    return per_ip


def clear_failures(db, client_key: str) -> None:
    """Reset the per-IP counter after a successful login (resets the backoff).

    The global counter is intentionally left as-is: one correct login from the
    admin should not wipe an in-progress distributed-attack signal.
    """
    try:
        db.set_app_config(_PREFIX + client_key, {"fails": 0, "until": None, "ts": None})
    except Exception:
        logger.debug("could not clear login failures for %s", client_key, exc_info=True)
