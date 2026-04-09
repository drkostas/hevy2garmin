"""Tests for Garmin upload module."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from hevy2garmin.garmin import find_activity_by_start_time, generate_description


class TestFindActivityByStartTime:
    def _make_activities(self, *start_times: str) -> list[dict]:
        return [
            {"activityId": i + 1, "startTimeLocal": t}
            for i, t in enumerate(start_times)
        ]

    def test_exact_match(self) -> None:
        client = MagicMock()
        acts = self._make_activities("2026-04-01 20:00:00")
        with patch("hevy2garmin.garmin._limiter") as mock_limiter:
            mock_limiter.call.return_value = acts
            result = find_activity_by_start_time(client, "2026-04-01T20:00:00+00:00")
            assert result == 1

    def test_within_window(self) -> None:
        client = MagicMock()
        acts = self._make_activities("2026-04-01 20:05:00")
        with patch("hevy2garmin.garmin._limiter") as mock_limiter:
            mock_limiter.call.return_value = acts
            result = find_activity_by_start_time(client, "2026-04-01T20:00:00+00:00", window_minutes=10)
            assert result == 1

    def test_outside_window(self) -> None:
        client = MagicMock()
        acts = self._make_activities("2026-04-01 21:00:00")
        with patch("hevy2garmin.garmin._limiter") as mock_limiter:
            mock_limiter.call.return_value = acts
            result = find_activity_by_start_time(client, "2026-04-01T20:00:00+00:00", window_minutes=10)
            assert result is None

    def test_no_activities(self) -> None:
        client = MagicMock()
        with patch("hevy2garmin.garmin._limiter") as mock_limiter:
            mock_limiter.call.return_value = []
            result = find_activity_by_start_time(client, "2026-04-01T20:00:00+00:00")
            assert result is None

    def test_picks_closest(self) -> None:
        client = MagicMock()
        acts = self._make_activities("2026-04-01 21:00:00", "2026-04-01 20:02:00")
        with patch("hevy2garmin.garmin._limiter") as mock_limiter:
            mock_limiter.call.return_value = acts
            result = find_activity_by_start_time(client, "2026-04-01T20:00:00+00:00", window_minutes=10)
            assert result == 2  # the 20:02 one

    def test_invalid_target_time(self) -> None:
        client = MagicMock()
        result = find_activity_by_start_time(client, "not-a-date")
        assert result is None

    def test_api_error_returns_none(self) -> None:
        client = MagicMock()
        with patch("hevy2garmin.garmin._limiter") as mock_limiter:
            mock_limiter.call.side_effect = Exception("API error")
            result = find_activity_by_start_time(client, "2026-04-01T20:00:00+00:00")
            assert result is None


class TestGenerateDescription:
    def test_basic_description(self, sample_workout: dict) -> None:
        desc = generate_description(sample_workout, calories=200, avg_hr=95)
        assert "🏋️ Push" in desc
        assert "200 kcal" in desc
        assert "avg 95 bpm" in desc
        assert "hevy2garmin" in desc

    def test_includes_exercises(self, sample_workout: dict) -> None:
        desc = generate_description(sample_workout)
        assert "Bench Press" in desc
        assert "Shoulder Press" in desc

    def test_shows_sets_and_weight(self, sample_workout: dict) -> None:
        desc = generate_description(sample_workout)
        assert "3 sets" in desc  # 3 normal bench sets
        assert "60.0kg" in desc

    def test_no_calories(self, sample_workout: dict) -> None:
        desc = generate_description(sample_workout, calories=None, avg_hr=None)
        assert "kcal" not in desc
        assert "bpm" not in desc

    def test_duration(self, sample_workout: dict) -> None:
        desc = generate_description(sample_workout)
        assert "45 min" in desc

    def test_empty_workout(self) -> None:
        workout = {"title": "Empty", "exercises": []}
        desc = generate_description(workout)
        assert "Empty" in desc

    def test_warmup_only_singular(self) -> None:
        workout = {"title": "W", "exercises": [
            {"title": "Bench", "sets": [{"type": "warmup", "weight_kg": 20, "reps": 5}]}
        ]}
        desc = generate_description(workout)
        assert "1 warmup set" in desc
        assert "1 warmup sets" not in desc

    def test_warmup_only_plural(self) -> None:
        workout = {"title": "W", "exercises": [
            {"title": "Bench", "sets": [
                {"type": "warmup", "weight_kg": 20, "reps": 5},
                {"type": "warmup", "weight_kg": 30, "reps": 5},
            ]}
        ]}
        desc = generate_description(workout)
        assert "2 warmup sets" in desc

    def test_cardio_exercise_description(self) -> None:
        workout = {"title": "Cardio", "exercises": [
            {"title": "Treadmill", "sets": [
                {"type": "normal", "distance_meters": 5000, "duration_seconds": 1800, "weight_kg": None, "reps": None}
            ]}
        ]}
        desc = generate_description(workout)
        assert "5.0km" in desc
        assert "30min" in desc
        assert "1 set" in desc
        assert "1 sets" not in desc

    def test_singular_set_grammar(self) -> None:
        """1 normal set should say 'set' not 'sets'."""
        workout = {"title": "T", "exercises": [
            {"title": "Curl", "sets": [{"type": "normal", "weight_kg": 10, "reps": 12}]}
        ]}
        desc = generate_description(workout)
        assert "1 set" in desc
        assert "1 sets" not in desc

    def test_plural_sets_grammar(self) -> None:
        """3 normal sets should say 'sets'."""
        workout = {"title": "T", "exercises": [
            {"title": "Curl", "sets": [
                {"type": "normal", "weight_kg": 10, "reps": 12},
                {"type": "normal", "weight_kg": 10, "reps": 10},
                {"type": "normal", "weight_kg": 10, "reps": 8},
            ]}
        ]}
        desc = generate_description(workout)
        assert "3 sets" in desc

    def test_mixed_strength_and_cardio(self) -> None:
        workout = {"title": "Mixed", "exercises": [
            {"title": "Bench", "sets": [{"type": "normal", "weight_kg": 80, "reps": 8}]},
            {"title": "Treadmill", "sets": [
                {"type": "normal", "distance_meters": 3000, "duration_seconds": 900, "weight_kg": None, "reps": None}
            ]},
        ]}
        desc = generate_description(workout)
        assert "80.0kg" in desc
        assert "3.0km" in desc
