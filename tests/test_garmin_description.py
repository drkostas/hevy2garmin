"""Tests for Garmin activity description generation."""

from __future__ import annotations

from hevy2garmin.garmin import generate_description


class TestDescriptionGeneration:
    def test_standard_workout(self, sample_workout: dict) -> None:
        desc = generate_description(sample_workout, calories=350, avg_hr=120)
        assert "Push" in desc
        assert "350 kcal" in desc
        assert "avg 120 bpm" in desc
        assert "Bench Press" in desc

    def test_warmup_only_exercise(self) -> None:
        workout = {
            "title": "Warmup Only",
            "start_time": "2026-04-01T20:00:00+00:00",
            "end_time": "2026-04-01T20:10:00+00:00",
            "exercises": [
                {
                    "title": "Band Pull Apart",
                    "sets": [
                        {"type": "warmup", "weight_kg": 0, "reps": 15},
                        {"type": "warmup", "weight_kg": 0, "reps": 15},
                    ],
                }
            ],
        }
        desc = generate_description(workout)
        assert "Band Pull Apart" in desc
        assert "warmup" in desc

    def test_cardio_exercise_shows_distance(self) -> None:
        workout = {
            "title": "Cardio Day",
            "start_time": "2026-04-01T20:00:00+00:00",
            "end_time": "2026-04-01T20:30:00+00:00",
            "exercises": [
                {
                    "title": "Treadmill",
                    "sets": [
                        {"type": "normal", "distance_meters": 5000, "duration_seconds": 1800},
                    ],
                }
            ],
        }
        desc = generate_description(workout)
        assert "Treadmill" in desc
        assert "5.0km" in desc
        assert "30min" in desc

    def test_cardio_duration_only(self) -> None:
        workout = {
            "title": "Bike",
            "start_time": "2026-04-01T20:00:00+00:00",
            "end_time": "2026-04-01T20:20:00+00:00",
            "exercises": [
                {
                    "title": "Stationary Bike",
                    "sets": [
                        {"type": "normal", "duration_seconds": 1200},
                    ],
                }
            ],
        }
        desc = generate_description(workout)
        assert "Stationary Bike" in desc
        assert "20min" in desc

    def test_empty_exercises(self) -> None:
        workout = {
            "title": "Empty",
            "start_time": "2026-04-01T20:00:00+00:00",
            "end_time": "2026-04-01T20:10:00+00:00",
            "exercises": [],
        }
        desc = generate_description(workout)
        assert "Empty" in desc
        assert "hevy2garmin" in desc

    def test_special_characters_in_name(self) -> None:
        workout = {
            "title": "Test",
            "start_time": "2026-04-01T20:00:00+00:00",
            "end_time": "2026-04-01T20:30:00+00:00",
            "exercises": [
                {
                    "title": "André's Über-Exercise™ (50% off!)",
                    "sets": [
                        {"type": "normal", "weight_kg": 40, "reps": 10},
                    ],
                }
            ],
        }
        desc = generate_description(workout)
        assert "André's Über-Exercise™" in desc

    def test_no_calories_no_hr(self) -> None:
        workout = {
            "title": "Minimal",
            "start_time": "2026-04-01T20:00:00+00:00",
            "end_time": "2026-04-01T20:10:00+00:00",
            "exercises": [],
        }
        desc = generate_description(workout)
        assert "kcal" not in desc
        assert "bpm" not in desc

    def test_mixed_cardio_and_strength(self) -> None:
        workout = {
            "title": "Mixed",
            "start_time": "2026-04-01T20:00:00+00:00",
            "end_time": "2026-04-01T21:00:00+00:00",
            "exercises": [
                {
                    "title": "Bench Press",
                    "sets": [
                        {"type": "normal", "weight_kg": 80, "reps": 8},
                        {"type": "normal", "weight_kg": 80, "reps": 6},
                    ],
                },
                {
                    "title": "Treadmill",
                    "sets": [
                        {"type": "normal", "distance_meters": 3000, "duration_seconds": 900},
                    ],
                },
            ],
        }
        desc = generate_description(workout)
        assert "80.0kg" in desc
        assert "3.0km" in desc
