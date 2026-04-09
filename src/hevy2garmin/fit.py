"""Generate strength-training FIT files from Hevy workout data.

Merges Hevy exercise/set data with heart-rate samples (from Garmin daily
monitoring or a static fallback) into a valid .fit file that can be
uploaded to Garmin Connect.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from fit_tool.fit_file_builder import FitFileBuilder
from fit_tool.profile.messages.file_id_message import FileIdMessage
from fit_tool.profile.messages.event_message import EventMessage
from fit_tool.profile.messages.record_message import RecordMessage
from fit_tool.profile.messages.set_message import SetMessage
from fit_tool.profile.messages.exercise_title_message import ExerciseTitleMessage
from fit_tool.profile.messages.session_message import SessionMessage
from fit_tool.profile.messages.lap_message import LapMessage
from fit_tool.profile.messages.activity_message import ActivityMessage
from fit_tool.profile.messages.sport_message import SportMessage
from fit_tool.profile.profile_type import (
    FileType,
    Manufacturer,
    Sport,
    SubSport,
    Event,
    EventType,
    Activity,
    SetType,
)

from hevy2garmin.mapper import lookup_exercise

# ---------------------------------------------------------------------------
# Default timing/profile — overridden by config or profile param
# ---------------------------------------------------------------------------
_MIN_SCALE = 0.3
_MAX_SCALE = 2.0
_DEFAULT_HR_BPM = 90  # fallback when no HR data at all
DEFAULT_HR_BPM = _DEFAULT_HR_BPM  # public alias


def _get_profile(override: dict | None = None) -> dict:
    """Get user profile + timing from config, with optional overrides."""
    from hevy2garmin.config import load_config
    cfg = load_config()
    profile = {
        "weight_kg": cfg.get("user_profile", {}).get("weight_kg", 80.0),
        "birth_year": cfg.get("user_profile", {}).get("birth_year", 1990),
        "vo2max": cfg.get("user_profile", {}).get("vo2max", 45.0),
        "working_set_s": cfg.get("timing", {}).get("working_set_seconds", 40),
        "warmup_set_s": cfg.get("timing", {}).get("warmup_set_seconds", 25),
        "rest_sets_s": cfg.get("timing", {}).get("rest_between_sets_seconds", 75),
        "rest_exercises_s": cfg.get("timing", {}).get("rest_between_exercises_seconds", 120),
    }
    if override:
        profile.update(override)
    return profile


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _ms(dt: datetime) -> int:
    """Convert a datetime to milliseconds since Unix epoch."""
    return round(dt.timestamp() * 1000)


def parse_timestamp(raw: str) -> datetime:
    """Parse ISO-8601 or Garmin space-separated timestamp to UTC datetime."""
    return _parse_timestamp(raw)


def calc_calories(hr_samples: list[int], duration_s: float, workout_year: int, profile: dict | None = None) -> int:
    """Calculate total calories from HR samples using the Keytel formula."""
    return _calc_calories(hr_samples, duration_s, workout_year, profile)


def _parse_timestamp(raw: str | None) -> datetime | None:
    """Parse ISO-8601 or Garmin space-separated timestamp to UTC datetime.

    Returns None for null, empty, or malformed input instead of crashing.
    """
    if not raw or not isinstance(raw, str):
        return None
    cleaned = raw.strip()
    if not cleaned:
        return None
    try:
        if "T" in cleaned:
            return datetime.fromisoformat(cleaned.replace("Z", "+00:00"))
        return datetime.strptime(cleaned, "%Y-%m-%d %H:%M:%S").replace(
            tzinfo=timezone.utc
        )
    except (ValueError, TypeError):
        return None


def _calc_calories(hr_samples: list[int], duration_s: float, workout_year: int, profile: dict | None = None) -> int:
    """Calculate total calories from HR samples using the Keytel formula.

    If hr_samples is empty, uses _DEFAULT_HR_BPM.
    Distributes samples evenly across duration and sums per-interval calories.
    """
    p = profile or _get_profile()
    age = workout_year - p["birth_year"]
    weight = p["weight_kg"]
    vo2max = p["vo2max"]
    if not hr_samples:
        hr_samples = [_DEFAULT_HR_BPM]

    # Each sample covers an equal interval
    interval_min = (duration_s / len(hr_samples)) / 60.0
    total = 0.0
    for hr in hr_samples:
        kcal_per_min = (
            -95.7735 + 0.634 * hr + 0.404 * vo2max
            + 0.394 * weight + 0.271 * age
        ) / 4.184
        total += max(0.0, kcal_per_min) * interval_min
    return round(total)


# ---------------------------------------------------------------------------
# Main generator
# ---------------------------------------------------------------------------

def generate_fit(
    hevy_workout: dict,
    hr_samples: list[int] | None,
    output_path: str,
    profile: dict | None = None,
) -> dict:
    """Generate a strength-training FIT file.

    Parameters
    ----------
    hevy_workout:
        Hevy workout dict with exercises and sets.
    hr_samples:
        Heart-rate samples to embed. Can come from Garmin daily monitoring,
        or be a synthetic list (e.g. [90]*30 for static fallback).
        If None or empty, _DEFAULT_HR_BPM is used for calorie calculation
        and no HR records are written.
    output_path:
        Path where the .fit file will be written.

    Returns
    -------
    dict with keys: exercises, total_sets, hr_samples, calories, duration_s,
    avg_hr, output_path
    """
    if hr_samples is None:
        hr_samples = []

    p = _get_profile(profile)

    # -- Resolve timing --
    start_dt = _parse_timestamp(hevy_workout.get("start_time"))
    end_dt = _parse_timestamp(hevy_workout.get("end_time"))
    if not start_dt or not end_dt:
        raise ValueError(
            f"Workout '{hevy_workout.get('title', '?')}' missing valid start/end time "
            f"(start={hevy_workout.get('start_time')!r}, end={hevy_workout.get('end_time')!r})"
        )
    duration_s = (end_dt - start_dt).total_seconds()

    start_ms = _ms(start_dt)
    end_ms = start_ms + round(duration_s * 1000)

    # -- Calculate calories from HR using Keytel formula --
    workout_year = start_dt.year
    calories = _calc_calories(hr_samples, duration_s, workout_year, p)

    # -- Gather exercises and compute timing --
    exercises = hevy_workout.get("exercises", [])
    num_exercises = len(exercises)

    # Count all sets and compute ideal (unscaled) duration
    all_sets_info: list[dict] = []  # flat list of set info dicts
    for ex_idx, ex in enumerate(exercises):
        sets = ex.get("sets", [])
        for s_idx, s in enumerate(sets):
            is_warmup = s.get("type", "normal") == "warmup"
            # Use the set's own duration if present (cardio/isometric exercises),
            # otherwise fall back to profile defaults
            explicit_dur = s.get("duration_seconds")
            if explicit_dur and explicit_dur > 0:
                set_dur = float(explicit_dur)
            else:
                set_dur = p["warmup_set_s"] if is_warmup else p["working_set_s"]

            # Rest after this set (none after the very last set of the workout)
            is_last_set_of_exercise = s_idx == len(sets) - 1
            is_last_exercise = ex_idx == num_exercises - 1
            is_very_last = is_last_set_of_exercise and is_last_exercise

            if is_very_last:
                rest_dur = 0.0
            elif is_last_set_of_exercise:
                rest_dur = p["rest_exercises_s"]
            else:
                rest_dur = p["rest_sets_s"]

            all_sets_info.append(
                {
                    "ex_idx": ex_idx,
                    "set_data": s,
                    "set_dur": set_dur,
                    "rest_dur": rest_dur,
                    "is_warmup": is_warmup,
                }
            )

    total_sets = len(all_sets_info)

    # Compute ideal total time and scale factor
    ideal_total = sum(si["set_dur"] + si["rest_dur"] for si in all_sets_info)
    if ideal_total > 0:
        scale = duration_s / ideal_total
        scale = max(_MIN_SCALE, min(_MAX_SCALE, scale))
    else:
        scale = 1.0

    # Assign timestamps to each set
    cursor_s = 0.0
    for si in all_sets_info:
        si["start_offset_s"] = cursor_s
        scaled_set = si["set_dur"] * scale
        si["end_offset_s"] = cursor_s + scaled_set
        cursor_s += scaled_set + si["rest_dur"] * scale

    # -- Build FIT messages --
    builder = FitFileBuilder(auto_define=True, min_string_size=50)

    # 1. FileIdMessage
    file_id = FileIdMessage()
    file_id.type = FileType.ACTIVITY
    file_id.manufacturer = Manufacturer.DEVELOPMENT
    file_id.serial_number = 12345
    file_id.time_created = start_ms
    builder.add(file_id)

    # 2. SportMessage
    sport_msg = SportMessage()
    sport_msg.sport = Sport.TRAINING
    sport_msg.sub_sport = SubSport.STRENGTH_TRAINING
    builder.add(sport_msg)

    # 3. ExerciseTitleMessage (one per exercise)
    for ex_idx, ex in enumerate(exercises):
        cat, sub, display_name = lookup_exercise(ex["title"])
        etm = ExerciseTitleMessage()
        etm.message_index = ex_idx
        etm.exercise_category = cat
        etm.exercise_name = sub
        etm.workout_step_name = display_name
        builder.add(etm)

    # 4. EventMessage - TIMER START
    event_start = EventMessage()
    event_start.timestamp = start_ms
    event_start.event = Event.TIMER
    event_start.event_type = EventType.START
    builder.add(event_start)

    # 5. Interleaved RecordMessages (HR) and SetMessages
    # Build a timeline of events sorted by timestamp
    timeline: list[tuple[int, str, object]] = []  # (ms, type, message)

    # HR record messages distributed evenly across duration
    if hr_samples:
        if len(hr_samples) == 1:
            hr_interval_ms = 0
        else:
            hr_interval_ms = round(duration_s * 1000 / (len(hr_samples) - 1))
        for i, hr_val in enumerate(hr_samples):
            t_ms = start_ms + (i * hr_interval_ms if len(hr_samples) > 1 else 0)
            rec = RecordMessage()
            rec.timestamp = t_ms
            rec.heart_rate = hr_val
            timeline.append((t_ms, "record", rec))

    # Set messages
    msg_index = 0
    for si in all_sets_info:
        s = si["set_data"]
        ex_idx = si["ex_idx"]
        cat, sub, _ = lookup_exercise(exercises[ex_idx]["title"])

        set_start_ms = start_ms + round(si["start_offset_s"] * 1000)
        set_end_ms = start_ms + round(si["end_offset_s"] * 1000)
        set_duration_s = si["end_offset_s"] - si["start_offset_s"]

        # Active set
        active = SetMessage()
        active.timestamp = set_end_ms
        active.start_time = set_start_ms
        active.duration = set_duration_s
        active.set_type = SetType.ACTIVE
        active.category = [cat]
        active.category_subtype = [sub]
        active.message_index = msg_index
        active.workout_step_index = ex_idx

        reps = s.get("reps")
        if reps is not None:
            active.repetitions = int(reps)

        weight = s.get("weight_kg")
        if weight is not None:
            active.weight = float(weight)

        # Note: FIT SetMessage doesn't have a distance field.
        # Cardio data (distance_meters) is captured via set duration timing
        # (duration_seconds handled above) which is more meaningful for Garmin.

        timeline.append((set_end_ms, "set", active))
        msg_index += 1

        # Rest set (if there is rest after this set)
        if si["rest_dur"] > 0:
            rest_start_ms = set_end_ms
            rest_dur_scaled = si["rest_dur"] * scale
            rest_end_ms = rest_start_ms + round(rest_dur_scaled * 1000)

            rest = SetMessage()
            rest.timestamp = rest_end_ms
            rest.start_time = rest_start_ms
            rest.duration = rest_dur_scaled
            rest.set_type = SetType.REST
            rest.message_index = msg_index
            rest.workout_step_index = ex_idx

            timeline.append((rest_end_ms, "set", rest))
            msg_index += 1

    # Sort timeline chronologically, records before sets at same timestamp
    timeline.sort(key=lambda x: (x[0], 0 if x[1] == "record" else 1))

    for _, _, msg in timeline:
        builder.add(msg)

    # 6. EventMessage - TIMER STOP_ALL
    event_stop = EventMessage()
    event_stop.timestamp = end_ms
    event_stop.event = Event.TIMER
    event_stop.event_type = EventType.STOP_ALL
    builder.add(event_stop)

    # 7. LapMessage
    lap = LapMessage()
    lap.timestamp = end_ms
    lap.start_time = start_ms
    lap.total_elapsed_time = duration_s
    lap.total_timer_time = duration_s
    lap.sport = Sport.TRAINING
    lap.sub_sport = SubSport.STRENGTH_TRAINING
    lap.message_index = 0
    lap.event = Event.LAP
    lap.event_type = EventType.STOP
    if hr_samples:
        lap.avg_heart_rate = round(sum(hr_samples) / len(hr_samples))
        lap.max_heart_rate = max(hr_samples)
    lap.total_calories = calories
    builder.add(lap)

    # 8. SessionMessage
    session = SessionMessage()
    session.timestamp = end_ms
    session.start_time = start_ms
    session.total_elapsed_time = duration_s
    session.total_timer_time = duration_s
    session.sport = Sport.TRAINING
    session.sub_sport = SubSport.STRENGTH_TRAINING
    session.message_index = 0
    session.first_lap_index = 0
    session.num_laps = 1
    session.event = Event.LAP
    session.event_type = EventType.STOP
    if hr_samples:
        session.avg_heart_rate = round(sum(hr_samples) / len(hr_samples))
        session.max_heart_rate = max(hr_samples)
    session.total_calories = calories
    builder.add(session)

    # 9. ActivityMessage
    activity = ActivityMessage()
    activity.timestamp = end_ms
    activity.total_timer_time = duration_s
    activity.num_sessions = 1
    activity.type = Activity.MANUAL
    activity.event = Event.ACTIVITY
    activity.event_type = EventType.STOP
    builder.add(activity)

    # -- Write file --
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    builder.build().to_file(output_path)

    avg_hr = round(sum(hr_samples) / len(hr_samples)) if hr_samples else None
    return {
        "exercises": num_exercises,
        "total_sets": total_sets,
        "hr_samples": len(hr_samples),
        "calories": calories,
        "avg_hr": avg_hr,
        "duration_s": duration_s,
        "output_path": output_path,
    }
