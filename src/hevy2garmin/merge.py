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
import time
from dataclasses import dataclass
from datetime import timedelta

from hevy2garmin._isotime import parse_iso
from hevy2garmin.garmin import (
    find_matching_garmin_activity,
    generate_description,
    get_activity_exercise_sets,
    push_exercise_sets,
    rename_activity,
    set_description,
)
from hevy2garmin.mapper import fit_exercise_strings, lookup_exercise

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
    # Set when the merge pushed sets but Garmin dropped the exercise names on a
    # watch-recorded activity (#159). Tells the caller to upload a SEPARATE
    # named activity instead of deduping against the watch activity.
    force_fresh_upload: bool = False
    # Watch activity id to delete AFTER a successful fresh upload, so the workout
    # ends up as a single named activity ("replace" strategy, #159).
    delete_after_upload: int | None = None


def _names_applied(client, activity_id) -> bool:
    """Check whether Garmin actually kept the exercise identities after a PUT.

    Watch-recorded strength activities accept the sets (HTTP 204) but silently
    drop the exercise category/name, leaving every set as "Choose an Exercise"
    (#159, confirmed live). Returns True if at least one active set came back
    with a real category, False if the names were dropped. Returns True on any
    read error so an unverifiable merge is not needlessly discarded.
    """
    time.sleep(4)  # let Garmin process the PUT before reading back
    try:
        after = get_activity_exercise_sets(client, activity_id)
    except Exception:  # noqa: BLE001  # unreadable sets after a push are treated as accepted
        return True
    cats = [
        e.get("category")
        for s in (after.get("exerciseSets") or [])
        if s.get("setType") == "ACTIVE"
        for e in (s.get("exercises") or [])
    ]
    if not cats:
        return False
    return any(c and c != "UNKNOWN" for c in cats)


def _restore_sets(client, activity_id, database) -> None:
    """Restore an activity's pre-merge exercise sets from the backup."""
    try:
        backup = database.get_app_config(f"merge_backup_{activity_id}")
        original = (backup or {}).get("original_sets")
        if original and original.get("exerciseSets") is not None:
            push_exercise_sets(client, activity_id, original)
    except Exception as e:  # noqa: BLE001  # best-effort Garmin step; the merge result does not depend on it
        logger.warning("Could not restore sets for %s: %s", activity_id, e)


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
    0: "BENCH_PRESS",
    1: "CALF_RAISE",
    2: "CARDIO",
    3: "CARRY",
    4: "CHOP",
    5: "CORE",
    6: "CRUNCH",
    7: "CURL",
    8: "DEADLIFT",
    9: "FLYE",
    10: "HIP_RAISE",
    11: "HIP_STABILITY",
    12: "HIP_SWING",
    13: "HYPEREXTENSION",
    14: "LATERAL_RAISE",
    15: "LEG_CURL",
    16: "LEG_RAISE",
    17: "LUNGE",
    18: "OLYMPIC_LIFT",
    19: "PLANK",
    20: "PLYO",
    21: "PULL_UP",
    22: "PUSH_UP",
    23: "ROW",
    24: "SHOULDER_PRESS",
    25: "SHOULDER_STABILITY",
    26: "SHRUG",
    27: "SIT_UP",
    28: "SQUAT",
    29: "TOTAL_BODY",
    30: "TRICEPS_EXTENSION",
    31: "WARM_UP",
    32: "RUN",
    65534: "UNKNOWN",
}


def _category_to_string(cat_id: int) -> str:
    return _CATEGORY_NAMES.get(cat_id, "UNKNOWN")


def _exercise_to_string(cat_id: int, sub_id: int) -> str | None:
    """Resolve FIT (category, subcategory) IDs to Garmin's subcategory enum name.

    Returns the valid subcategory string (e.g. ``"BARBELL_BENCH_PRESS"``) or
    ``None`` when it can't be resolved. We must NOT fall back to the parent
    category name: Garmin's ``exerciseSets`` API renders an unrecognised exercise
    *name* as **"Unknown"** (#138), whereas a ``null`` name under a valid parent
    category is accepted and shown as the category's generic label.
    """
    return fit_exercise_strings(cat_id, sub_id)[1]


def _strip_exercise_names(payload: dict) -> dict:
    """Return a copy of an exerciseSets payload with every exercise *name*
    removed but the category kept. Garmin always accepts a ``null`` name under a
    valid parent category, so this is the safe fallback when it rejects a
    specific ``(category, subcategory)`` pair."""
    stripped = dict(payload)
    stripped["exerciseSets"] = [
        {**s, "exercises": [{**ex, "name": None} for ex in s.get("exercises", [])]}
        for s in payload.get("exerciseSets", [])
    ]
    return stripped


def _named_exercise_keys(payload: dict) -> list[tuple]:
    """Distinct ``(category, name)`` of exercises that carry a name, first-seen
    order. These are the candidates Garmin might reject as an invalid sub-category."""
    keys: list[tuple] = []
    seen: set[tuple] = set()
    for s in payload.get("exerciseSets", []):
        for ex in s.get("exercises", []):
            name = ex.get("name")
            if name is None:
                continue
            k = (ex.get("category"), name)
            if k not in seen:
                seen.add(k)
                keys.append(k)
    return keys


def _strip_names_for(payload: dict, bad: set) -> dict:
    """Copy of the payload with the name removed only for exercises whose
    ``(category, name)`` is in ``bad`` (category kept)."""
    stripped = dict(payload)
    stripped["exerciseSets"] = [
        {
            **s,
            "exercises": [
                {**ex, "name": None} if (ex.get("category"), ex.get("name")) in bad else ex
                for ex in s.get("exercises", [])
            ],
        }
        for s in payload.get("exerciseSets", [])
    ]
    return stripped


def _push_stripping_offenders(client, activity_id: int, payload: dict) -> None:
    """Land the sets while keeping as many exercise names as possible.

    Garmin's exerciseSets PUT is atomic and reports no per-exercise error, so when
    it rejects a name as an invalid sub-category we bisect: strip a half of the
    distinct exercises, retry, and narrow to the offender(s), then strip only those
    names (category kept). Bounded to ~log2(n) extra PUTs, only on this rare path.
    Falls back to stripping every name if it can't converge (multiple offenders
    split across halves). Raises on any non-subcategory error."""
    keys = _named_exercise_keys(payload)
    if len(keys) <= 1:
        push_exercise_sets(client, activity_id, _strip_exercise_names(payload))
        return
    cand = keys
    while len(cand) > 1:
        mid = len(cand) // 2
        head = cand[:mid]
        try:
            push_exercise_sets(client, activity_id, _strip_names_for(payload, set(head)))
            cand = head  # stripping head fixed it → offender(s) in head
        except Exception as e:
            if not _is_subcategory_rejection(e):
                raise
            cand = cand[mid:]  # still rejected → offender(s) in the tail
    # Narrowed to one candidate: strip just it. If that still fails there is more
    # than one offender split across halves, so fall back to stripping every name.
    try:
        push_exercise_sets(client, activity_id, _strip_names_for(payload, set(cand)))
    except Exception as e:
        if not _is_subcategory_rejection(e):
            raise
        push_exercise_sets(client, activity_id, _strip_exercise_names(payload))


def _is_subcategory_rejection(exc: Exception) -> bool:
    """True when a push failed because Garmin rejected an exercise
    ``(category, subcategory)`` pair (HTTP 400 "Invalid Sub-Category"). The
    exerciseSets PUT is atomic, so one such exercise 400s the whole payload,
    and fit_tool considers these pairs valid so we can't filter them out first."""
    msg = str(exc).lower()
    return "sub-category" in msg or "subcategory" in msg or "invalid sub" in msg


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
    act_start = parse_iso(start_str)

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

            all_sets.append(
                {
                    "ex_idx": ex_idx,
                    "set_data": s,
                    "set_dur": set_dur,
                    "rest_dur": rest_dur,
                }
            )

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

        cat_id, sub_id, _ = lookup_exercise(
            ex.get("title") or ex.get("name", "Unknown"), ex.get("exercise_template_id")
        )
        cat_str = _category_to_string(cat_id)
        sub_name = _exercise_to_string(cat_id, sub_id)
        # Garmin rejects an UNKNOWN category, so fall back to the generic
        # TOTAL_BODY *parent*. But never send the parent name (or "TOTAL_BODY")
        # as the exercise *name*: Garmin renders an unrecognised name as
        # "Unknown" (#138). A null name under a valid parent is accepted and
        # shown as the category's generic label.
        if cat_str == "UNKNOWN":
            cat_str = "TOTAL_BODY"
            sub_name = None

        set_start = act_start + timedelta(seconds=cursor_s)
        scaled_dur = si["set_dur"] * scale

        # Active set
        reps = s.get("reps")
        weight_kg = s.get("weight_kg")

        # probability must be non-zero: Connect renders any exercise whose stored
        # confidence is 0 as "Unknown" (#325). The web UI's own edits send 100.
        active_set: dict = {
            "exercises": [{"category": cat_str, "name": sub_name, "probability": 100}],
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


def build_preserved_payload(synth_payload: dict, existing: dict) -> dict | None:
    """Overlay Hevy's names, reps and weights onto the watch's own set timing.

    The watch recorded a real timeline: each set's startTime, its duration, and
    the rest between them. `build_exercise_sets_payload` throws that away and
    invents a uniform duration for every set (the 33 seconds of #748). When the
    workout was recorded on both the watch and Hevy, the watch's timing is the
    accurate one, so this keeps the watch's whole set list unchanged and only
    writes Hevy's exercise identity, reps and weight onto the ACTIVE sets.

    The two set lists are matched by ACTIVE-set position, in order. That is safe
    only when they have the same number of ACTIVE sets: the same workout logged
    in both places. When the counts differ there is no sound mapping, so this
    returns None and the caller keeps the synthesized timing rather than guess.

    Args:
        synth_payload: the output of `build_exercise_sets_payload`, which already
            carries each ACTIVE set's resolved exercises, reps and weight.
        existing: the activity's current sets, as `get_activity_exercise_sets`
            returns them ({"exerciseSets": [...]}), i.e. the watch's recording.

    Returns:
        A payload that keeps the watch's startTime/duration on every set and
        overlays Hevy's identity on the ACTIVE ones, or None when the ACTIVE-set
        counts do not match.
    """
    existing_sets = (existing or {}).get("exerciseSets")
    if not existing_sets:
        return None

    synth_active = [
        s for s in synth_payload.get("exerciseSets", []) if s.get("setType") == "ACTIVE"
    ]
    watch_active = [s for s in existing_sets if s.get("setType") == "ACTIVE"]
    if not watch_active or len(watch_active) != len(synth_active):
        return None

    out: list[dict] = []
    ai = 0
    for es in existing_sets:
        if es.get("setType") == "ACTIVE":
            h = synth_active[ai]
            ai += 1
            out.append(
                {
                    # Identity, reps and weight come from Hevy; the wktStepIndex too,
                    # so sets group under the exercise they belong to rather than the
                    # watch's own grouping of nameless sets.
                    "exercises": h["exercises"],
                    "repetitionCount": h.get("repetitionCount", 0),
                    "weight": h.get("weight", 0.0),
                    "wktStepIndex": h.get("wktStepIndex", 0),
                    # Timing stays exactly as the watch recorded it (#748).
                    "duration": es.get("duration"),
                    "startTime": es.get("startTime"),
                    "setType": "ACTIVE",
                    "messageIndex": es.get("messageIndex"),
                }
            )
        else:
            # A REST (or any non-ACTIVE) set is the watch's own, kept untouched so
            # its real rest duration survives. Copy it so the backup is not mutated.
            out.append(dict(es))

    return {"activityId": synth_payload.get("activityId"), "exerciseSets": out}


def _apply_name_and_description(client, activity_id, hevy_workout) -> None:
    """Rename a Garmin activity to the Hevy title and set its exercise description."""
    title = hevy_workout.get("title", "Workout")
    rename_activity(client, activity_id, title)
    desc = generate_description(hevy_workout)
    note = "synced by hevy2garmin"
    if not desc.rstrip().endswith(note):
        desc = f"{desc}\n{note}"
    set_description(client, activity_id, f"Exercises synced from Hevy by hevy2garmin\n\n{desc}")


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------


def attempt_merge(
    client,
    hevy_workout: dict,
    database,
    overlap_threshold: float = 0.70,
    max_drift_minutes: int = 20,
    activity_types: set[str] | None = None,
    watch_strategy: str = "replace",
    preserve_watch_timing: bool = True,
) -> MergeResult:
    """Try to merge Hevy exercise data into a matching Garmin activity.

    Returns MergeResult with merged=True if successful, or merged=False
    with a fallback_reason explaining why (no match, circuit breaker, etc.)
    """
    global _consecutive_failures

    if _circuit_breaker_tripped():
        return MergeResult(merged=False, fallback_reason="Circuit breaker: too many PUT failures")

    # Activities the ledger already maps to another Hevy workout: never merge a
    # back-to-back session into a sibling's own upload (#796).
    try:
        known_ids = database.known_garmin_activity_ids(exclude_hevy_id=hevy_workout.get("id"))
    except Exception:  # noqa: BLE001  # a ledger read failure must not block the merge attempt
        known_ids = set()

    # Find matching activity
    match = find_matching_garmin_activity(
        client,
        hevy_workout,
        overlap_threshold=overlap_threshold,
        max_drift_minutes=max_drift_minutes,
        activity_types=activity_types,
        exclude_activity_ids=known_ids,
    )
    if not match:
        return MergeResult(merged=False, fallback_reason="No matching Garmin activity found")

    activity_id = match.get("activityId")
    act_start = match.get("startTimeGMT") or match.get("startTimeLocal", "")
    act_duration = match.get("duration", 0)

    if not activity_id or not act_start or not act_duration:
        return MergeResult(merged=False, fallback_reason="Matched activity missing required fields")

    # Garmin only displays pushed exercise identities on activities hevy2garmin
    # created itself (FIT manufacturer "DEVELOPMENT"). On device-recorded
    # activities (a watch, manufacturer "GARMIN", etc.) the exerciseSets PUT
    # returns 204 but Garmin ignores it, so the activity shows "Unknown" with no
    # reps (#159, confirmed against the live API). Reading the sets back cannot
    # detect this, since the read reflects stored, not displayed, state. So for
    # any match we did not create, skip the merge and upload a fresh named
    # activity instead. HR fusion still pulls the watch heart rate into it.
    manufacturer = str(match.get("manufacturer") or "").upper()
    is_watch = bool(manufacturer) and manufacturer != "DEVELOPMENT"
    if is_watch and watch_strategy == "describe":
        # Keep the single watch activity (its HR + device metrics) and just list
        # the exercises in its description. No push (Garmin ignores names on watch
        # activities) and no upload, so it stays one activity.
        logger.info(
            "  Match %s recorded by %s; enriching its description (watch_strategy=describe)",
            activity_id,
            manufacturer,
        )
        try:
            _apply_name_and_description(client, activity_id, hevy_workout)
        except Exception as e:  # noqa: BLE001  # best-effort Garmin step; the merge result does not depend on it
            logger.warning("Rename/description failed for %s: %s", activity_id, e)
        return MergeResult(merged=True, activity_id=activity_id)

    if is_watch and watch_strategy == "replace":
        # Upload one named activity, then delete the watch recording, so the
        # workout shows up exactly once with named exercises.
        logger.info(
            "  Match %s recorded by %s; uploading a named activity and removing the watch copy (watch_strategy=replace)",
            activity_id,
            manufacturer,
        )
        return MergeResult(
            merged=False,
            force_fresh_upload=True,
            delete_after_upload=activity_id,
            fallback_reason=f"activity recorded by {manufacturer}; replacing it with a named upload",
        )

    if is_watch:
        # watch_strategy == "merge": push the sets/reps/weights into the single
        # watch activity, keeping all its native metrics (HR, training effect,
        # body battery). Garmin will not display the exercise NAMES on a
        # device-recorded activity, so they show as "Unknown", but the structured
        # sets/reps/weights land in the activity. One activity, no upload/delete.
        logger.info(
            "  Match %s recorded by %s; merging sets in place, names may show as Unknown (watch_strategy=merge)",
            activity_id,
            manufacturer,
        )

    # Backup existing exercise sets
    existing_sets: dict | None = None
    try:
        existing_sets = get_activity_exercise_sets(client, activity_id)
        database.set_app_config(
            f"merge_backup_{activity_id}",
            {"activity_id": activity_id, "original_sets": existing_sets},
        )
    except Exception as e:  # noqa: BLE001  # best-effort Garmin step; the merge result does not depend on it
        logger.warning("Could not backup exercise sets for %s: %s", activity_id, e)
        # Continue anyway — backup is best-effort

    # Build payload
    payload = build_exercise_sets_payload(hevy_workout, activity_id, act_start, act_duration)

    # Keep the watch's own per-set execution and rest timing when we can (#748).
    # Only for a watch recording: a DEVELOPMENT activity's existing sets are a
    # previous hevy2garmin upload, not real device timing worth preserving. The
    # overlay maps set-for-set, so it falls back to the synthesized timing when
    # the watch and Hevy disagree on how many sets there were.
    if preserve_watch_timing and is_watch and existing_sets:
        preserved = build_preserved_payload(payload, existing_sets)
        if preserved is not None:
            logger.info(
                "  Keeping the watch's own set timing on activity %s (preserve_watch_timing)",
                activity_id,
            )
            payload = preserved
        else:
            logger.info(
                "  Watch and Hevy set counts differ on activity %s; using synthesized timing",
                activity_id,
            )

    # PUT exercise sets. The exerciseSets PUT is atomic: a single exercise whose
    # (category, subcategory) pair Garmin rejects 400s the WHOLE payload and would
    # drop every set (silas_christopher, r/Hevy). fit_tool treats these pairs as
    # valid, so we can't screen them out up front. On that rejection, retry once
    # with exercise names stripped (category kept, which Garmin always accepts) so
    # the structured sets/reps/weights still land instead of losing the entire
    # merge; the names then show as the generic category label.
    try:
        push_exercise_sets(client, activity_id, payload)
        _consecutive_failures = 0
    except Exception as e:  # noqa: BLE001  # the rejection is recognised by its message, whatever the client raised
        if _is_subcategory_rejection(e):
            logger.warning(
                "  exerciseSets rejected a subcategory for activity %s (%s); "
                "retrying, stripping only the offending exercise name(s)",
                activity_id,
                e,
            )
            try:
                _push_stripping_offenders(client, activity_id, payload)
                _consecutive_failures = 0
            except Exception as e2:  # noqa: BLE001  # a second failure of any type parks the merge
                _consecutive_failures += 1
                logger.error(
                    "PUT exerciseSets failed for activity %s even without names: %s",
                    activity_id,
                    e2,
                )
                return MergeResult(merged=False, fallback_reason=f"PUT failed: {e2}")
        else:
            _consecutive_failures += 1
            logger.error("PUT exerciseSets failed for activity %s: %s", activity_id, e)
            return MergeResult(merged=False, fallback_reason=f"PUT failed: {e}")

    # hevy2garmin's own uploads (DEVELOPMENT) display the pushed names, so verify
    # there and fall back to a named upload if Garmin dropped them. For
    # watch_strategy="merge" we intentionally keep the watch activity even though
    # Garmin will not show the names, so skip the verify and keep the sets.
    if not (is_watch and watch_strategy == "merge") and not _names_applied(client, activity_id):
        logger.info(
            "  Exercise names not applied on activity %s, restoring and uploading a named activity",
            activity_id,
        )
        _restore_sets(client, activity_id, database)
        return MergeResult(
            merged=False,
            force_fresh_upload=True,
            fallback_reason="Garmin dropped exercise names on the watch-recorded activity",
        )

    # Rename + set description
    try:
        _apply_name_and_description(client, activity_id, hevy_workout)
    except Exception as e:  # noqa: BLE001  # best-effort Garmin step; the merge result does not depend on it
        logger.warning("Rename/description failed after merge for %s: %s", activity_id, e)
        # Non-fatal, sets were already pushed

    return MergeResult(merged=True, activity_id=activity_id)
