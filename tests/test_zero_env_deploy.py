"""Zero-env cloud deploy (issue #446).

A fresh Vercel deploy should need no hand-typed credential env vars: the setup
wizard collects the Hevy key and Garmin login and writes them to the DB
(``platform_credentials``), and ``is_configured()`` reads them back from there.
These tests lock that path in so the README can drop the env-var step (#447)
without regressing.
"""

from __future__ import annotations

import json
import os
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from hevy2garmin.config import is_configured


class _RecordingCursor:
    """Minimal cursor: records executes, answers the two SELECTs load_config and
    is_configured make against ``platform_credentials``."""

    def __init__(self, cred_rows=None, has_cred_row=False):
        self.cred_rows = cred_rows or []
        self.has_cred_row = has_cred_row
        self.executed: list = []
        self._last = ""

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, params=None):
        self._last = sql
        self.executed.append((sql, params))

    def fetchall(self):
        if "platform_credentials" in self._last:
            return list(self.cred_rows)
        return []

    def fetchone(self):
        if "platform_credentials" in self._last:
            return {"exists": 1} if self.has_cred_row else None
        return None


class _RecordingConn:
    def __init__(self, cursor):
        self._c = cursor
        self.committed = False

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def cursor(self):
        return self._c

    def commit(self):
        self.committed = True


class _RecordingDB:
    def __init__(self, cursor):
        self._conn = _RecordingConn(cursor)

    def _get_conn(self):
        return self._conn


@pytest.fixture
def no_env(monkeypatch):
    """A cloud deploy with none of the credential env vars set."""
    for var in ("HEVY_API_KEY", "GARMIN_EMAIL", "GARMIN_PASSWORD", "GITHUB_PAT",
                "HEVY2GARMIN_SECRET", "H2G_PASSWORD", "DEMO_MODE"):
        monkeypatch.delenv(var, raising=False)


class TestSetupPersistsWithoutEnv:
    def test_setup_writes_hevy_and_garmin_to_db(self, no_env):
        cur = _RecordingCursor()
        with patch("hevy2garmin.server.save_config"), \
             patch("hevy2garmin.db.get_database_url", return_value="postgresql://x"), \
             patch("hevy2garmin.db.get_db", return_value=_RecordingDB(cur)), \
             patch("hevy2garmin.garmin.get_client") as mock_client:
            from hevy2garmin.server import app
            client = TestClient(app, follow_redirects=False)
            resp = client.post("/setup", data={
                "hevy_api_key": "hk_test",
                "garmin_email": "user@example.com",
                "garmin_password": "pw",
                "weight_kg": 80, "birth_year": 1990, "sex": "male",
            })

        assert resp.status_code in (200, 303)
        # No datacenter-IP Garmin test login on cloud (#148), so the only thing
        # proving the creds were captured is the DB write.
        mock_client.assert_not_called()

        inserts = [(sql, params) for sql, params in cur.executed if "INSERT INTO platform_credentials" in sql]
        hevy = [p for sql, p in inserts if "'hevy'" in sql]
        garmin = [p for sql, p in inserts if "'garmin'" in sql]
        assert hevy and json.loads(hevy[0][0])["api_key"] == "hk_test"
        assert garmin and json.loads(garmin[0][0]) == {"email": "user@example.com", "password": "pw"}


class TestIsConfiguredFromDbOnly:
    def test_true_when_db_has_creds_and_env_empty(self, no_env):
        cur = _RecordingCursor(
            cred_rows=[{"platform": "hevy", "credentials": {"api_key": "hk_test"}},
                       {"platform": "garmin", "credentials": {"email": "u@e.com", "password": "pw"}}],
            has_cred_row=True,
        )
        with patch("hevy2garmin.db.get_database_url", return_value="postgresql://x"), \
             patch("hevy2garmin.db.get_db", return_value=_RecordingDB(cur)):
            assert is_configured() is True

    def test_false_when_db_empty_and_env_empty(self, no_env):
        cur = _RecordingCursor(cred_rows=[], has_cred_row=False)
        with patch("hevy2garmin.db.get_database_url", return_value="postgresql://x"), \
             patch("hevy2garmin.db.get_db", return_value=_RecordingDB(cur)):
            assert is_configured() is False
