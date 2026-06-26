"""Reload Data button clears the cached Hevy workout pages (#174)."""
from __future__ import annotations
import os
from unittest.mock import MagicMock, patch
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client():
    with patch.dict(os.environ, {}, clear=False):
        os.environ.pop("HEVY2GARMIN_SECRET", None)
        os.environ.pop("DEMO_MODE", None)
        import hevy2garmin.server as srv
        srv._is_configured_cache = True  # skip the setup-redirect gate
        yield TestClient(srv.app)


def test_reload_clears_page_caches_and_refreshes(client):
    fake_db = MagicMock()
    mock_hevy = MagicMock()
    mock_hevy.get_workout_count.return_value = 25
    with patch("hevy2garmin.server.is_configured", return_value=True), \
         patch("hevy2garmin.server.is_demo_mode", return_value=False), \
         patch("hevy2garmin.hevy.HevyClient", return_value=mock_hevy), \
         patch("hevy2garmin.server.db.get_db", return_value=fake_db):
        resp = client.post("/api/reload-data")
    assert resp.headers.get("HX-Refresh") == "true"
    cleared = [c.args for c in fake_db.set_app_config.call_args_list
               if c.args[0].startswith("hevy_workouts_page_")]
    # 25 workouts -> pages 1..3 cleared, all set to {}
    assert len(cleared) >= 3
    assert all(val == {} for _, val in cleared)


def test_reload_blocked_in_demo(client):
    with patch("hevy2garmin.server.is_configured", return_value=True), \
         patch("hevy2garmin.server.is_demo_mode", return_value=True):
        resp = client.post("/api/reload-data")
    assert "demo" in resp.text.lower()
    assert resp.headers.get("HX-Refresh") is None
