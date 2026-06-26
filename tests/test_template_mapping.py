"""Language-independent mapping via Hevy exercise_template_id (#173)."""
from __future__ import annotations
import hevy2garmin.mapper as m
from hevy2garmin.mapper import lookup_exercise
from hevy2garmin.template_map import TEMPLATE_TO_GARMIN

# A stable global template id present in the generated map.
_TID, _PAIR = next(iter(TEMPLATE_TO_GARMIN.items()))


def test_template_map_nonempty():
    assert len(TEMPLATE_TO_GARMIN) > 300


def test_localized_name_resolves_via_template_id():
    # A name the English table does not know, but with a valid template id.
    cat, sub, _ = lookup_exercise("Eine Nicht Englische Übung", _TID)
    assert (cat, sub) == _PAIR


def test_english_name_still_resolves_without_template():
    cat, sub, _ = lookup_exercise("Bench Press (Barbell)")
    assert cat != 65534


def test_unknown_without_template_is_unmapped():
    assert lookup_exercise("Totally Made Up 9000")[0] == 65534


def test_unknown_template_falls_back_to_name():
    cat, sub, _ = lookup_exercise("Bench Press (Barbell)", "ZZZZZZZZ")
    assert cat != 65534  # unknown tid ignored, name match used


def test_custom_mapping_beats_template():
    m._custom_mappings["My Lift"] = (99, 7)
    try:
        assert lookup_exercise("My Lift", _TID)[:2] == (99, 7)
    finally:
        m._custom_mappings.pop("My Lift", None)
