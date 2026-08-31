"""Every single-workout sync trigger must leave a row in the sync log.

Only auto-sync used to record one. Dashboard "Sync Now", the per-row sync on
the workouts page and the cron endpoint all ran silently, so a gap on /history
was indistinguishable from a sync that had stopped running — the exact question
the log exists to answer. The trigger label is what makes the row useful, so
each entry point is asserted by its own label.
"""

from __future__ import annotations

import json
import os

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def recorded(monkeypatch):
    """Collect what syncstate.record_sync_log is asked to write."""
    from hevy2garmin import syncstate

    rows: list[tuple[dict, str]] = []
    monkeypatch.setattr(
        syncstate, "record_sync_log", lambda result, trigger="manual": rows.append((result, trigger))
    )
    return rows


@pytest.fixture
def client(monkeypatch):
    os.environ.pop("HEVY2GARMIN_SECRET", None)
    os.environ.pop("DEMO_MODE", None)
    monkeypatch.setenv("CRON_SECRET", "test-cron")
    # /api/sync hands off to GitHub Actions when both of these are set, which
    # would skip the sync under test *and* fire a real repository_dispatch at
    # api.github.com from whatever machine runs the suite.
    os.environ.pop("GITHUB_PAT", None)
    os.environ.pop("GITHUB_REPO", None)
    os.environ.pop("VERCEL", None)
    from hevy2garmin import server

    monkeypatch.setattr(server, "_is_configured_cache", True)
    yield TestClient(server.app, follow_redirects=False)


def _stub_sync_one(monkeypatch, payload: dict):
    """Replace the inner sync with a canned JSON response."""
    from fastapi.responses import JSONResponse

    from hevy2garmin import server

    async def _fake(*, respect_grace=False, **kw):
        return JSONResponse(payload)

    monkeypatch.setattr(server, "_do_sync_one", _fake)


class TestSyncNowIsRecorded:
    def test_successful_sync_now_records_one_synced(self, client, recorded, monkeypatch):
        _stub_sync_one(monkeypatch, {"synced": 1, "title": "Push"})
        resp = client.post("/api/sync-one")
        assert resp.status_code == 200
        assert recorded == [({"synced": 1, "failed": 0}, "manual (one)")]

    def test_error_from_sync_now_records_a_failure(self, client, recorded, monkeypatch):
        _stub_sync_one(monkeypatch, {"error": "Garmin upload failed"})
        client.post("/api/sync-one")
        assert recorded == [({"synced": 0, "failed": 1}, "manual (one)")]

    def test_nothing_to_do_still_records_the_run(self, client, recorded, monkeypatch):
        _stub_sync_one(monkeypatch, {"synced": 0, "done": True})
        client.post("/api/sync-one")
        assert recorded == [({"synced": 0, "failed": 0}, "manual (one)")]

    def test_new_manual_request_clears_previous_failed_quarantine(self, client, monkeypatch):
        from hevy2garmin import server

        server._failed_ids.add("transient-failure")
        _stub_sync_one(monkeypatch, {"synced": 0, "done": True})
        client.post("/api/sync-one")
        assert "transient-failure" not in server._failed_ids


class TestSyncStateMismatch:
    def test_hevy_count_without_a_listed_unsynced_workout_is_actionable(self, monkeypatch):
        """Do not return the non-terminating remaining=1/processing=0 shape."""
        import asyncio
        from unittest.mock import MagicMock, patch

        from hevy2garmin import server

        hevy = MagicMock()
        hevy.get_workout_count.return_value = 1
        hevy.get_workouts.return_value = {"workouts": [], "page_count": 1}
        database = MagicMock()
        database.list_pending.return_value = []

        with (
            patch.object(server, "load_config", return_value={"hevy_api_key": "test-key"}),
            patch("hevy2garmin.hevy.HevyClient", return_value=hevy),
            patch.object(server.db, "get_db", return_value=database),
            patch.object(server.db, "get_synced_count", return_value=0),
        ):
            response = asyncio.run(server._do_sync_one(respect_grace=False))

        assert response.status_code == 409
        assert response.body and b"state_mismatch" in response.body
        assert b"Reload Data" in response.body


class TestFailuresAreDistinguishableFromNoWork:
    """A failed sync must not look like "nothing to sync" on /history.

    _do_sync_one reports a non-synced outcome as {"synced": 0, <status>: 1}, so a
    rejected upload arrives as failed=1 — not as an `error` key. Classifying on
    error/skipped_error alone logged it 0/0, which is byte-identical to a healthy
    idle run and is the precise ambiguity the sync log exists to remove. It also
    disagreed with the per-row path, which records failed=1 for the same event.
    """

    def test_failed_upload_is_recorded_as_a_failure(self, client, recorded, monkeypatch):
        _stub_sync_one(monkeypatch, {"synced": 0, "failed": 1, "title": "Push", "done": False})
        client.post("/api/sync-one")
        assert recorded == [({"synced": 0, "failed": 1}, "manual (one)")]

    def test_failed_upload_on_the_cron_path_too(self, client, recorded, monkeypatch):
        _stub_sync_one(monkeypatch, {"synced": 0, "failed": 1, "title": "Push", "done": False})
        client.get("/api/cron/sync", headers={"Authorization": "Bearer test-cron"})
        assert recorded == [({"synced": 0, "failed": 1}, "cron")]

    def test_in_flight_statuses_are_not_counted_as_failures(self, client, recorded, monkeypatch):
        """needs_review / processing / deferred are unfinished, not failed."""
        for status in ("needs_review", "processing", "deferred", "merge_pending"):
            recorded.clear()
            _stub_sync_one(monkeypatch, {"synced": 0, status: 1, "done": False})
            client.post("/api/sync-one")
            assert recorded == [({"synced": 0, "failed": 0}, "manual (one)")], status

    def test_a_raising_sync_is_recorded_before_it_propagates(self, client, recorded, monkeypatch):
        from hevy2garmin import server

        async def _boom(*, respect_grace=False, **kw):
            raise RuntimeError("Hevy 502")

        monkeypatch.setattr(server, "_do_sync_one", _boom)
        with pytest.raises(RuntimeError):
            client.post("/api/sync-one")
        assert recorded == [({"failed": 1}, "manual (one)")]


class TestCronIsRecorded:
    def test_cron_sync_records_with_its_own_trigger(self, client, recorded, monkeypatch):
        _stub_sync_one(monkeypatch, {"synced": 1, "title": "Pull"})
        resp = client.get("/api/cron/sync", headers={"Authorization": "Bearer test-cron"})
        assert resp.status_code == 200
        assert recorded == [({"synced": 1, "failed": 0}, "cron")]

    def test_cron_still_respects_grace(self, client, recorded, monkeypatch):
        """The refactor must not turn cron into a grace-bypassing sync."""
        from hevy2garmin import server

        seen: dict = {}

        async def _fake(*, respect_grace=False, **kw):
            from fastapi.responses import JSONResponse

            seen["respect_grace"] = respect_grace
            return JSONResponse({"synced": 0, "deferred": 1})

        monkeypatch.setattr(server, "_do_sync_one", _fake)
        client.get("/api/cron/sync", headers={"Authorization": "Bearer test-cron"})
        assert seen["respect_grace"] is True

    def test_sync_now_still_bypasses_grace(self, client, recorded, monkeypatch):
        from hevy2garmin import server

        seen: dict = {}

        async def _fake(*, respect_grace=False, **kw):
            from fastapi.responses import JSONResponse

            seen["respect_grace"] = respect_grace
            return JSONResponse({"synced": 1})

        monkeypatch.setattr(server, "_do_sync_one", _fake)
        client.post("/api/sync-one")
        assert seen["respect_grace"] is False

    def test_unauthorized_cron_records_nothing(self, client, recorded, monkeypatch):
        _stub_sync_one(monkeypatch, {"synced": 1})
        monkeypatch.setenv("CRON_SECRET", "s3cret")
        resp = client.get("/api/cron/sync")
        assert resp.status_code == 401
        assert recorded == []

    def test_unconfigured_cron_fails_closed(self, client, recorded, monkeypatch):
        _stub_sync_one(monkeypatch, {"synced": 1})
        monkeypatch.delenv("CRON_SECRET")
        resp = client.get("/api/cron/sync")
        assert resp.status_code == 503
        assert "CRON_SECRET" in resp.json()["error"]
        assert recorded == []


class TestLockIsStillHeldAndReleased:
    def test_busy_response_records_nothing(self, client, recorded, monkeypatch):
        from hevy2garmin import syncstate

        monkeypatch.setattr(syncstate, "acquire_sync_lock", lambda: False)
        resp = client.post("/api/sync-one")
        assert json.loads(resp.content)["busy"] is True
        assert recorded == []

    def test_lock_is_released_even_when_the_sync_raises(self, client, recorded, monkeypatch):
        from hevy2garmin import server, syncstate

        async def _boom(*, respect_grace=False, **kw):
            raise RuntimeError("boom")

        monkeypatch.setattr(server, "_do_sync_one", _boom)
        with pytest.raises(RuntimeError):
            client.post("/api/sync-one")
        # A leaked semaphore would make the next sync permanently "busy".
        assert syncstate.acquire_sync_lock() is True
        syncstate.release_sync_lock()
        # Recording on the exception path must not swallow the exception either.
        assert recorded == [({"failed": 1}, "manual (one)")]


class TestRecordingNeverBreaksASync:
    def test_a_failing_db_write_is_swallowed(self, monkeypatch):
        """syncstate.record_sync_log now runs from inside except handlers."""
        from hevy2garmin import db, syncstate

        def _boom(**kw):
            raise RuntimeError("database is locked")

        monkeypatch.setattr(db, "record_sync_log", _boom)
        syncstate.record_sync_log({"synced": 1}, trigger="manual (one)")  # must not raise


class TestPerRowSyncIsRecorded:
    """The workouts-page sync records on both paths, including its failure."""

    def test_success_records_manual_single(self, client, recorded, monkeypatch):
        from types import SimpleNamespace

        import hevy2garmin.hevy as hevy_mod
        import hevy2garmin.sync as sync_mod
        from hevy2garmin import db, garmin, merge

        monkeypatch.setattr(
            hevy_mod,
            "HevyClient",
            lambda **kw: SimpleNamespace(
                get_workout=lambda wid: {
                    "id": wid,
                    "title": "Push",
                    "start_time": "2026-04-01T20:00:00+00:00",
                    "exercises": [],
                }
            ),
        )
        monkeypatch.setattr(garmin, "get_client", lambda email=None: object())
        monkeypatch.setattr(merge, "reset_circuit_breaker", lambda: None)
        monkeypatch.setattr(db, "get_db", lambda: object())
        monkeypatch.setattr(
            sync_mod, "sync_one_workout", lambda *a, **kw: SimpleNamespace(status="synced")
        )
        resp = client.post("/api/sync/w1")
        assert resp.status_code == 200
        assert recorded == [({"synced": 1, "failed": 0}, "manual (single)")]

    def test_an_exception_records_a_failure_and_still_renders(self, client, recorded, monkeypatch):
        import hevy2garmin.hevy as hevy_mod

        def _boom(**kw):
            raise RuntimeError("Hevy API key missing")

        monkeypatch.setattr(hevy_mod, "HevyClient", _boom)
        resp = client.post("/api/sync/w1")
        assert resp.status_code == 200
        assert "Failed:" in resp.text
        assert recorded == [({"failed": 1}, "manual (single)")]


class TestDashboardSyncIsRecorded:
    """/api/sync records with the scope in its trigger label.

    The label is the only thing on /history that distinguishes a 24h sync from
    a full backfill, and nothing asserted it — replacing it with a constant
    passed the whole suite.
    """

    def test_default_scope_is_labelled(self, client, recorded, monkeypatch):
        from hevy2garmin import server

        monkeypatch.setattr(server, "sync", lambda **kw: {"synced": 1, "skipped": 0, "failed": 0})
        r = client.post("/api/sync", data={})
        assert r.status_code == 200
        assert recorded == [({"synced": 1, "skipped": 0, "failed": 0}, "manual (recent)")]

    def test_scope_is_carried_into_the_label(self, client, recorded, monkeypatch):
        from hevy2garmin import server

        monkeypatch.setattr(server, "sync", lambda **kw: {"synced": 0, "skipped": 0, "failed": 0})
        client.post("/api/sync", data={"scope": "1y"})
        assert recorded and recorded[0][1] == "manual (1y)"

    def test_a_failing_sync_still_records_under_its_scope(self, client, recorded, monkeypatch):
        from hevy2garmin import server

        def _boom(**kw):
            raise RuntimeError("hevy down")

        monkeypatch.setattr(server, "sync", _boom)
        client.post("/api/sync", data={"scope": "7d"})
        assert recorded and recorded[0][1] == "manual (7d)"
        assert recorded[0][0]["failed"] == 1

    def test_a_sync_stamps_the_last_sync_time(self, client, recorded, monkeypatch):
        """The dashboard's "last sync" clock is driven from this call site."""
        from hevy2garmin import server, syncstate

        monkeypatch.setattr(server, "sync", lambda **kw: {"synced": 1, "skipped": 0, "failed": 0})
        monkeypatch.setattr(syncstate, "_last_sync_time", None)
        client.post("/api/sync", data={})
        assert syncstate.get_last_sync_time() is not None
