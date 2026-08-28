"""Shared fixtures for hevy2garmin tests."""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def isolate_user_config(monkeypatch, tmp_path: Path) -> None:
    """Keep every test away from the developer's real config directory.

    ``load_config`` and ``save_config`` resolve their module globals at call
    time, so patching the config module here also covers server/pages/autosync
    imports without requiring each test to remember a separate patch.
    Tests that need a specific file can still override these values locally.
    """
    from hevy2garmin import config

    config_dir = tmp_path / ".hevy2garmin"
    monkeypatch.setattr(config, "CONFIG_DIR", config_dir)
    monkeypatch.setattr(config, "CONFIG_FILE", config_dir / "config.json")

    # The DB module keeps a process singleton, and SQLite's default path is
    # evaluated when the class is imported. In local mode replace the singleton
    # itself so auth/rate-limit tests cannot write to the developer's real
    # sync.db. Leave it empty for the Postgres CI job so that dispatcher tests
    # still exercise the configured backend.
    from hevy2garmin import db
    from hevy2garmin.db_sqlite import SQLiteDatabase

    db.reset()
    if not db.get_database_url():
        monkeypatch.setattr(db, "_instance", SQLiteDatabase(tmp_path / "sync.db"))


@pytest.fixture
def tmp_config_dir(tmp_path: Path) -> Path:
    """Temp directory for config files."""
    d = tmp_path / ".hevy2garmin"
    d.mkdir()
    return d


@pytest.fixture
def sample_workout() -> dict:
    """A realistic Hevy workout dict."""
    return {
        "id": "test-workout-123",
        "title": "Push",
        "start_time": "2026-04-01T20:00:00+00:00",
        "end_time": "2026-04-01T20:45:00+00:00",
        "exercises": [
            {
                "index": 0,
                "title": "Bench Press (Barbell)",
                "exercise_template_id": "79D0BB3A",
                "sets": [
                    {"index": 0, "type": "warmup", "weight_kg": 40, "reps": 12},
                    {"index": 1, "type": "normal", "weight_kg": 60, "reps": 10},
                    {"index": 2, "type": "normal", "weight_kg": 60, "reps": 8},
                    {"index": 3, "type": "normal", "weight_kg": 60, "reps": 7},
                ],
            },
            {
                "index": 1,
                "title": "Shoulder Press (Dumbbell)",
                "exercise_template_id": "878CD1D0",
                "sets": [
                    {"index": 0, "type": "normal", "weight_kg": 14, "reps": 12},
                    {"index": 1, "type": "normal", "weight_kg": 14, "reps": 10},
                ],
            },
        ],
    }


@pytest.fixture
def sample_workout_unmapped() -> dict:
    """Workout with an unmapped exercise."""
    return {
        "id": "test-unmapped-456",
        "title": "Custom Day",
        "start_time": "2026-04-02T18:00:00+00:00",
        "end_time": "2026-04-02T18:30:00+00:00",
        "exercises": [
            {
                "index": 0,
                "title": "Invented Exercise 99",
                "sets": [
                    {"index": 0, "type": "normal", "weight_kg": 20, "reps": 10},
                ],
            },
        ],
    }


@pytest.fixture
def sample_profile() -> dict:
    """User profile for FIT generation."""
    return {
        "weight_kg": 78.0,
        "birth_year": 1994,
        "vo2max": 50.0,
        "working_set_s": 40,
        "warmup_set_s": 25,
        "rest_sets_s": 75,
        "rest_exercises_s": 120,
    }
