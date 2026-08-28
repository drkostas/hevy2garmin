"""Tests for the dashboard HR endpoint's daily-HR slicing (#326).

Garmin returns ``{"heartRateValues": null}`` for a day with no wellness HR yet
(the current day, before all-day HR is populated). The endpoint used to iterate
that value directly and crash with "'NoneType' object is not iterable"; these
tests lock in the guard.
"""

from __future__ import annotations

from hevy2garmin.pages import _daily_hr_to_samples


class TestDailyHrToSamples:
    def test_null_heart_rate_values_returns_empty(self) -> None:
        # Regression for #326: key present but value None must not crash.
        assert _daily_hr_to_samples({"heartRateValues": None}, 0, 60_000) == []

    def test_missing_key_returns_empty(self) -> None:
        assert _daily_hr_to_samples({}, 0, 60_000) == []

    def test_non_dict_returns_empty(self) -> None:
        assert _daily_hr_to_samples(None, 0, 60_000) == []

    def test_slices_to_window_and_skips_none_bpm(self) -> None:
        start_ms, end_ms = 1_000_000, 1_060_000  # 60s window
        daily_hr = {
            "heartRateValues": [
                [start_ms - 120_000, 70],   # before window (−2 min) → excluded
                [start_ms + 10_000, 110],   # in window → included, t=10s
                [start_ms + 30_000, None],  # None bpm → skipped
                [start_ms + 50_000, 120],   # in window → included, t=50s
                [end_ms + 120_000, 80],     # after window (+2 min) → excluded
            ]
        }
        out = _daily_hr_to_samples(daily_hr, start_ms, end_ms)
        assert out == [{"time": 10.0, "hr": 110}, {"time": 50.0, "hr": 120}]

    def test_empty_list_returns_empty(self) -> None:
        assert _daily_hr_to_samples({"heartRateValues": []}, 0, 60_000) == []
