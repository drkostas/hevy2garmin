"""Guards on the page routes that mutation testing found unverified.

Every guard here was already in the code; moving the routes into
:mod:`hevy2garmin.pages` was what surfaced the gaps, because breaking each one
on purpose left the suite green. They are the settings/setup write paths — the
demo-mode refusals, the value clamps, and the strategy allow-list — plus the
unmapped-exercise cache TTL.

Config never touches the real ``~/.hevy2garmin``: ``save_config`` is captured so
the assertions read what the route tried to persist, which is the thing under
test anyway.
"""

from __future__ import annotations

import os
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from hevy2garmin import pages
from hevy2garmin import server as srv


def _blank_config() -> dict:
    """The subset of config keys ``settings_save`` writes into."""
    return {
        "user_profile": {},
        "timing": {},
        "merge_activity_types": ["strength_training"],
    }


@pytest.fixture
def client():
    srv._is_configured_cache = True
    with patch.dict(os.environ, {}, clear=False):
        for k in ("HEVY2GARMIN_SECRET", "H2G_PASSWORD", "H2G_PASSWORD_HASH", "DEMO_MODE",
                  "VERCEL", "GITHUB_PAT", "GITHUB_REPO"):
            os.environ.pop(k, None)
        yield TestClient(srv.app, follow_redirects=False)


@pytest.fixture
def demo_client():
    srv._is_configured_cache = True
    with patch.dict(os.environ, {"DEMO_MODE": "true"}, clear=False):
        for k in ("HEVY2GARMIN_SECRET", "H2G_PASSWORD"):
            os.environ.pop(k, None)
        yield TestClient(srv.app, follow_redirects=False)


def _post_settings(client, **overrides):
    """POST /settings, returning (response, saved_configs)."""
    saved: list[dict] = []
    form = {"merge_watch_strategy": "merge"}
    form.update(overrides)
    with patch.object(pages, "load_config", _blank_config), \
         patch.object(pages, "save_config", saved.append), \
         patch.object(pages.db, "get_database_url", lambda: None):
        r = client.post("/settings", data=form)
    return r, saved


class TestSettingsDemoMode:
    """POST /settings must refuse to write anything in demo mode."""

    def test_demo_mode_refuses_and_saves_nothing(self, demo_client) -> None:
        r, saved = _post_settings(demo_client)
        assert r.status_code == 200
        assert "read-only in demo mode" in r.text
        assert saved == [], "demo mode must not persist settings"

    def test_normal_mode_does_save(self, client) -> None:
        """The counterpart: without demo mode the same POST persists."""
        r, saved = _post_settings(client)
        assert r.status_code == 303
        assert len(saved) == 1


class TestSettingsWatchStrategy:
    """merge_watch_strategy is an allow-list, not free text — a bad value must
    fall back to "merge" rather than reach the sync path (#332)."""

    @pytest.mark.parametrize("strategy", ["replace", "merge", "describe"])
    def test_known_strategies_pass_through(self, client, strategy) -> None:
        _, saved = _post_settings(client, merge_watch_strategy=strategy)
        assert saved[0]["merge_watch_strategy"] == strategy

    @pytest.mark.parametrize("bogus", ["", "nonsense", "MERGE", "delete-everything"])
    def test_unknown_strategy_falls_back_to_merge(self, client, bogus) -> None:
        _, saved = _post_settings(client, merge_watch_strategy=bogus)
        assert saved[0]["merge_watch_strategy"] == "merge"


class TestSettingsClamps:
    """The merge tuning knobs come straight off a form, so the route clamps them."""

    @pytest.mark.parametrize("sent,expected", [(0, 50), (5, 50), (50, 50), (70, 70), (95, 95), (96, 95), (5000, 95)])
    def test_overlap_pct_is_clamped_to_50_95(self, client, sent, expected) -> None:
        _, saved = _post_settings(client, merge_overlap_pct=sent)
        assert saved[0]["merge_overlap_pct"] == expected

    @pytest.mark.parametrize("sent,expected", [(0, 5), (5, 5), (20, 20), (60, 60), (61, 60), (9999, 60)])
    def test_max_drift_min_is_clamped_to_5_60(self, client, sent, expected) -> None:
        _, saved = _post_settings(client, merge_max_drift_min=sent)
        assert saved[0]["merge_max_drift_min"] == expected


class TestSetupDemoMode:
    """POST /setup must refuse to write credentials in demo mode."""

    def _post(self, client):
        saved: list[dict] = []
        with patch.object(pages, "save_config", saved.append), \
             patch.object(pages.db, "get_database_url", lambda: None), \
             patch("hevy2garmin.garmin.get_client") as mock_get_client:
            r = client.post("/setup", data={
                "hevy_api_key": "k", "garmin_email": "a@b.com", "garmin_password": "pw",
                "weight_kg": 80, "birth_year": 1990, "sex": "male",
            })
        return r, saved, mock_get_client

    def test_demo_mode_refuses_and_saves_nothing(self, demo_client) -> None:
        r, saved, mock_get_client = self._post(demo_client)
        assert r.status_code == 303
        assert r.headers["location"] == "/"
        assert saved == [], "demo mode must not persist credentials"
        mock_get_client.assert_not_called()


class TestUnmappedCacheTtl:
    """The in-memory fallback cache is only good for 10 minutes.

    Reached only when the DB cache misses, which is the local-install path.
    """

    def _fetch(self, cache, age_seconds, now=1_000_000.0):
        """Run _get_unmapped_exercises with a seeded cache of the given age."""
        calls: list[int] = []

        class FakeHevy:
            def __init__(self, api_key=None):
                calls.append(1)

            def get_workouts(self, page, page_size):
                return {"workouts": [], "page_count": 1}

        def boom():
            raise RuntimeError("no database")

        with patch.object(pages, "_unmapped_cache", cache), \
             patch.object(pages, "_unmapped_cache_time", now - age_seconds), \
             patch.object(pages.db, "get_db", boom), \
             patch.object(pages, "load_config", lambda: {"hevy_api_key": "k"}), \
             patch("hevy2garmin.hevy.HevyClient", FakeHevy), \
             patch("time.time", lambda: now):
            result = pages._get_unmapped_exercises()
        return result, calls

    def test_fresh_cache_is_reused_without_refetching(self) -> None:
        cache = [("Invented Movement 9000", 3)]
        result, calls = self._fetch(cache, age_seconds=1)
        assert result == cache
        assert calls == [], "a cache younger than the TTL must not hit Hevy"

    def test_stale_cache_is_refetched(self) -> None:
        cache = [("Invented Movement 9000", 3)]
        result, calls = self._fetch(cache, age_seconds=601)
        assert calls == [1], "a cache older than the TTL must be refetched"
        assert result == [], "the refetch result replaces the stale cache"
