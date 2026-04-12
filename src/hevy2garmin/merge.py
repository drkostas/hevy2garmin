"""Merge mode: push Hevy exercise data into user-recorded Garmin activities.

When a user records a Strength Training on their Garmin watch at the gym,
this module detects the matching activity and PUTs Hevy's exercise/set data
into it via the exerciseSets API. The watch's 1-second HR, training effect,
EPOC, and recovery stay intact.

Public API:
    attempt_merge(client, hevy_workout, db) -> MergeResult
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from hevy2garmin.garmin import (
    find_matching_garmin_activity,
    generate_description,
    get_activity_exercise_sets,
    push_exercise_sets,
    rename_activity,
    set_description,
)
from hevy2garmin.mapper import lookup_exercise

logger = logging.getLogger("hevy2garmin")

# Circuit breaker: disable merge after N consecutive PUT failures
_MAX_CONSECUTIVE_FAILURES = 3
_consecutive_failures = 0


@dataclass
class MergeResult:
    """Result of a merge attempt."""
    merged: bool
    activity_id: int | None = None
    fallback_reason: str | None = None


def reset_circuit_breaker() -> None:
    """Reset the failure counter (call at start of each sync run)."""
    global _consecutive_failures
    _consecutive_failures = 0


def _circuit_breaker_tripped() -> bool:
    return _consecutive_failures >= _MAX_CONSECUTIVE_FAILURES


# ---------------------------------------------------------------------------
# Category int → string conversion
# ---------------------------------------------------------------------------

# FIT SDK exercise category IDs → Garmin API string names.
# These are the categories from the FIT SDK profile, used in the
# exerciseSets PUT payload.
_CATEGORY_NAMES: dict[int, str] = {
    0: "BENCH_PRESS", 1: "CALF_RAISE", 2: "CARDIO", 3: "CARRY",
    4: "CHOP", 5: "CORE", 6: "CRUNCH", 7: "CURL", 8: "DEADLIFT",
    9: "FLYE", 10: "HIP_RAISE", 11: "HIP_STABILITY", 12: "HIP_SWING",
    13: "HYPEREXTENSION", 14: "LATERAL_RAISE", 15: "LEG_CURL",
    16: "LEG_RAISE", 17: "LUNGE", 18: "OLYMPIC_LIFT", 19: "PLANK",
    20: "PLYO", 21: "PULL_UP", 22: "PUSH_UP", 23: "ROW",
    24: "SHOULDER_PRESS", 25: "SHOULDER_STABILITY", 26: "SHRUG",
    27: "SIT_UP", 28: "SQUAT", 29: "TOTAL_BODY",
    30: "TRICEPS_EXTENSION", 31: "WARM_UP", 32: "RUN",
    65534: "UNKNOWN",
}

# Subcategory names per category. Built from the FIT SDK profile.
# Only the most common ones are listed — unmapped subs fall back to
# the category's generic "0" name.
# Format: {(category_id, subcategory_id): "GARMIN_STRING_NAME"}
#
# We populate this lazily from fit_tool if available, otherwise
# use the category name as the exercise name (Garmin accepts this).

def _category_to_string(cat_id: int) -> str:
    return _CATEGORY_NAMES.get(cat_id, "UNKNOWN")


def _exercise_to_string(cat_id: int, sub_id: int) -> str:
    """Convert FIT category + subcategory IDs to Garmin exercise name string.

    Falls back to the category name if the subcategory isn't mapped.
    Garmin's exerciseSets API accepts the category name as the exercise name.
    """
    try:
        from fit_tool.profile.profile_type import ExerciseCategory
        # fit_tool has per-category exercise enums, but they're not always
        # available or complete. Try to get the string name.
        cat_enum = ExerciseCategory(cat_id)
        # Look for a subcategory enum for this category
        # e.g., for BENCH_PRESS (0), there's BenchPressExerciseName
        cat_name = cat_enum.name  # "BENCH_PRESS"
        # The subcategory enum class name follows a pattern
        sub_enum_name = cat_name.title().replace("_", "") + "ExerciseName"
        import fit_tool.profile.profile_type as pt
        sub_enum_cls = getattr(pt, sub_enum_name, None)
        if sub_enum_cls:
            return sub_enum_cls(sub_id).name
    except (ValueError, AttributeError, ImportError):
        pass
    # Fallback: use category name (Garmin accepts this)
    return _category_to_string(cat_id)


# ---------------------------------------------------------------------------
# Payload builder
# ---------------------------------------------------------------------------

def build_exercise_sets_payload(
    hevy_workout: dict,
    activity_id: int,
    activity_start_time: str,
    activity_duration_s: float,
) -> dict:
    """Convert a Hevy workout into a Garmin exerciseSets PUT payload.

    Uses the matched Garmin activity's actual start time and duration
    to distribute set timestamps across the real activity timeline.

    Args:
        hevy_workout: Hevy workout dict with exercises and sets.
        activity_id: Garmin activity ID.
        activity_start_time: Garmin activity's startTimeGMT (ISO or space-separated).
        activity_duration_s: Garmin activity's duration in seconds.
    """
    # Parse activity start
    start_str = activity_start_time.replace(" ", "T")
    if "+" not in start_str and not start_str.endswith("Z"):
        start_str += "+00:00"
    act_start = datetime.fromisoformat(start_str.replace("Z", "+00:00"))

    exercises = hevy_workout.get("exercises", [])
    if not exercises:
        return {"activityId": activity_id, "exerciseSets": []}

    # Profile timing defaults (same as fit.py uses)
    working_set_s = 40
    warmup_set_s = 25
    rest_sets_s = 75
    rest_exercises_s = 120

    # Count total sets and compute ideal duration for scaling
    all_sets: list[dict] = []
    for ex_idx, ex in enumerate(exercises):
        sets = ex.get("sets", [])
        for s_idx, s in enumerate(sets):
            is_warmup = s.get("type", "normal") == "warmup"
            explicit_dur = s.get("duration_seconds")
            if explicit_dur and explicit_dur > 0:
                set_dur = float(explicit_dur)
            else:
                set_dur = warmup_set_s if is_warmup else working_set_s

            is_last_set = s_idx == len(sets) - 1
            is_last_exercise = ex_idx == len(exercises) - 1
            if is_last_set and is_last_exercise:
                rest_dur = 0.0
            elif is_last_set:
                rest_dur = rest_exercises_s
            else:
                rest_dur = rest_sets_s

            all_sets.append({
                "ex_idx": ex_idx,
                "set_data": s,
                "set_dur": set_dur,
                "rest_dur": rest_dur,
            })

    # Scale to fit actual activity duration
    ideal_total = sum(si["set_dur"] + si["rest_dur"] for si in all_sets)
    scale = activity_duration_s / ideal_total if ideal_total > 0 else 1.0
    scale = max(0.3, min(2.0, scale))

    # Build exercise sets
    exercise_sets: list[dict] = []
    msg_idx = 0
    cursor_s = 0.0

    for si in all_sets:
        s = si["set_data"]
        ex_idx = si["ex_idx"]
        ex = exercises[ex_idx]

        cat_id, sub_id, _ = lookup_exercise(ex.get("title") or ex.get("name", "Unknown"))
        cat_str = _category_to_string(cat_id)
        ex_str = _exercise_to_string(cat_id, sub_id)
        # Garmin rejects UNKNOWN category — fall back to TOTAL_BODY
        if cat_str == "UNKNOWN":
            cat_str = "TOTAL_BODY"
            ex_str = "TOTAL_BODY"

        set_start = act_start + timedelta(seconds=cursor_s)
        scaled_dur = si["set_dur"] * scale

        # Active set
        reps = s.get("reps")
        weight_kg = s.get("weight_kg")

        active_set: dict = {
            "exercises": [{"category": cat_str, "name": ex_str}],
            "duration": round(scaled_dur, 3),
            "repetitionCount": int(reps) if reps is not None else 0,
            "weight": float(round(weight_kg * 1000)) if weight_kg else 0.0,
            "setType": "ACTIVE",
            "startTime": set_start.strftime("%Y-%m-%dT%H:%M:%S.0"),
            "wktStepIndex": ex_idx,
            "messageIndex": msg_idx,
        }
        exercise_sets.append(active_set)
        msg_idx += 1
        cursor_s += scaled_dur

        # Rest set (if applicable)
        if si["rest_dur"] > 0:
            rest_start = act_start + timedelta(seconds=cursor_s)
            scaled_rest = si["rest_dur"] * scale
            rest_set: dict = {
                "exercises": [],
                "duration": round(scaled_rest, 3),
                "setType": "REST",
                "startTime": rest_start.strftime("%Y-%m-%dT%H:%M:%S.0"),
                "wktStepIndex": ex_idx,
                "messageIndex": msg_idx,
            }
            exercise_sets.append(rest_set)
            msg_idx += 1
            cursor_s += scaled_rest

    return {"activityId": activity_id, "exerciseSets": exercise_sets}


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------

def attempt_merge(client, hevy_workout: dict, database, overlap_threshold: float = 0.70, max_drift_minutes: int = 20) -> MergeResult:
    """Try to merge Hevy exercise data into a matching Garmin activity.

    Returns MergeResult with merged=True if successful, or merged=False
    with a fallback_reason explaining why (no match, circuit breaker, etc.)
    """
    global _consecutive_failures

    if _circuit_breaker_tripped():
        return MergeResult(merged=False, fallback_reason="Circuit breaker: too many PUT failures")

    # Find matching activity
    match = find_matching_garmin_activity(client, hevy_workout, overlap_threshold=overlap_threshold, max_drift_minutes=max_drift_minutes)
    if not match:
        return MergeResult(merged=False, fallback_reason="No matching Garmin activity found")

    activity_id = match.get("activityId")
    act_start = match.get("startTimeGMT") or match.get("startTimeLocal", "")
    act_duration = match.get("duration", 0)

    if not activity_id or not act_start or not act_duration:
        return MergeResult(merged=False, fallback_reason="Matched activity missing required fields")

    # Backup existing exercise sets
    try:
        existing_sets = get_activity_exercise_sets(client, activity_id)
        database.set_app_config(
            f"merge_backup_{activity_id}",
            {"activity_id": activity_id, "original_sets": existing_sets},
        )
    except Exception as e:
        logger.warning("Could not backup exercise sets for %s: %s", activity_id, e)
        # Continue anyway — backup is best-effort

    # Build payload
    title = hevy_workout.get("title", "Workout")
    payload = build_exercise_sets_payload(hevy_workout, activity_id, act_start, act_duration)

    # PUT exercise sets
    try:
        push_exercise_sets(client, activity_id, payload)
        _consecutive_failures = 0
    except Exception as e:
        _consecutive_failures += 1
        logger.error("PUT exerciseSets failed for activity %s: %s", activity_id, e)
        return MergeResult(merged=False, fallback_reason=f"PUT failed: {e}")

    # Rename + set description
    try:
        rename_activity(client, activity_id, title)
        desc = generate_description(hevy_workout)
        if not desc.endswith("— synced by hevy2garmin"):
            desc += "\n— synced by hevy2garmin"
        # Prepend merge note
        desc = "⚡ Exercises synced from Hevy by hevy2garmin\n\n" + desc
        set_description(client, activity_id, desc)
    except Exception as e:
        logger.warning("Rename/description failed after merge for %s: %s", activity_id, e)
        # Non-fatal — sets were already pushed

    return MergeResult(merged=True, activity_id=activity_id)
