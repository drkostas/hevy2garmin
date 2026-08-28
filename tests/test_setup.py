"""Tests for the setup flow.

#148: on cloud deployments the setup POST must NOT perform a redundant
server-side Garmin test login (datacenter IP is blocked + it trips Garmin's
per-account rate limit and shows a scary error). Local installs keep the test
login because that's the real auth path that caches tokens.
"""

from __future__ import annotations

import os
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client():
    with patch.dict(os.environ, {}, clear=False):
        os.environ.pop("HEVY2GARMIN_SECRET", None)
        os.environ.pop("GARMIN_PASSWORD", None)
        os.environ.pop("DEMO_MODE", None)
        from hevy2garmin.server import app
        yield TestClient(app, follow_redirects=False)


def _post(client):
    return client.post(
        "/setup",
        data={
            "hevy_api_key": "k",
            "garmin_email": "a@b.com",
            "garmin_password": "pw",
            "weight_kg": 80,
            "birth_year": 1990,
            "sex": "male",
        },
    )


class TestSetupNoRedundantLogin:
    def test_cloud_skips_server_side_test_login(self, client):
        """DATABASE_URL set → no get_client() test login during setup (#148)."""
        fake_db = MagicMock()
        with patch("hevy2garmin.pages.save_config"), \
             patch("hevy2garmin.db.get_database_url", return_value="postgresql://x"), \
             patch("hevy2garmin.db.get_db", return_value=fake_db), \
             patch("hevy2garmin.garmin.get_client") as mock_get_client:
            resp = _post(client)
        mock_get_client.assert_not_called()
        assert resp.status_code in (200, 303)

    def test_local_performs_test_login(self, client):
        """No DATABASE_URL → setup still does the real test login locally."""
        with patch("hevy2garmin.pages.save_config"), \
             patch("hevy2garmin.db.get_database_url", return_value=None), \
             patch("hevy2garmin.garmin.get_client") as mock_get_client:
            resp = _post(client)
        mock_get_client.assert_called_once()
        assert resp.status_code in (200, 303)

    def test_local_gate_skips_get_client_when_cooling_down(self, client):
        """During active cooldown, setup must NOT call get_client (would reset Garmin's timer)."""
        from datetime import datetime, timedelta, timezone
        from hevy2garmin.ratelimit import _KEY

        class FakeDB:
            def __init__(self):
                until = (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat()
                self._state = {_KEY: {"until": until, "hits": 1, "seconds": 7200}}
            def get_app_config(self, key):
                return self._state.get(key)
            def set_app_config(self, key, value):
                self._state[key] = value

        with patch("hevy2garmin.pages.save_config"), \
             patch("hevy2garmin.db.get_database_url", return_value=None), \
             patch("hevy2garmin.db.get_db", return_value=FakeDB()), \
             patch("hevy2garmin.garmin.get_client") as mock_get_client:
            resp = _post(client)
        mock_get_client.assert_not_called()
        assert resp.status_code == 200  # renders cooldown error page, not redirect
