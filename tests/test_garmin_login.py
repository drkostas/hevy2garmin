"""Tests for the in-memory two-step Garmin login."""

from __future__ import annotations

import time
from unittest.mock import MagicMock, patch

import pytest
from garmin_auth.auth import NEEDS_MFA
from garminconnect import (
    GarminConnectAuthenticationError,
    GarminConnectConnectionError,
    GarminConnectTooManyRequestsError,
)

from hevy2garmin import garmin_login
from hevy2garmin.garmin_login import _PendingStore


@pytest.fixture(autouse=True)
def fresh_store():
    """Each test gets an empty pending store."""
    garmin_login._store = _PendingStore()
    yield


def _client(name="Jane Athlete"):
    c = MagicMock()
    c.display_name = name
    return c


def test_begin_clean_success():
    with patch("hevy2garmin.garmin_login.GarminAuth") as GA:
        GA.return_value.login.return_value = _client()
        out = garmin_login.begin("e@x.com", "pw")
    assert out == {"status": "success", "display_name": "Jane Athlete"}


def test_begin_needs_mfa_stores_session():
    with patch("hevy2garmin.garmin_login.GarminAuth") as GA:
        GA.return_value.login.return_value = NEEDS_MFA
        out = garmin_login.begin("e@x.com", "pw")
    assert out["status"] == "needs_mfa"
    assert out["session_id"]
    assert garmin_login._store.get(out["session_id"], 0.0) is not None


@pytest.mark.parametrize("exc,status", [
    (GarminConnectAuthenticationError("bad"), "invalid_credentials"),
    (GarminConnectTooManyRequestsError("429"), "rate_limited"),
    (GarminConnectConnectionError("down"), "error"),
])
def test_begin_exception_mapping(exc, status):
    with patch("hevy2garmin.garmin_login.GarminAuth") as GA:
        GA.return_value.login.side_effect = exc
        out = garmin_login.begin("e@x.com", "pw")
    assert out["status"] == status


def test_complete_success_evicts():
    auth = MagicMock()
    auth.resume_login.return_value = _client()
    sid = garmin_login._store.put(auth, time.time())  # stored "now"; complete() reads now+epsilon
    out = garmin_login.complete(sid, "123456")
    assert out == {"status": "success", "display_name": "Jane Athlete"}
    assert garmin_login._store.get(sid, 0.0) is None


def test_complete_unknown_session():
    assert garmin_login.complete("nope", "123456") == {"status": "session_expired"}


def test_complete_wrong_code_keeps_entry():
    auth = MagicMock()
    auth.resume_login.side_effect = GarminConnectAuthenticationError("bad code")
    sid = garmin_login._store.put(auth, time.time())  # stored "now"; complete() reads now+epsilon
    out = garmin_login.complete(sid, "000000")
    assert out["status"] == "mfa_failed"
    assert garmin_login._store.get(sid, 0.0) is not None  # retained for retry


def test_pending_store_ttl_eviction():
    store = _PendingStore(ttl=600)
    sid = store.put(MagicMock(), now=1000.0)
    assert store.get(sid, now=1500.0) is not None       # within TTL
    assert store.get(sid, now=1000.0 + 601) is None      # expired


def test_complete_empty_code_is_mfa_failed():
    auth = MagicMock()
    auth.resume_login.side_effect = ValueError("mfa_code must be a non-empty string")
    sid = garmin_login._store.put(auth, time.time())
    out = garmin_login.complete(sid, "")
    assert out["status"] == "mfa_failed"
    assert garmin_login._store.get(sid, 0.0) is not None  # retained for retry


class TestTokenStoreSelection:
    """begin() must write the store sync later reads from.

    get_client picks DBTokenStore when DATABASE_URL is set. If the direct
    login authenticated against the default file store instead, a Postgres
    self-host would save tokens to disk while sync read the database, and
    every sync would report "needs MFA" forever (#296 review).
    """

    def test_begin_uses_the_same_kwargs_as_get_client(self) -> None:
        from unittest.mock import MagicMock, patch

        import hevy2garmin.garmin_login as gl

        sentinel = {"email": "e@x.com", "password": "pw", "store": object(),
                    "token_dir": "/tmp/.garminconnect"}
        with patch("hevy2garmin.garmin.auth_kwargs", return_value=dict(sentinel)) as kw, \
             patch.object(gl, "GarminAuth") as auth_cls:
            auth_cls.return_value.login.return_value = MagicMock()
            gl.begin("e@x.com", "pw")

        kw.assert_called_once_with("e@x.com", "pw")
        passed = auth_cls.call_args.kwargs
        assert passed["store"] is sentinel["store"]
        assert passed["token_dir"] == "/tmp/.garminconnect"
        assert passed["return_on_mfa"] is True

    def test_auth_kwargs_matches_get_client_without_database_url(self) -> None:
        from unittest.mock import patch

        from hevy2garmin.garmin import auth_kwargs

        with patch("hevy2garmin.db.get_database_url", return_value=None):
            kwargs = auth_kwargs("e@x.com", "pw", token_dir="~/.garminconnect")
        assert "store" not in kwargs
        assert kwargs["token_dir"] == "~/.garminconnect"

    def test_auth_kwargs_selects_db_store_when_database_url_set(self) -> None:
        from unittest.mock import MagicMock, patch

        from hevy2garmin.garmin import auth_kwargs

        with patch("hevy2garmin.db.get_database_url", return_value="postgresql://x/y"), \
             patch("garmin_auth.storage.DBTokenStore", return_value=MagicMock()) as store:
            kwargs = auth_kwargs("e@x.com", "pw")
        store.assert_called_once_with("postgresql://x/y")
        assert "store" in kwargs
        assert kwargs["token_dir"] == "/tmp/.garminconnect"
