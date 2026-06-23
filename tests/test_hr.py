"""Tests for HR sourcing + merging and HR embedding in the FIT (#158)."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import pytest

from fit_tool.fit_file import FitFile
from fit_tool.profile.messages.record_message import RecordMessage

from hevy2garmin.hr import (
    build_workout_hr,
    extract_hevy_hr,
    fetch_watch_hr,
    merge_hr_sources,
)
from hevy2garmin.fit import generate_fit


# --- merge_hr_sources -------------------------------------------------------

class TestMergeHRSources:
    def test_primary_wins_per_bucket(self):
        primary = [{"time": 0, "hr": 150}, {"time": 10, "hr": 160}]   # AirPods
        secondary = [{"time": 0, "hr": 90}, {"time": 10, "hr": 95}]   # watch
        merged = merge_hr_sources(primary, secondary)
        assert {s["hr"] for s in merged} == {150, 160}  # AirPods wins both buckets

    def test_secondary_fills_gaps(self):
        primary = [{"time": 0, "hr": 150}]                 # AirPods only at start
        secondary = [{"time": 0, "hr": 90}, {"time": 60, "hr": 100}]  # watch covers later
        merged = merge_hr_sources(primary, secondary)
        hrs = [s["hr"] for s in merged]
        assert 150 in hrs        # AirPods kept where present
        assert 100 in hrs        # watch fills the gap at t=60

    def test_empty_primary_returns_secondary(self):
        secondary = [{"time": 5, "hr": 88}]
        assert merge_hr_sources([], secondary) == secondary

    def test_both_empty(self):
        assert merge_hr_sources([], []) == []

    def test_output_sorted_by_time(self):
        merged = merge_hr_sources(
            [{"time": 120, "hr": 150}],
            [{"time": 0, "hr": 90}, {"time": 60, "hr": 95}],
        )
        times = [s["time"] for s in merged]
        assert times == sorted(times)


# --- extract_hevy_hr --------------------------------------------------------

class TestExtractHevyHR:
    def test_standard_hevy_workout_has_no_hr(self):
        # The Hevy public API exposes no HR — sets carry only weight/reps/etc.
        workout = {"exercises": [{"sets": [{"weight": 60, "reps": 10}]}]}
        assert extract_hevy_hr(workout) == []

    def test_parses_future_hr_field_dicts(self):
        workout = {"heart_rate": [{"time": 5, "hr": 140}, {"time": 0, "hr": 130}]}
        assert extract_hevy_hr(workout) == [{"time": 0, "hr": 130}, {"time": 5, "hr": 140}]

    def test_parses_future_hr_field_pairs(self):
        workout = {"hr_samples": [[0, 130], [10, 145]]}
        assert extract_hevy_hr(workout) == [{"time": 0, "hr": 130}, {"time": 10, "hr": 145}]


# --- fetch_watch_hr ---------------------------------------------------------

class TestFetchWatchHR:
    def _workout(self):
        return {"start_time": "2026-03-15T18:00:00+00:00", "end_time": "2026-03-15T18:10:00+00:00"}

    def test_slices_to_window(self):
        w = self._workout()
        import datetime as dt
        start_ms = int(dt.datetime.fromisoformat(w["start_time"]).timestamp() * 1000)
        client = MagicMock()
        # one sample inside the window, one way outside
        client.get_heart_rates.return_value = {
            "heartRateValues": [
                [start_ms + 60_000, 120],          # inside (t=60s)
                [start_ms + 999_000_000, 200],     # far outside → dropped
            ]
        }
        samples = fetch_watch_hr(client, w)
        assert samples == [{"time": 60.0, "hr": 120}]

    def test_failure_returns_empty(self):
        client = MagicMock()
        client.get_heart_rates.side_effect = RuntimeError("rate limited")
        assert fetch_watch_hr(client, self._workout()) == []

    def test_missing_timestamps_returns_empty(self):
        client = MagicMock()
        assert fetch_watch_hr(client, {"start_time": "", "end_time": ""}) == []


# --- end-to-end: HR actually lands in the FIT -------------------------------

def _hr_count_in_fit(path: str) -> int:
    fit = FitFile.from_file(path)
    n = 0
    for record in fit.records:
        msg = record.message
        if isinstance(msg, RecordMessage) and getattr(msg, "heart_rate", None) is not None:
            n += 1
    return n


class TestHREmbeddedInFit:
    WORKOUT = {
        "title": "Push",
        "start_time": "2026-03-15T18:00:00+00:00",
        "end_time": "2026-03-15T18:10:00+00:00",
        "exercises": [
            {"title": "Bench Press (Barbell)", "sets": [{"type": "normal", "weight_kg": 60, "reps": 10}]},
        ],
    }
    PROFILE = {"weight_kg": 78.0, "birth_year": 1994, "vo2max": 50.0}

    def test_timestamped_hr_written_to_fit(self, tmp_path: Path):
        path = str(tmp_path / "w.fit")
        hr = [{"time": 0, "hr": 110}, {"time": 120, "hr": 130}, {"time": 480, "hr": 150}]
        result = generate_fit(self.WORKOUT, hr_samples=hr, output_path=path, profile=self.PROFILE)
        assert result["hr_samples"] == 3
        assert result["avg_hr"] == 130
        assert _hr_count_in_fit(path) == 3  # HR records actually in the FIT

    def test_plain_bpm_list_still_works(self, tmp_path: Path):
        path = str(tmp_path / "w.fit")
        result = generate_fit(self.WORKOUT, hr_samples=[100, 110, 120], output_path=path, profile=self.PROFILE)
        assert result["hr_samples"] == 3
        assert _hr_count_in_fit(path) == 3

    def test_none_writes_no_hr(self, tmp_path: Path):
        path = str(tmp_path / "w.fit")
        result = generate_fit(self.WORKOUT, hr_samples=None, output_path=path, profile=self.PROFILE)
        assert result["hr_samples"] == 0
        assert _hr_count_in_fit(path) == 0
