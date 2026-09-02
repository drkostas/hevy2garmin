#!/usr/bin/env python3
"""Regenerate tests/fixtures/real_workouts.json from the live Hevy account.

Fetches the complete workout history via the Hevy API and strips it down to
what the fixture tests need, then ANONYMIZES it — the repo is public, so no
personal training log may land in git:

- workout ids/titles become synthetic ("fixture-0000" / "Workout 01"),
- start times move to a synthetic weekly schedule (durations preserved),
- weights are rounded to 2.5 kg.

Exercise titles and template ids are Hevy's standard catalog names — they are
the data under test and stay verbatim.

Usage:
    HEVY_API_KEY=... python scripts/export_workout_fixtures.py
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

SET_KEYS = ("index", "type", "weight_kg", "reps", "distance_meters", "duration_seconds", "rpe")
OUT = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "real_workouts.json"


def anonymize(workouts: list[dict]) -> list[dict]:
    """Strip personal data while keeping every property the tests exercise."""
    base = datetime(2025, 1, 6, 18, 0, tzinfo=timezone.utc)  # an arbitrary Monday
    out = []
    for i, w in enumerate(sorted(workouts, key=lambda x: x["start_time"])):
        start = datetime.fromisoformat(w["start_time"].replace("Z", "+00:00"))
        end = datetime.fromisoformat(w["end_time"].replace("Z", "+00:00"))
        new_start = base + timedelta(days=7 * i)
        exercises = []
        for e in w["exercises"]:
            sets = []
            for s in e["sets"]:
                s2 = dict(s)
                if s2.get("weight_kg") is not None:
                    s2["weight_kg"] = round(s2["weight_kg"] / 2.5) * 2.5
                sets.append(s2)
            exercises.append({**e, "sets": sets})
        out.append(
            {
                "id": f"fixture-{i:04d}",
                "title": f"Workout {i + 1:02d}",
                "start_time": new_start.isoformat().replace("+00:00", "Z"),
                "end_time": (new_start + (end - start)).isoformat().replace("+00:00", "Z"),
                "exercises": exercises,
            }
        )
    return out


def main() -> int:
    api_key = os.environ.get("HEVY_API_KEY")
    if not api_key:
        print("HEVY_API_KEY not set", file=sys.stderr)
        return 1

    workouts: list[dict] = []
    page = 1
    while True:
        resp = requests.get(
            "https://api.hevyapp.com/v1/workouts",
            headers={"api-key": api_key},
            params={"page": page, "pageSize": 10},
            timeout=20,
        )
        resp.raise_for_status()
        data = resp.json()
        workouts.extend(data.get("workouts", []))
        if page >= data.get("page_count", 1):
            break
        page += 1

    sanitized = [
        {
            "id": w["id"],
            "title": w["title"],
            "start_time": w["start_time"],
            "end_time": w["end_time"],
            "exercises": [
                {
                    "index": e.get("index"),
                    "title": e.get("title"),
                    "exercise_template_id": e.get("exercise_template_id"),
                    "sets": [{k: s.get(k) for k in SET_KEYS} for s in e.get("sets", [])],
                }
                for e in w.get("exercises", [])
            ],
        }
        for w in workouts
    ]
    sanitized = anonymize(sanitized)

    OUT.write_text(json.dumps(sanitized, indent=1, ensure_ascii=False) + "\n")
    n_ex = sum(len(w["exercises"]) for w in sanitized)
    print(f"wrote {OUT.relative_to(Path.cwd()) if OUT.is_relative_to(Path.cwd()) else OUT}: "
          f"{len(sanitized)} workouts, {n_ex} exercises")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
