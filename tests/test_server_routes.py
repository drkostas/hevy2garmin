"""HTTP-level tests for state-mutating routes that had no coverage.

Everything here goes through TestClient rather than calling handlers directly,
so the middleware stack (check_setup, reverse_proxy_prefix, security_headers)
runs too — that is the part unit tests on the handlers cannot reach.

The routes covered here mutate or destroy state: they drop sync records, delete
custom mappings, abandon in-flight uploads, invalidate every session, or turn
auto-sync on and off. Their guard rails (explicit confirmation, id validation,
demo-mode refusal) were previously unverified.
"""

from __future__ import annotations

import os
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from hevy2garmin import autosync, syncstate
from hevy2garmin import server as srv


@pytest.fixture
def client():
    """Configured, unauthenticated client.

    _is_configured_cache short-circuits the "not configured → /setup" redirect
    that would otherwise swallow every request.
    """
    srv._is_configured_cache = True
    with patch.dict(os.environ, {}, clear=False):
        for k in ("HEVY2GARMIN_SECRET", "H2G_PASSWORD", "H2G_PASSWORD_HASH", "DEMO_MODE",
                  "VERCEL", "GITHUB_PAT"):
            os.environ.pop(k, None)
        yield TestClient(srv.app)


@pytest.fixture
def demo_client():
    """Client with DEMO_MODE on — mutating routes must refuse."""
    srv._is_configured_cache = True
    with patch.dict(os.environ, {"DEMO_MODE": "true"}, clear=False):
        for k in ("HEVY2GARMIN_SECRET", "H2G_PASSWORD"):
            os.environ.pop(k, None)
        yield TestClient(srv.app)


class TestUnsyncOne:
    """POST /api/unsync/{hevy_id} — drops a sync record so it can re-sync."""

    def test_unknown_workout_returns_404(self, client) -> None:
        with patch.object(srv.db, "get_garmin_id", lambda h: None), \
             patch.object(srv.db, "unsync", lambda h: False):
            r = client.post("/api/unsync/nope")
        assert r.status_code == 404
        assert r.json()["ok"] is False

    def test_removes_record_and_clears_cached_pages(self, client) -> None:
        """The workouts page reads cached pages, so they must be invalidated."""
        cleared: list[str] = []

        class FakeDB:
            def set_app_config(self, k, v):
                cleared.append(k)

        with patch.object(srv.db, "get_garmin_id", lambda h: None), \
             patch.object(srv.db, "unsync", lambda h: True), \
             patch.object(srv.db, "get_db", lambda: FakeDB()):
            r = client.post("/api/unsync/w1")
        assert r.status_code == 200
        assert r.json()["ok"] is True
        assert cleared == [f"hevy_workouts_page_{p}" for p in range(1, 11)]

    def test_does_not_touch_garmin_unless_asked(self, client) -> None:
        """Without delete_garmin the Garmin activity must survive."""

        class FakeDB:
            def set_app_config(self, k, v):
                pass

        with patch.object(srv.db, "get_garmin_id", lambda h: "g123"), \
             patch.object(srv.db, "unsync", lambda h: True), \
             patch.object(srv.db, "get_db", lambda: FakeDB()):
            r = client.post("/api/unsync/w1")
        assert r.status_code == 200
        assert r.json()["garmin_deleted"] is False


class TestAbandonPending:
    """POST /api/pending/{hevy_id}/abandon — gives up on an in-flight upload.

    Abandoning can leave an orphan activity on Garmin, so it is guarded by an
    explicit confirmation echoing the workout id.
    """

    def test_rejects_malformed_id(self, client) -> None:
        r = client.post("/api/pending/bad%20id!/abandon", data={"confirm": "bad id!"})
        assert r.status_code == 400
        assert "Invalid workout ID" in r.json()["error"]

    def test_requires_confirmation_matching_the_id(self, client) -> None:
        called: list[str] = []
        with patch.object(srv.db, "delete_pending", lambda h: called.append(h) or True):
            r = client.post("/api/pending/w1/abandon", data={"confirm": "w2"})
        assert r.status_code == 400
        assert "Explicit confirmation required" in r.json()["error"]
        assert called == [], "must not delete when confirmation does not match"

    def test_missing_confirmation_is_rejected(self, client) -> None:
        called: list[str] = []
        with patch.object(srv.db, "delete_pending", lambda h: called.append(h) or True):
            r = client.post("/api/pending/w1/abandon")
        assert r.status_code == 400
        assert called == []

    def test_no_pending_operation_returns_404(self, client) -> None:
        with patch.object(srv.db, "delete_pending", lambda h: False):
            r = client.post("/api/pending/w1/abandon", data={"confirm": "w1"})
        assert r.status_code == 404

    def test_correct_confirmation_abandons(self, client) -> None:
        called: list[str] = []
        with patch.object(srv.db, "delete_pending", lambda h: called.append(h) or True):
            r = client.post("/api/pending/w1/abandon", data={"confirm": "w1"})
        assert r.status_code == 200
        assert r.json()["ok"] is True
        assert called == ["w1"]


class TestDeleteMapping:
    """POST /api/mapping/delete — removes a custom exercise mapping."""

    def test_empty_name_is_rejected(self, client) -> None:
        r = client.post("/api/mapping/delete", data={"hevy_name": "   "})
        assert r.status_code == 200  # HTMX partial, not a JSON error
        assert "required" in r.text.lower()

    def test_deletes_from_db_on_cloud(self, client) -> None:
        """With DATABASE_URL set the mapping lives in the DB, not on disk."""
        deleted: list[str] = []

        class FakeDB:
            def delete_custom_mapping(self, name):
                deleted.append(name)

        with patch.object(srv.db, "get_database_url", lambda: "postgres://x"), \
             patch.object(srv.db, "get_db", lambda: FakeDB()):
            r = client.post("/api/mapping/delete", data={"hevy_name": "Zercher Squat"})
        assert r.status_code == 200
        assert deleted == ["Zercher Squat"]

    def test_deletes_from_disk_when_self_hosted(self, client, tmp_path, monkeypatch) -> None:
        """Self-hosted keeps custom mappings in ~/.hevy2garmin/custom_mappings.json."""
        import json

        home = tmp_path
        monkeypatch.setenv("HOME", str(home))
        cfg = home / ".hevy2garmin"
        cfg.mkdir()
        (cfg / "custom_mappings.json").write_text(
            json.dumps({"Zercher Squat": [3, 4], "Keep Me": [1, 2]})
        )

        with patch.object(srv.db, "get_database_url", lambda: None):
            r = client.post("/api/mapping/delete", data={"hevy_name": "Zercher Squat"})
        assert r.status_code == 200
        left = json.loads((cfg / "custom_mappings.json").read_text())
        assert "Zercher Squat" not in left
        assert left["Keep Me"] == [1, 2], "must not touch other mappings"


class TestToggleAutosync:
    """POST /api/toggle-autosync — starts and stops the auto-sync loop."""

    def _run(self, client, form: dict):
        started: list[int] = []
        stopped: list[int] = []
        saved: list[dict] = []
        # autosync.load_config as well as srv's: the route finishes by rendering
        # autosync.status(), which reads the config through its own module. Left
        # unpatched it would read the developer's real ~/.hevy2garmin/config.json.
        with patch.object(srv, "load_config", lambda: {}), \
             patch.object(autosync, "load_config", lambda: {}), \
             patch.object(srv, "save_config", saved.append), \
             patch.object(srv.db, "get_database_url", lambda: None), \
             patch.object(autosync, "schedule", started.append), \
             patch.object(autosync, "stop", lambda: stopped.append(1)):
            r = client.post("/api/toggle-autosync", data=form)
        return r, started, stopped, saved

    def test_enabling_starts_the_loop_and_persists(self, client) -> None:
        r, started, stopped, saved = self._run(client, {"enabled": "true", "interval": "60"})
        assert r.status_code == 200
        assert started == [60]
        assert stopped == []
        assert saved[0]["auto_sync"] == {"enabled": True, "interval_minutes": 60}

    def test_disabling_stops_the_loop_and_persists(self, client) -> None:
        r, started, stopped, saved = self._run(client, {"enabled": "false", "interval": "60"})
        assert r.status_code == 200
        assert started == []
        assert stopped == [1]
        assert saved[0]["auto_sync"]["enabled"] is False

    @pytest.mark.parametrize("interval", ["30", "60", "120", "240", "360", "720", "1440"])
    def test_allowed_intervals_pass_through(self, client, interval) -> None:
        _, started, _, saved = self._run(client, {"enabled": "true", "interval": interval})
        assert started == [int(interval)]
        assert saved[0]["auto_sync"]["interval_minutes"] == int(interval)

    @pytest.mark.parametrize("bad", ["7", "0", "-30", "99999", "abc", ""])
    def test_unsupported_interval_falls_back_to_120(self, client, bad) -> None:
        """An arbitrary interval would generate an invalid cron, so it is clamped."""
        _, started, _, saved = self._run(client, {"enabled": "true", "interval": bad})
        assert started == [120]
        assert saved[0]["auto_sync"]["interval_minutes"] == 120

    def test_demo_mode_refuses_and_changes_nothing(self, demo_client) -> None:
        started: list[int] = []
        saved: list[dict] = []
        with patch.object(srv, "save_config", saved.append), \
             patch.object(autosync, "schedule", started.append):
            r = demo_client.post("/api/toggle-autosync", data={"enabled": "true"})
        assert r.json()["status"] == "demo"
        assert started == [] and saved == []


class TestUnsyncAllGuards:
    """POST /api/unsync-all — wipes every sync record."""

    def test_demo_mode_returns_403(self, demo_client) -> None:
        wiped: list[int] = []
        with patch.object(srv.db, "unsync_all", lambda: wiped.append(1) or 0):
            r = demo_client.post("/api/unsync-all", data={"confirm": "RESET"})
        assert r.status_code == 403
        assert wiped == []

    @pytest.mark.parametrize("confirm", ["", "reset", "yes", "RESET "])
    def test_wrong_confirmation_wipes_nothing(self, client, confirm) -> None:
        wiped: list[int] = []
        with patch.object(srv.db, "unsync_all", lambda: wiped.append(1) or 0):
            r = client.post("/api/unsync-all", data={"confirm": confirm})
        assert r.status_code == 400
        assert wiped == [], f"confirm={confirm!r} must not wipe"


class TestLogoutAll:
    """POST /logout-all — bumps the session epoch so every device signs out."""

    def test_bumps_the_epoch(self, client) -> None:
        store: dict = {"session_epoch": {"n": 4}}

        class FakeDB:
            def get_app_config(self, k):
                return store.get(k)

            def set_app_config(self, k, v):
                store[k] = v

        with patch.object(srv.db, "get_db", lambda: FakeDB()):
            r = client.post("/logout-all", follow_redirects=False)
        assert r.status_code == 303
        assert store["session_epoch"] == {"n": 5}

    def test_starts_from_zero_when_never_set(self, client) -> None:
        store: dict = {}

        class FakeDB:
            def get_app_config(self, k):
                return store.get(k)

            def set_app_config(self, k, v):
                store[k] = v

        with patch.object(srv.db, "get_db", lambda: FakeDB()):
            r = client.post("/logout-all", follow_redirects=False)
        assert r.status_code == 303
        assert store["session_epoch"] == {"n": 1}

    def test_db_failure_surfaces_the_error_instead_of_faking_success(self, client) -> None:
        """If the epoch never advanced, other devices are still signed in. The
        route keeps this session and redirects to /settings with an error rather
        than to /login as if sign-out-everywhere had worked."""

        class BrokenDB:
            def get_app_config(self, k):
                raise RuntimeError("db down")

            def set_app_config(self, k, v):
                raise RuntimeError("db down")

        with patch.object(srv.db, "get_db", lambda: BrokenDB()):
            r = client.post("/logout-all", follow_redirects=False)
        assert r.status_code == 303
        assert "err=logout_all" in r.headers["location"]
        assert "/login" not in r.headers["location"]
        assert "set-cookie" not in r.headers, "the current session must be kept"


class TestValidateHevy:
    """GET /api/validate-hevy — used by the setup page to test an API key."""

    def test_missing_key_returns_400(self, client) -> None:
        r = client.get("/api/validate-hevy")
        assert r.status_code == 400
        assert "No key provided" in r.json()["error"]

    def test_valid_key_reports_workout_count(self, client) -> None:
        class FakeClient:
            def __init__(self, api_key):
                self.api_key = api_key

            def get_workout_count(self):
                return 42

        with patch("hevy2garmin.hevy.HevyClient", FakeClient):
            r = client.get("/api/validate-hevy", params={"key": "k"})
        assert r.status_code == 200
        assert r.json() == {"valid": True, "workout_count": 42}

    def test_rejected_key_reports_invalid(self, client) -> None:
        class FakeClient:
            def __init__(self, api_key):
                pass

            def get_workout_count(self):
                raise RuntimeError("401 Unauthorized")

        with patch("hevy2garmin.hevy.HevyClient", FakeClient):
            r = client.get("/api/validate-hevy", params={"key": "bad"})
        assert r.status_code == 400
        assert r.json()["valid"] is False


class TestReconcilePending:
    """POST /api/pending/{id}/reconcile — asks Garmin what actually happened to
    an in-flight upload, so a half-finished operation can be resolved."""

    def test_rejects_malformed_id(self, client) -> None:
        r = client.post("/api/pending/bad%20id!/reconcile")
        assert r.status_code == 400
        assert "Invalid workout ID" in r.json()["error"]

    def test_no_pending_operation_returns_404(self, client) -> None:
        class FakeDB:
            def get_pending(self, h):
                return None

        with patch.object(srv.db, "get_db", lambda: FakeDB()):
            r = client.post("/api/pending/w1/reconcile")
        assert r.status_code == 404

    def test_reports_the_resolved_status(self, client) -> None:
        class FakeDB:
            def get_pending(self, h):
                return {"phase": "submitted"}

        class Result:
            status = "uploaded"

        with patch.object(srv.db, "get_db", lambda: FakeDB()), \
             patch.object(srv, "load_config", lambda: {}), \
             patch("hevy2garmin.garmin.get_client", lambda e: object()), \
             patch("hevy2garmin.sync.reconcile_pending", lambda s, c, h: Result()):
            r = client.post("/api/pending/w1/reconcile")
        assert r.status_code == 200
        assert r.json() == {"ok": True, "status": "uploaded"}

    def test_garmin_failure_is_502_not_500(self, client) -> None:
        """A Garmin outage is an upstream failure, not a bug in this app."""

        class FakeDB:
            def get_pending(self, h):
                return {"phase": "submitted"}

        def boom(*a, **k):
            raise RuntimeError("garmin down")

        with patch.object(srv.db, "get_db", lambda: FakeDB()), \
             patch.object(srv, "load_config", lambda: {}), \
             patch("hevy2garmin.garmin.get_client", lambda e: object()), \
             patch("hevy2garmin.sync.reconcile_pending", boom):
            r = client.post("/api/pending/w1/reconcile")
        assert r.status_code == 502
        assert "garmin down" in r.json()["error"]


class TestRetryPending:
    """POST /api/pending/{id}/retry — re-uploads a definitively rejected upload.

    Retrying anything still in flight could duplicate the activity on Garmin, so
    it is gated on the operation having reached the 'failed' phase.
    """

    def test_rejects_malformed_id(self, client) -> None:
        r = client.post("/api/pending/bad%20id!/retry", data={"confirm": "bad id!"})
        assert r.status_code == 400

    def test_requires_confirmation_matching_the_id(self, client) -> None:
        r = client.post("/api/pending/w1/retry", data={"confirm": "w2"})
        assert r.status_code == 400
        assert "Explicit confirmation required" in r.json()["error"]

    @pytest.mark.parametrize("phase", ["submitted", "uploading", "pending", None])
    def test_only_failed_uploads_are_retryable(self, client, phase) -> None:
        """Retrying an in-flight upload risks a duplicate activity on Garmin."""
        synced: list[str] = []

        class FakeDB:
            def get_pending(self, h):
                return None if phase is None else {"phase": phase}

        with patch.object(srv.db, "get_db", lambda: FakeDB()), \
             patch("hevy2garmin.sync.sync_one_workout", lambda *a, **k: synced.append(1)):
            r = client.post("/api/pending/w1/retry", data={"confirm": "w1"})
        assert r.status_code == 409
        assert synced == [], "must not re-upload a non-failed operation"

    def test_missing_stored_payload_is_409(self, client) -> None:
        """Without the stored workout there is nothing to re-upload."""

        class FakeDB:
            def get_pending(self, h):
                return {"phase": "failed", "payload": {}}

            def delete_pending(self, h):
                return True

        with patch.object(srv.db, "get_db", lambda: FakeDB()), \
             patch.object(srv, "load_config", lambda: {}), \
             patch("hevy2garmin.garmin.get_client", lambda e: object()), \
             patch("hevy2garmin.sync.reconcile_pending", lambda *a: None):
            r = client.post("/api/pending/w1/retry", data={"confirm": "w1"})
        assert r.status_code == 409
        assert "payload is unavailable" in r.json()["error"]

    def test_failed_upload_is_retried_and_pending_cleared(self, client) -> None:
        deleted: list[str] = []

        class FakeDB:
            def get_pending(self, h):
                return {"phase": "failed", "payload": {"workout": {"id": "w1"}}}

            def delete_pending(self, h):
                deleted.append(h)
                return True

        class Result:
            status = "uploaded"

        with patch.object(srv.db, "get_db", lambda: FakeDB()), \
             patch.object(srv, "load_config", lambda: {}), \
             patch("hevy2garmin.garmin.get_client", lambda e: object()), \
             patch("hevy2garmin.sync.reconcile_pending", lambda *a: None), \
             patch("hevy2garmin.sync.sync_one_workout", lambda *a, **k: Result()):
            r = client.post("/api/pending/w1/retry", data={"confirm": "w1"})
        assert r.status_code == 200
        assert r.json() == {"ok": True, "status": "uploaded"}
        assert deleted == ["w1"], "the old pending row must be cleared first"


class TestRoutinesSync:
    """POST /api/routines/sync — bulk-creates Garmin planned workouts."""

    def test_demo_mode_does_not_sync(self, demo_client) -> None:
        called: list[int] = []
        with patch.object(srv, "sync_routines", lambda **k: called.append(1)):
            r = demo_client.post("/api/routines/sync")
        assert r.status_code == 200
        assert "demo mode" in r.text.lower()
        assert called == []

    def test_refuses_while_another_sync_holds_the_lock(self, client) -> None:
        """Two concurrent routine syncs would race on the Garmin calendar."""
        called: list[int] = []
        with patch.object(syncstate, "acquire_sync_lock", lambda: False), \
             patch.object(srv, "sync_routines", lambda **k: called.append(1)):
            r = client.post("/api/routines/sync")
        assert "already running" in r.text.lower()
        assert called == []


class TestGarminRateLimited:
    """POST /api/garmin-rate-limited — records a Garmin cooldown the browser saw."""

    def test_returns_the_recorded_cooldown(self, client) -> None:
        with patch.object(srv, "record_rate_limit", lambda db: 7200):
            r = client.post("/api/garmin-rate-limited")
        assert r.status_code == 200
        assert r.json()["cooldown_seconds"] == 7200

    def test_storage_failure_reports_zero_instead_of_erroring(self, client) -> None:
        """Losing the cooldown display is better than failing the caller."""

        def boom(db):
            raise RuntimeError("db down")

        with patch.object(srv, "record_rate_limit", boom):
            r = client.post("/api/garmin-rate-limited")
        assert r.status_code == 200
        assert r.json()["cooldown_seconds"] == 0


class TestScanDuplicates:
    """POST /api/scan-duplicates — log-only duplicate detection, never deletes."""

    @pytest.mark.parametrize("found,expected", [(0, "Found 0"), (1, "Found 1"), (3, "Found 3")])
    def test_reports_the_duplicate_count(self, client, found, expected) -> None:
        dups = [("w%d" % i, "g%d" % i) for i in range(found)]
        with patch.object(srv, "load_config", lambda: {"hevy_api_key": "k"}), \
             patch("hevy2garmin.hevy.HevyClient", lambda api_key: object()), \
             patch("hevy2garmin.garmin.get_client", lambda e: object()), \
             patch("hevy2garmin.sync.fetch_workouts", lambda h, limit: [{"id": "w1"}]), \
             patch("hevy2garmin.reconcile.detect_duplicates", lambda c, w, l: dups):
            r = client.post("/api/scan-duplicates")
        assert r.status_code == 200
        assert expected in r.text

    def test_never_deletes_anything(self, client) -> None:
        """The scan is log-only by contract — it must not unsync or delete."""
        destroyed: list[str] = []
        with patch.object(srv, "load_config", lambda: {"hevy_api_key": "k"}), \
             patch("hevy2garmin.hevy.HevyClient", lambda api_key: object()), \
             patch("hevy2garmin.garmin.get_client", lambda e: object()), \
             patch("hevy2garmin.sync.fetch_workouts", lambda h, limit: [{"id": "w1"}]), \
             patch("hevy2garmin.reconcile.detect_duplicates", lambda c, w, l: [("w1", "g1")]), \
             patch.object(srv.db, "unsync", lambda h: destroyed.append(h)), \
             patch.object(srv.db, "unsync_all", lambda: destroyed.append("all")):
            r = client.post("/api/scan-duplicates")
        assert r.status_code == 200
        assert destroyed == []

    def test_upstream_failure_is_surfaced_not_crashed(self, client) -> None:
        def boom(*a, **k):
            raise RuntimeError("hevy down")

        with patch.object(srv, "load_config", lambda: {"hevy_api_key": "k"}), \
             patch("hevy2garmin.hevy.HevyClient", lambda api_key: object()), \
             patch("hevy2garmin.garmin.get_client", lambda e: object()), \
             patch("hevy2garmin.sync.fetch_workouts", boom):
            r = client.post("/api/scan-duplicates")
        assert r.status_code == 200  # HTMX partial carries the error
        assert "Scan failed: hevy down" in r.text


class TestPullGarminProfile:
    """POST /api/pull-garmin-profile — imports weight/birth date/gender."""

    def test_garmin_failure_is_reported_and_config_untouched(self, client) -> None:
        """A failed pull must not half-write the profile into the config."""
        saved: list[dict] = []

        def boom(e):
            raise RuntimeError("not logged in")

        with patch.object(srv, "load_config", lambda: {}), \
             patch.object(srv, "save_config", saved.append), \
             patch("hevy2garmin.garmin.get_client", boom):
            r = client.post("/api/pull-garmin-profile")
        assert r.status_code == 200
        assert "Failed: not logged in" in r.text
        assert saved == []


class TestGarminCategories:
    """GET /api/garmin-categories — feeds the mapping UI's category picker."""

    def test_serves_the_category_map(self, client) -> None:
        with patch.object(srv, "_get_cat_names", lambda: {0: "Bench Press", 23: "Row"}):
            r = client.get("/api/garmin-categories")
        assert r.status_code == 200
        assert r.json() == {"0": "Bench Press", "23": "Row"}

    def test_serves_the_real_catalog_by_default(self, client) -> None:
        """Unpatched, the bundled FIT catalog must yield a non-empty map — an
        empty picker would silently break the mapping UI."""
        r = client.get("/api/garmin-categories")
        assert r.status_code == 200
        body = r.json()
        assert body, "category map must not be empty"
        assert all(k.isdigit() for k in body), "keys are FIT category ids"


class TestWorkoutHR:
    """GET /api/workout/{id}/hr — HR series for the workout chart."""

    def test_returns_404_when_hr_fusion_is_disabled(self, client) -> None:
        with patch.object(srv, "load_config", lambda: {"hr_fusion": {"enabled": False}}):
            r = client.get("/api/workout/w1/hr")
        assert r.status_code == 404
        assert "disabled" in r.json()["error"].lower()

    def test_serves_the_cached_series_without_calling_garmin(self, client) -> None:
        """The first load hits Garmin; later ones must come from cache."""
        called: list[int] = []
        cached = {"bpm": [120, 130], "timestamps": [1, 2]}
        with patch.object(srv, "load_config", lambda: {"hr_fusion": {"enabled": True}}), \
             patch.object(srv.db, "get_cached_hr", lambda h: cached), \
             patch("hevy2garmin.garmin.get_client", lambda e: called.append(1)):
            r = client.get("/api/workout/w1/hr")
        assert r.status_code == 200
        assert r.json() == cached
        assert called == []


class TestMappingsPage:
    """GET /mappings — the exercise-mapping table."""

    def test_renders_the_mapping_table(self, client) -> None:
        r = client.get("/mappings")
        assert r.status_code == 200
        assert "<html" in r.text.lower()

    def test_requires_auth_when_a_password_is_set(self) -> None:
        """A page listing your exercises must sit behind the dashboard gate."""
        srv._is_configured_cache = True
        with patch.dict(os.environ, {"H2G_PASSWORD": "pw"}, clear=False):
            c = TestClient(srv.app)
            r = c.get("/mappings", follow_redirects=False)
        assert r.status_code in (302, 303, 307)
        assert "/login" in r.headers["location"]


class TestSetupActions:
    """POST /api/setup-actions — configures GitHub Actions on the user's fork.

    Exempt from the "not configured → /setup" redirect, since it runs *during*
    setup.
    """

    def test_reports_success_as_a_success_toast(self, client) -> None:
        async def ok(interval_minutes):
            return True, "Workflow created"

        with patch.object(srv, "_setup_github_actions", ok):
            r = client.post("/api/setup-actions", data={"interval": "60"})
        assert r.status_code == 200
        assert "toast-success" in r.text
        assert "Workflow created" in r.text

    def test_reports_failure_as_an_error_toast(self, client) -> None:
        """A silent failure would leave the user believing auto-sync is on."""

        async def fail(interval_minutes):
            return False, "Bad credentials"

        with patch.object(srv, "_setup_github_actions", fail):
            r = client.post("/api/setup-actions", data={"interval": "60"})
        assert r.status_code == 200
        assert "toast-error" in r.text
        assert "Bad credentials" in r.text

    @pytest.mark.parametrize("raw,expected", [("30", 30), ("720", 720), ("abc", 120), ("", 120)])
    def test_interval_is_parsed_with_a_120_fallback(self, client, raw, expected) -> None:
        seen: list[int] = []

        async def capture(interval_minutes):
            seen.append(interval_minutes)
            return True, "ok"

        with patch.object(srv, "_setup_github_actions", capture):
            client.post("/api/setup-actions", data={"interval": raw})
        assert seen == [expected]

    def test_reachable_before_the_app_is_configured(self, client) -> None:
        """It runs during setup, so the /setup redirect must not swallow it."""
        seen: list[int] = []

        async def capture(interval_minutes):
            seen.append(interval_minutes)
            return True, "ok"

        srv._is_configured_cache = False
        try:
            with patch.object(srv, "is_configured", lambda: False), \
                 patch.object(srv, "_setup_github_actions", capture):
                r = client.post("/api/setup-actions", data={"interval": "60"},
                                follow_redirects=False)
        finally:
            srv._is_configured_cache = True
        assert r.status_code == 200, "must not redirect to /setup"
        assert seen == [60]


class TestTimezoneSetting:
    """POST /settings persists the profile timezone used for FIT local_timestamp."""

    _FORM = {
        "weight_kg": "80", "birth_year": "1990", "sex": "male", "vo2max": "45",
        "working_set_seconds": "40", "warmup_set_seconds": "25",
        "rest_between_sets_seconds": "75", "rest_between_exercises_seconds": "120",
    }

    def _post(self, client, tz: str) -> dict:
        store: dict = {"user_profile": {}, "timing": {}, "hr_fusion": {}}
        with patch.object(srv, "load_config", lambda: store), \
             patch.object(srv, "save_config", lambda c: store.update(c)), \
             patch.object(srv.db, "get_database_url", lambda: None):
            r = client.post("/settings", data={**self._FORM, "timezone": tz})
        assert r.status_code == 200
        return store

    def test_timezone_is_saved_and_stripped(self, client) -> None:
        store = self._post(client, "  Europe/Berlin  ")
        assert store["user_profile"]["timezone"] == "Europe/Berlin"

    def test_blank_timezone_persists_as_empty(self, client) -> None:
        store = self._post(client, "")
        assert store["user_profile"]["timezone"] == ""
