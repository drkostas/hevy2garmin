"""Timezone -> FIT ``local_timestamp``: keep the correct local time on Strava.

Hevy hands us UTC-only timestamps, so with no configured zone we emit no
``local_timestamp`` (unchanged behaviour). With one, we stamp the activity's
local wall-clock time into the FIT so Garmin can forward the right offset to
Strava, which otherwise renders the raw UTC instant.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from fit_tool.fit_file import FitFile
from fit_tool.profile.messages.activity_message import ActivityMessage

from hevy2garmin.fit import generate_fit, _tz_offset_seconds, _FIT_EPOCH_S


def _workout(start_iso: str, end_iso: str) -> dict:
    return {
        "id": "tz-test",
        "title": "Push",
        "start_time": start_iso,
        "end_time": end_iso,
        "exercises": [
            {
                "index": 0,
                "title": "Bench Press (Barbell)",
                "exercise_template_id": "79D0BB3A",
                "sets": [{"index": 0, "type": "normal", "weight_kg": 60, "reps": 5}],
            }
        ],
    }


def _activity_msg(fit_path: str) -> ActivityMessage | None:
    for r in FitFile.from_file(fit_path).records:
        if isinstance(r.message, ActivityMessage):
            return r.message
    return None


def _embedded_offset_s(msg: ActivityMessage) -> int:
    """UTC offset (seconds) implied by local_timestamp vs the UTC timestamp."""
    return msg.local_timestamp - (msg.timestamp // 1000 - _FIT_EPOCH_S)


class TestTzOffsetHelper:
    def test_summer_offset(self) -> None:
        # Europe/Berlin is CEST (UTC+2) on 1 July.
        assert _tz_offset_seconds("Europe/Berlin", datetime(2026, 7, 1, tzinfo=timezone.utc)) == 7200

    def test_winter_offset(self) -> None:
        # Same zone is CET (UTC+1) on 1 January — the helper must be DST-aware.
        assert _tz_offset_seconds("Europe/Berlin", datetime(2026, 1, 1, tzinfo=timezone.utc)) == 3600

    def test_negative_offset(self) -> None:
        # America/New_York is EDT (UTC-4) on 1 July.
        assert _tz_offset_seconds("America/New_York", datetime(2026, 7, 1, tzinfo=timezone.utc)) == -4 * 3600

    def test_empty_zone_is_none(self) -> None:
        assert _tz_offset_seconds("", datetime(2026, 7, 1, tzinfo=timezone.utc)) is None

    def test_invalid_zone_is_none(self) -> None:
        assert _tz_offset_seconds("Not/AZone", datetime(2026, 7, 1, tzinfo=timezone.utc)) is None


class TestFitLocalTimestamp:
    def test_absent_without_timezone(self, sample_profile: dict, tmp_path) -> None:
        prof = dict(sample_profile)
        prof["timezone"] = ""  # explicit: no zone configured
        out = str(tmp_path / "w.fit")
        generate_fit(_workout("2026-07-01T12:00:00+00:00", "2026-07-01T12:45:00+00:00"), None, out, profile=prof)
        assert _activity_msg(out).local_timestamp is None

    def test_set_with_timezone_summer(self, sample_profile: dict, tmp_path) -> None:
        prof = dict(sample_profile)
        prof["timezone"] = "Europe/Berlin"
        out = str(tmp_path / "w.fit")
        generate_fit(_workout("2026-07-01T12:00:00+00:00", "2026-07-01T12:45:00+00:00"), None, out, profile=prof)
        assert _embedded_offset_s(_activity_msg(out)) == 7200

    def test_dst_winter_offset_differs(self, sample_profile: dict, tmp_path) -> None:
        prof = dict(sample_profile)
        prof["timezone"] = "Europe/Berlin"
        out = str(tmp_path / "w.fit")
        generate_fit(_workout("2026-01-01T12:00:00+00:00", "2026-01-01T12:45:00+00:00"), None, out, profile=prof)
        assert _embedded_offset_s(_activity_msg(out)) == 3600

    def test_invalid_timezone_does_not_crash_and_omits(self, sample_profile: dict, tmp_path) -> None:
        prof = dict(sample_profile)
        prof["timezone"] = "Not/AZone"
        out = str(tmp_path / "w.fit")
        generate_fit(_workout("2026-07-01T12:00:00+00:00", "2026-07-01T12:45:00+00:00"), None, out, profile=prof)
        assert _activity_msg(out).local_timestamp is None
