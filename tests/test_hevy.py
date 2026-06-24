"""Tests for Hevy API client."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from hevy2garmin.hevy import HevyClient


class TestInit:
    def test_requires_api_key(self) -> None:
        with patch.dict("os.environ", {}, clear=True):
            with pytest.raises(ValueError, match="API key required"):
                HevyClient(api_key="")

    def test_accepts_api_key_param(self) -> None:
        client = HevyClient(api_key="test-key-123")
        assert "test-key-123" in client.session.headers.get("api-key", "")

    def test_reads_env_var(self) -> None:
        with patch.dict("os.environ", {"HEVY_API_KEY": "env-key-456"}):
            client = HevyClient()
            assert "env-key-456" in client.session.headers.get("api-key", "")


class TestAPICalls:
    def test_get_workout_count(self) -> None:
        client = HevyClient(api_key="test")
        with patch.object(client, "_get", return_value={"workout_count": 42}):
            assert client.get_workout_count() == 42

    def test_get_workouts(self) -> None:
        client = HevyClient(api_key="test")
        mock_data = {"workouts": [{"id": "w1", "title": "Push"}], "page_count": 1}
        with patch.object(client, "_get", return_value=mock_data) as mock_get:
            result = client.get_workouts(page=1, page_size=10)
            assert len(result["workouts"]) == 1
            mock_get.assert_called_once_with("/workouts", {"page": 1, "pageSize": 10})

    def test_get_workout_by_id(self) -> None:
        # Fetches the exact workout regardless of age (#165) — directly, not by
        # scanning a page. The Hevy API returns the workout object at top level.
        client = HevyClient(api_key="test")
        wk = {"id": "old-123", "title": "Lower", "exercises": []}
        with patch.object(client, "_get", return_value=wk) as mock_get:
            result = client.get_workout("old-123")
            assert result == wk
            mock_get.assert_called_once_with("/workouts/old-123")

    def test_get_workout_unwraps_workout_key(self) -> None:
        client = HevyClient(api_key="test")
        with patch.object(client, "_get", return_value={"workout": {"id": "x", "title": "P"}}):
            assert client.get_workout("x") == {"id": "x", "title": "P"}

    def test_get_workout_not_found_returns_none(self) -> None:
        client = HevyClient(api_key="test")
        with patch.object(client, "_get", side_effect=RuntimeError("404")):
            assert client.get_workout("missing") is None

    def test_get_exercise_templates(self) -> None:
        client = HevyClient(api_key="test")
        mock_data = {"exercise_templates": [{"id": "e1"}], "page_count": 1}
        with patch.object(client, "_get", return_value=mock_data):
            result = client.get_exercise_templates()
            assert "exercise_templates" in result

    def test_get_workout_events(self) -> None:
        client = HevyClient(api_key="test")
        mock_data = {"events": []}
        with patch.object(client, "_get", return_value=mock_data) as mock_get:
            client.get_workout_events(since="2026-01-01T00:00:00Z")
            mock_get.assert_called_once_with(
                "/workouts/events",
                {"since": "2026-01-01T00:00:00Z", "page": 1, "pageSize": 10},
            )

    def test_get_all_workouts_pagination(self) -> None:
        client = HevyClient(api_key="test")
        page1 = {"workouts": [{"id": "w1"}], "page_count": 2}
        page2 = {"workouts": [{"id": "w2"}], "page_count": 2}
        with patch.object(client, "get_workouts", side_effect=[page1, page2]):
            result = client.get_all_workouts(page_size=1)
            assert len(result) == 2


class TestRateLimiting:
    def test_delay_between_calls(self) -> None:
        client = HevyClient(api_key="test")
        mock_resp = MagicMock()
        mock_resp.json.return_value = {"data": "ok"}
        mock_resp.raise_for_status.return_value = None

        with patch.object(client.session, "get", return_value=mock_resp):
            with patch("hevy2garmin.hevy.time.sleep") as mock_sleep:
                client._get("/test")
                mock_sleep.assert_called_once_with(0.5)
