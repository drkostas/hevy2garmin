"""Mapped exercises must leave the unmapped list immediately (#172)."""
from __future__ import annotations
from unittest.mock import MagicMock, patch
from hevy2garmin.pages import _get_unmapped_exercises, invalidate_unmapped_cache


def test_filters_out_now_mapped_exercises():
    fake_db = MagicMock()
    fake_db.get_app_config.return_value = {
        "Totally Invented Movement 9000": 3,  # genuinely unmapped
        "Bench Press (Barbell)": 2,           # has a built-in mapping
    }
    with patch("hevy2garmin.db.get_db", return_value=fake_db):
        result = _get_unmapped_exercises()
    names = [n for n, _ in result]
    assert "Totally Invented Movement 9000" in names
    assert "Bench Press (Barbell)" not in names


def test_custom_mapped_exercise_is_filtered():
    import hevy2garmin.mapper as m
    m._custom_mappings["Seitheben (Kurzhantel)"] = (14, 11)  # just mapped
    try:
        fake_db = MagicMock()
        fake_db.get_app_config.return_value = {"Seitheben (Kurzhantel)": 1}
        with patch("hevy2garmin.db.get_db", return_value=fake_db):
            result = _get_unmapped_exercises()
        assert all(n != "Seitheben (Kurzhantel)" for n, _ in result)
    finally:
        m._custom_mappings.pop("Seitheben (Kurzhantel)", None)


def test_invalidate_cache_forces_a_fresh_local_lookup():
    import hevy2garmin.pages as pages

    pages._unmapped_cache = [("stale", 1)]
    pages._unmapped_cache_time = 10**20
    invalidate_unmapped_cache()
    assert pages._unmapped_cache is None
    assert pages._unmapped_cache_time == 0
