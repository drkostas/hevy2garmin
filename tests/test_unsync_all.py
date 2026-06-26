"""Bulk Unsync All endpoint: confirm-gated, demo-blocked, clears records (#174)."""
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
        srv._is_configured_cache = True
        yield TestClient(srv.app)


def test_requires_confirm(client):
    with patch("hevy2garmin.server.is_configured", return_value=True), \
         patch("hevy2garmin.server.is_demo_mode", return_value=False):
        resp = client.post("/api/unsync-all")  # no confirm
    assert resp.status_code == 400
    assert resp.json()["ok"] is False


def test_clears_all_records(client):
    fake_db = MagicMock()
    with patch("hevy2garmin.server.is_configured", return_value=True), \
         patch("hevy2garmin.server.is_demo_mode", return_value=False), \
         patch("hevy2garmin.server.db.unsync_all", return_value=65) as mock_unsync, \
         patch("hevy2garmin.server.db.get_db", return_value=fake_db):
        resp = client.post("/api/unsync-all", data={"confirm": "RESET"})
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "count": 65}
    mock_unsync.assert_called_once()


def test_blocked_in_demo(client):
    with patch("hevy2garmin.server.is_configured", return_value=True), \
         patch("hevy2garmin.server.is_demo_mode", return_value=True):
        resp = client.post("/api/unsync-all", data={"confirm": "RESET"})
    assert resp.status_code == 403
