"""Tests for the dashboard login rate-limiter (per-IP + global backoff)."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from hevy2garmin.login_ratelimit import (
    lockout_remaining,
    record_failure,
    clear_failures,
    _PREFIX,
    _GLOBAL_KEY,
    _MAX_FAILS,
    _BASE_SECONDS,
    _MAX_SECONDS,
    _GLOBAL_MAX_FAILS,
    _WINDOW_SECONDS,
)


class FakeDB:
    """In-memory app_config store (same shape as tests/test_ratelimit.py)."""

    def __init__(self):
        self._c = {}

    def get_app_config(self, key):
        return self._c.get(key)

    def set_app_config(self, key, value):
        self._c[key] = value


def test_under_threshold_no_lockout():
    db = FakeDB()
    for _ in range(_MAX_FAILS - 1):  # 4 failures
        assert record_failure(db, "ip") == 0
    assert lockout_remaining(db, "ip") == 0


def test_lockout_after_threshold():
    db = FakeDB()
    secs = 0
    for _ in range(_MAX_FAILS):  # 5th failure trips it
        secs = record_failure(db, "ip")
    assert secs == _BASE_SECONDS
    assert lockout_remaining(db, "ip") > 0


def test_backoff_grows_and_caps():
    db = FakeDB()
    seqs = [record_failure(db, "ip") for _ in range(12)]
    assert seqs[_MAX_FAILS - 1] == _BASE_SECONDS       # first lockout = base
    assert seqs[_MAX_FAILS] == _BASE_SECONDS * 2        # next doubles
    assert seqs[-1] == _MAX_SECONDS                     # capped


def test_clear_on_success_resets():
    db = FakeDB()
    for _ in range(_MAX_FAILS):
        record_failure(db, "ip")
    assert lockout_remaining(db, "ip") > 0
    clear_failures(db, "ip")
    assert lockout_remaining(db, "ip") == 0
    # counter starts fresh: one failure is well below the threshold again
    assert record_failure(db, "ip") == 0


def test_expired_lockout_reports_zero():
    db = FakeDB()
    past = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    db.set_app_config(_PREFIX + "ip", {"fails": 9, "until": past, "ts": past})
    assert lockout_remaining(db, "ip") == 0


def test_window_resets_stale_counter():
    db = FakeDB()
    stale = (datetime.now(timezone.utc) - timedelta(seconds=_WINDOW_SECONDS + 30)).isoformat()
    db.set_app_config(_PREFIX + "ip", {"fails": _MAX_FAILS - 1, "until": None, "ts": stale})
    # last failure is older than the window → counter restarts at 1, no lockout
    assert record_failure(db, "ip") == 0
    assert db.get_app_config(_PREFIX + "ip")["fails"] == 1


def test_global_counter_trips_for_fresh_ip():
    db = FakeDB()
    for i in range(_GLOBAL_MAX_FAILS):  # each a different IP → per-IP never locks
        record_failure(db, f"ip-{i}")
    assert db.get_app_config(_GLOBAL_KEY)["until"] is not None
    # a brand-new IP is still throttled by the global soft lockout
    assert lockout_remaining(db, "brand-new") > 0


def test_storage_failure_never_raises():
    class BrokenDB:
        def get_app_config(self, key):
            raise RuntimeError("db down")

        def set_app_config(self, key, value):
            raise RuntimeError("db down")

    db = BrokenDB()
    # must not raise, and must never lock the admin out on a storage failure
    assert record_failure(db, "ip") == 0
    assert lockout_remaining(db, "ip") == 0
    clear_failures(db, "ip")
