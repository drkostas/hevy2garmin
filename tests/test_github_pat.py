"""Tests for the in-app GitHub PAT (issue #445).

The GitHub token used to be a required Vercel environment variable. It can now
be entered on the Settings page and stored in the DB (platform 'github'), so a
fresh cloud deploy needs no hand-typed env vars. These tests cover the read
helper (DB-over-env precedence), the persistence helper, and the auto-sync
guard that refuses to enable without a token instead of failing silently.
"""

from __future__ import annotations

import os
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from hevy2garmin import server as srv
from hevy2garmin.config import get_github_pat
from hevy2garmin.server import _save_github_pat


class _FakeCursor:
    def __init__(self, fetchone_row=None):
        self._row = fetchone_row
        self.executed: list = []

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, params=None):
        self.executed.append((sql, params))

    def fetchone(self):
        return self._row


class _FakeConn:
    def __init__(self, cursor):
        self._cursor = cursor
        self.committed = False

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def cursor(self):
        return self._cursor

    def commit(self):
        self.committed = True


class _FakeDB:
    def __init__(self, cursor):
        self._conn = _FakeConn(cursor)

    def _get_conn(self):
        return self._conn


class TestGetGithubPat:
    def test_env_only_when_no_db(self, monkeypatch):
        monkeypatch.setenv("GITHUB_PAT", "ghp_env")
        with patch("hevy2garmin.db.get_database_url", return_value=None):
            assert get_github_pat() == "ghp_env"

    def test_none_when_neither(self, monkeypatch):
        monkeypatch.delenv("GITHUB_PAT", raising=False)
        with patch("hevy2garmin.db.get_database_url", return_value=None):
            assert get_github_pat() is None

    def test_strips_whitespace_from_env(self, monkeypatch):
        monkeypatch.setenv("GITHUB_PAT", "  ghp_env\n")
        with patch("hevy2garmin.db.get_database_url", return_value=None):
            assert get_github_pat() == "ghp_env"

    def test_db_takes_precedence_over_env(self, monkeypatch):
        monkeypatch.setenv("GITHUB_PAT", "ghp_env")
        cur = _FakeCursor(fetchone_row={"credentials": {"pat": "ghp_db"}})
        with patch("hevy2garmin.db.get_database_url", return_value="postgresql://x"), \
             patch("hevy2garmin.db.get_db", return_value=_FakeDB(cur)):
            assert get_github_pat() == "ghp_db"

    def test_falls_back_to_env_when_no_db_row(self, monkeypatch):
        monkeypatch.setenv("GITHUB_PAT", "ghp_env")
        cur = _FakeCursor(fetchone_row=None)
        with patch("hevy2garmin.db.get_database_url", return_value="postgresql://x"), \
             patch("hevy2garmin.db.get_db", return_value=_FakeDB(cur)):
            assert get_github_pat() == "ghp_env"

    def test_db_read_failure_falls_back_to_env(self, monkeypatch):
        monkeypatch.setenv("GITHUB_PAT", "ghp_env")

        class _Boom:
            def _get_conn(self):
                raise RuntimeError("db down")

        with patch("hevy2garmin.db.get_database_url", return_value="postgresql://x"), \
             patch("hevy2garmin.db.get_db", return_value=_Boom()):
            assert get_github_pat() == "ghp_env"


class TestSaveGithubPat:
    def test_writes_github_row_on_cloud(self):
        cur = _FakeCursor()
        fake = _FakeDB(cur)
        with patch("hevy2garmin.server.db.get_database_url", return_value="postgresql://x"), \
             patch("hevy2garmin.server.db.get_db", return_value=fake):
            _save_github_pat("  ghp_tok  ")
        assert len(cur.executed) == 1
        sql, params = cur.executed[0]
        assert "platform_credentials" in sql and "'github'" in sql
        assert params == ('{"pat": "ghp_tok"}',)
        assert fake._conn.committed is True

    def test_noop_when_local(self):
        cur = _FakeCursor()
        with patch("hevy2garmin.server.db.get_database_url", return_value=None), \
             patch("hevy2garmin.server.db.get_db", return_value=_FakeDB(cur)):
            _save_github_pat("ghp_tok")
        assert cur.executed == []

    def test_noop_on_blank(self):
        cur = _FakeCursor()
        with patch("hevy2garmin.server.db.get_database_url", return_value="postgresql://x"), \
             patch("hevy2garmin.server.db.get_db", return_value=_FakeDB(cur)):
            _save_github_pat("   ")
        assert cur.executed == []


class TestToggleAutosyncNeedsToken:
    """On Vercel, enabling auto-sync without a token must refuse, not no-op."""

    def _client(self):
        srv._is_configured_cache = True
        return TestClient(srv.app)

    def test_enable_without_token_shows_message(self, monkeypatch):
        monkeypatch.setenv("VERCEL", "1")
        # The guard returns before any config load/save, so no disk or DB touch.
        with patch("hevy2garmin.server.get_github_pat", return_value=None), \
             patch("hevy2garmin.server._setup_github_actions") as setup:
            r = self._client().post("/api/toggle-autosync", data={"enabled": "true", "interval": "120"})
        assert r.status_code == 200
        assert "needs a GitHub token" in r.text
        setup.assert_not_called()

    def test_enable_with_token_proceeds(self, monkeypatch):
        monkeypatch.setenv("VERCEL", "1")

        async def _ok(interval_minutes=120):
            return True, "ok"

        with patch("hevy2garmin.server.get_github_pat", return_value="ghp_tok"), \
             patch("hevy2garmin.server.load_config", return_value={"auto_sync": {}}), \
             patch("hevy2garmin.server.save_config"), \
             patch("hevy2garmin.server.db.get_database_url", return_value=None), \
             patch("hevy2garmin.server._setup_github_actions", side_effect=_ok) as setup:
            r = self._client().post("/api/toggle-autosync", data={"enabled": "true", "interval": "120"})
        assert r.status_code == 200
        assert "needs a GitHub token" not in r.text
        setup.assert_called_once()
