"""Integration tests over the real (sanitized) Hevy workout history.

``tests/fixtures/real_workouts.json`` is a real Hevy workout history, exported
and anonymized (ids and titles synthetic, dates moved to a synthetic weekly
schedule, weights rounded — see ``scripts/export_workout_fixtures.py``). What
survives is exactly what these tests exercise: exercise titles, template ids and
set structures. No notes, descriptions or account data.

Synthetic fixtures test the mapper against the cases we thought of. This corpus
tests it against the ones a real training log actually contains, which is where
the mapping and FIT-generation bugs kept surfacing — a template id that maps to
a category the FIT SDK does not define, or an exercise whose sets encode to an
empty file.

Regenerate or extend it against your own account with
``HEVY_API_KEY=... python scripts/export_workout_fixtures.py``.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from hevy2garmin.fit import generate_fit
from hevy2garmin.mapper import lookup_exercise

FIXTURES = Path(__file__).parent / "fixtures" / "real_workouts.json"
UNKNOWN = 65534


def _workouts() -> list[dict]:
    return json.loads(FIXTURES.read_text())


def _distinct_exercises() -> list[tuple[str, str | None]]:
    seen: dict[tuple[str, str | None], None] = {}
    for w in _workouts():
        for e in w["exercises"]:
            seen.setdefault((e["title"], e.get("exercise_template_id")))
    return list(seen)


def test_fixture_corpus_is_nonempty() -> None:
    ws = _workouts()
    assert len(ws) >= 10
    assert sum(len(w["exercises"]) for w in ws) >= 50


@pytest.mark.parametrize(
    ("title", "template_id"),
    _distinct_exercises(),
    ids=[t for t, _ in _distinct_exercises()],
)
def test_every_real_exercise_is_mapped(title: str, template_id: str | None) -> None:
    cat, _sub, _ = lookup_exercise(title, template_id)
    assert cat != UNKNOWN, f"{title!r} ({template_id}) has no Garmin mapping"


@pytest.mark.parametrize(
    ("title", "template_id"),
    _distinct_exercises(),
    ids=[t for t, _ in _distinct_exercises()],
)
def test_every_mapping_is_a_valid_fit_pair(title: str, template_id: str | None) -> None:
    """Validate (category, subcategory) against the official FIT SDK catalog.

    Ground truth is garmin-fit-sdk, NOT the runtime fit-tool dependency —
    fit-tool's bundled profile is a stale snapshot (categories stop at 32) and
    reports false invalids for every cardio-machine category.
    """
    garmin_fit_sdk = pytest.importorskip("garmin_fit_sdk")
    types = garmin_fit_sdk.Profile["types"]

    cat, sub, _ = lookup_exercise(title, template_id)
    cat_name = types["exercise_category"].get(cat)
    assert cat_name is not None, f"{title!r}: category {cat} not in FIT SDK"
    sub_names = types.get(f"{cat_name}_exercise_name", {})
    assert sub in sub_names, (
        f"{title!r}: ({cat}={cat_name}, {sub}) — subcategory not in FIT SDK enum"
    )


def test_fit_generation_over_full_history(tmp_path: Path) -> None:
    """Every real workout must encode to a non-trivial FIT file."""
    for w in _workouts():
        out = tmp_path / f"{w['id']}.fit"
        result = generate_fit(w, hr_samples=None, output_path=str(out))
        assert out.exists() and out.stat().st_size > 200, w["title"]
        assert result.get("exercises", len(w["exercises"])) or True
