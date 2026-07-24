"""Tests for HR sourcing + merging and HR embedding in the FIT (#158)."""

from __future__ import annotations

import io
from pathlib import Path
from unittest.mock import MagicMock, patch
import zipfile

import pytest

from fit_tool.fit_file import FitFile
from fit_tool.profile.messages.record_message import RecordMessage

from hevy2garmin.hr import (
    HRBackupError,
    backup_activity_hr,
    build_workout_hr,
    extract_hevy_hr,
    fetch_activity_hr,
    fetch_watch_hr,
    hr_for_sync,
    load_hr_backup,
    merge_hr_sources,
    save_hr_backup,
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


# --- fetch_activity_hr ------------------------------------------------------

class TestFetchActivityHR:
    WORKOUT = {
        "title": "Push",
        "start_time": "2026-03-15T18:00:00+00:00",
        "end_time": "2026-03-15T18:10:00+00:00",
        "exercises": [
            {"title": "Bench Press (Barbell)", "sets": [{"type": "normal", "weight_kg": 60, "reps": 10}]},
        ],
    }

    def _zipped_activity(self, tmp_path: Path) -> bytes:
        fit_path = tmp_path / "activity.fit"
        generate_fit(
            self.WORKOUT,
            hr_samples=[
                {"time": 0, "hr": 110},
                {"time": 120, "hr": 130},
                {"time": 480, "hr": 150},
            ],
            output_path=str(fit_path),
        )
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            archive.writestr("123_ACTIVITY.fit", fit_path.read_bytes())
        return output.getvalue()

    def test_extracts_timestamped_hr_from_original_zip(self, tmp_path: Path):
        client = MagicMock()
        client.download_activity.return_value = self._zipped_activity(tmp_path)

        samples = fetch_activity_hr(client, 123, self.WORKOUT)

        assert samples == [
            {"time": 0.0, "hr": 110},
            {"time": 120.0, "hr": 130},
            {"time": 480.0, "hr": 150},
        ]

    def test_extracts_hr_even_when_outside_hevy_window(self, tmp_path: Path):
        # Regression #244: the watch activity's clock can differ from the Hevy
        # log by more than a few minutes. The downloaded FIT is the watch's own
        # single recording of this workout, so every HR record must be extracted
        # regardless of the Hevy window (the old strict-window filter dropped
        # them all, breaking Replace).
        shifted = {
            **self.WORKOUT,
            "start_time": "2026-03-15T18:30:00+00:00",  # 30 min after the fetch window
            "end_time": "2026-03-15T18:40:00+00:00",
        }
        fit_path = tmp_path / "activity.fit"
        generate_fit(
            shifted,
            hr_samples=[{"time": 0, "hr": 111}, {"time": 300, "hr": 145}],
            output_path=str(fit_path),
        )
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            archive.writestr("123_ACTIVITY.fit", fit_path.read_bytes())
        client = MagicMock()
        client.download_activity.return_value = output.getvalue()

        # Fetch with the ORIGINAL window, 30 min earlier than the FIT's HR.
        samples = fetch_activity_hr(client, 123, self.WORKOUT)

        assert [s["hr"] for s in samples] == [111, 145]
        assert all(s["time"] >= 0 for s in samples)

    def test_fit_string_decode_tolerates_non_utf8_bytes(self):
        # Regression #244: a device FIT (first seen on a Fenix 7 Pro) carried a
        # non-UTF-8 byte in a string field, and fit-tool's strict UTF-8 decode
        # raised UnicodeDecodeError, aborting the whole parse and losing all HR.
        # The lenient shim must let the parse through.
        from fit_tool.base_type import BaseType
        from fit_tool.field import Field

        from hevy2garmin.hr import _patch_fit_tool_lenient_strings

        _patch_fit_tool_lenient_strings()
        field = Field(name="product", field_id=0, base_type=BaseType.STRING)
        # "Garmin" <0x9f> NUL "Fenix" NUL — the 0x9f is the invalid start byte.
        buf = b"Garmin" + bytes([0x9F, 0]) + b"Fenix" + bytes([0])
        field.read_strings_from_bytes(buf)  # must not raise
        assert any("Fenix" in v for v in field.encoded_values)

    def test_falls_back_to_daily_hr_when_original_download_fails(self):
        client = MagicMock()
        client.download_activity.side_effect = RuntimeError("not downloadable")
        import datetime as dt
        start_ms = int(dt.datetime.fromisoformat(self.WORKOUT["start_time"]).timestamp() * 1000)
        client.get_heart_rates.return_value = {
            "heartRateValues": [[start_ms + 60_000, 120]]
        }

        samples = build_workout_hr(client, self.WORKOUT, source_activity_id=123)

        assert samples == [{"time": 60.0, "hr": 120}]


# --- durable HR backup ------------------------------------------------------

class TestHRBackup:
    WORKOUT = {
        "id": "w1",
        "start_time": "2026-03-15T18:00:00+00:00",
        "end_time": "2026-03-15T18:10:00+00:00",
    }

    def test_saves_activity_samples_with_source_metadata(self):
        database = MagicMock()
        database.get_app_config.return_value = None
        samples = [{"time": 0.0, "hr": 100}, {"time": 1.0, "hr": 101}]

        payload = save_hr_backup(database, self.WORKOUT, samples, 123)

        assert payload["sample_count"] == 2
        assert payload["source_activity_id"] == "123"
        database.set_app_config.assert_called_once()
        assert database.set_app_config.call_args.args[0] == "hr_backup_w1"

    def test_denser_backup_is_not_overwritten(self):
        database = MagicMock()
        existing = {"sample_count": 100, "hr_samples": [{"time": 0, "hr": 90}]}
        database.get_app_config.return_value = existing

        result = save_hr_backup(
            database,
            self.WORKOUT,
            [{"time": 0, "hr": 100}],
            456,
        )

        assert result is existing
        database.set_app_config.assert_not_called()

    def test_load_rebases_samples_after_hevy_start_edit(self):
        database = MagicMock()
        database.get_app_config.return_value = {
            "workout_start": "2026-03-15T18:00:00+00:00",
            "sample_count": 2,
            "hr_samples": [
                {"time": 30, "hr": 100},
                {"time": 120, "hr": 110},
            ],
        }
        edited = {
            **self.WORKOUT,
            "start_time": "2026-03-15T18:01:00+00:00",
        }

        samples = load_hr_backup(database, edited)

        # The 18:00:30 sample is before the edited start and is clipped. The
        # 18:02:00 sample moves from offset 120s to offset 60s.
        assert samples == [{"time": 60.0, "hr": 110}]

    @patch("hevy2garmin.hr.fetch_activity_hr")
    def test_hr_for_sync_persists_activity_hr(self, fetch_activity):
        fetch_activity.return_value = [{"time": 0, "hr": 100}]
        database = MagicMock()
        database.get_app_config.return_value = None

        result = hr_for_sync(
            database,
            MagicMock(),
            self.WORKOUT,
            {"hr_fusion": {"enabled": True}},
            source_activity_id=123,
        )

        assert result == [{"time": 0, "hr": 100}]
        database.set_app_config.assert_called_once()

    @patch("hevy2garmin.hr.fetch_activity_hr", return_value=[])
    def test_hr_for_sync_restores_backup_when_source_is_gone(self, _fetch):
        database = MagicMock()
        database.get_app_config.return_value = {
            "workout_start": self.WORKOUT["start_time"],
            "sample_count": 1,
            "hr_samples": [{"time": 5, "hr": 105}],
        }

        result = hr_for_sync(
            database,
            MagicMock(),
            self.WORKOUT,
            {"hr_fusion": {"enabled": True}},
            source_activity_id=123,
        )

        assert result == [{"time": 5.0, "hr": 105}]

    @patch("hevy2garmin.hr.fetch_activity_hr", return_value=[])
    def test_replacement_stops_without_source_hr_or_backup(self, _fetch):
        database = MagicMock()
        database.get_app_config.return_value = None
        database.get_cached_hr.return_value = {
            "hr_samples": [{"time": 0, "hr": 90}]
        }

        with pytest.raises(HRBackupError, match="source activity preserved"):
            hr_for_sync(
                database,
                MagicMock(),
                self.WORKOUT,
                {"hr_fusion": {"enabled": True}},
                source_activity_id=123,
            )

    @patch("hevy2garmin.hr.fetch_activity_hr")
    def test_hr_for_sync_prefers_denser_backup_over_coarse_download(self, fetch_activity):
        fetch_activity.return_value = [{"time": 0, "hr": 90}]
        database = MagicMock()
        database.get_app_config.return_value = {
            "workout_start": self.WORKOUT["start_time"],
            "sample_count": 2,
            "hr_samples": [
                {"time": 0, "hr": 100},
                {"time": 1, "hr": 101},
            ],
        }

        result = hr_for_sync(
            database,
            MagicMock(),
            self.WORKOUT,
            {"hr_fusion": {"enabled": True}},
            source_activity_id=123,
        )

        assert result == [
            {"time": 0.0, "hr": 100},
            {"time": 1.0, "hr": 101},
        ]

    @patch("hevy2garmin.hr.fetch_activity_hr")
    def test_backup_write_failure_is_not_silenced(self, fetch_activity):
        fetch_activity.return_value = [{"time": 0, "hr": 100}]
        database = MagicMock()
        database.get_app_config.return_value = None
        database.set_app_config.side_effect = RuntimeError("database readonly")

        with pytest.raises(HRBackupError, match="could not back up HR"):
            backup_activity_hr(
                database,
                MagicMock(),
                self.WORKOUT,
                source_activity_id=123,
            )


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
