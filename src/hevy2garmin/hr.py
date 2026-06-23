"""Heart-rate sourcing + merging for FIT enrichment.

hevy2garmin can enrich an uploaded workout with heart rate from more than one
source, in priority order:

1. **In-workout HR recorded by Hevy** (e.g. AirPods Pro 3 in-ear HR, which Hevy
   captures via Apple HealthKit). This is the most consistent during a lift, but
   only present when the user wore a recording device for that session — and
   only when Hevy actually exposes it (see ``extract_hevy_hr``).
2. **Garmin daily passive HR** (wrist monitoring, ~every couple of minutes).
   Always available if the user wears the watch, but coarser.

``merge_hr_sources`` combines them: the higher-priority source wins wherever it
has a sample, and the lower-priority source fills the gaps. The result is a
timestamped ``[{"time": secs_from_start, "hr": bpm}]`` series that
``fit.generate_fit`` embeds at real offsets.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


def extract_hevy_hr(workout: dict) -> list[dict]:
    """Extract in-workout HR samples (e.g. AirPods) from a Hevy workout.

    Returns ``[{"time": secs_from_start, "hr": bpm}]`` sorted by time, or ``[]``.

    NOTE: the Hevy **public API** (`/v1/workouts/{id}`) does not currently expose
    heart-rate data — sets carry only weight/reps/distance/duration/rpe. AirPods
    HR that Hevy records via HealthKit stays on-device / in the app. So this
    returns ``[]`` today; it's the seam where AirPods HR plugs in if/when Hevy
    surfaces it in the API (or a future HealthKit path provides it). Kept as the
    highest-priority source so no other code changes when that data appears.
    """
    samples: list[dict] = []
    # Defensive: support a future Hevy field without breaking today.
    raw = workout.get("heart_rate") or workout.get("heartRate") or workout.get("hr_samples")
    if isinstance(raw, list):
        for entry in raw:
            if isinstance(entry, dict) and entry.get("hr") is not None and entry.get("time") is not None:
                samples.append({"time": max(0.0, float(entry["time"])), "hr": int(entry["hr"])})
            elif isinstance(entry, (list, tuple)) and len(entry) >= 2 and entry[1] is not None:
                samples.append({"time": max(0.0, float(entry[0])), "hr": int(entry[1])})
    samples.sort(key=lambda s: s["time"])
    return samples


def fetch_watch_hr(garmin_client, workout: dict, limiter=None) -> list[dict]:
    """Fetch Garmin daily passive HR, sliced to the workout window.

    Returns ``[{"time": secs_from_start, "hr": bpm}]`` sorted by time, or ``[]``
    on any failure (HR enrichment is best-effort and must never break a sync).
    """
    from hevy2garmin.fit import _parse_timestamp

    w_start = workout.get("start_time") or workout.get("startTime", "")
    w_end = workout.get("end_time") or workout.get("endTime", "")
    start_dt = _parse_timestamp(w_start)
    end_dt = _parse_timestamp(w_end)
    if not start_dt or not end_dt:
        return []
    start_ms = int(start_dt.timestamp() * 1000)
    end_ms = int(end_dt.timestamp() * 1000)

    try:
        date_str = str(w_start)[:10]
        call = (limiter.call if limiter is not None else (lambda f, *a: f(*a)))
        daily_hr = call(garmin_client.get_heart_rates, date_str)
    except Exception as e:  # pragma: no cover - network/auth failure path
        logger.debug("watch HR fetch failed: %s", e)
        return []

    values = daily_hr.get("heartRateValues", []) if isinstance(daily_hr, dict) else []
    samples: list[dict] = []
    for entry in values or []:
        if isinstance(entry, (list, tuple)) and len(entry) >= 2 and entry[1] is not None:
            ts, bpm = entry[0], entry[1]
            if start_ms - 60000 <= ts <= end_ms + 60000:  # ±1 min buffer
                samples.append({"time": max(0.0, (ts - start_ms) / 1000), "hr": int(bpm)})
    samples.sort(key=lambda s: s["time"])
    return samples


def merge_hr_sources(
    primary: list[dict] | None,
    secondary: list[dict] | None,
    bucket_s: float = 10.0,
) -> list[dict]:
    """Merge two timestamped HR series, preferring ``primary`` per time bucket.

    Time is bucketed into ``bucket_s``-second windows. For each window, if the
    primary source has a sample it wins; otherwise the secondary fills in. This
    yields a continuous series that uses the more consistent source (AirPods)
    when present and the always-on source (watch) elsewhere.

    Returns ``[{"time", "hr"}]`` sorted by time (empty if both inputs are empty).
    """
    primary = primary or []
    secondary = secondary or []
    if not primary:
        return sorted(secondary, key=lambda s: s["time"])
    if not secondary:
        return sorted(primary, key=lambda s: s["time"])

    chosen: dict[int, dict] = {}
    # Secondary first, then overwrite with primary so primary wins ties.
    for s in secondary:
        chosen[int(s["time"] // bucket_s)] = s
    for s in primary:
        chosen[int(s["time"] // bucket_s)] = s
    return [chosen[k] for k in sorted(chosen)]


def build_workout_hr(garmin_client, workout: dict, limiter=None) -> list[dict]:
    """Top-level helper: merged HR for a workout (AirPods-preferred, watch fill)."""
    hevy_hr = extract_hevy_hr(workout)        # AirPods / in-workout (empty today)
    watch_hr = fetch_watch_hr(garmin_client, workout, limiter)
    return merge_hr_sources(hevy_hr, watch_hr)


def hr_for_sync(db, garmin_client, workout: dict, config: dict, limiter=None) -> list[dict] | None:
    """Merged HR samples for embedding in a sync's FIT — or None.

    Honors the ``hr_fusion.enabled`` toggle, reuses the dashboard's cached HR
    when present (avoids a duplicate Garmin call), and is fully best-effort:
    any failure returns None so HR never breaks a sync.
    """
    if not garmin_client or not config.get("hr_fusion", {}).get("enabled", True):
        return None
    try:
        wid = workout.get("id")
        cached = db.get_cached_hr(wid) if wid else None
        if isinstance(cached, dict) and cached.get("hr_samples"):
            return merge_hr_sources(extract_hevy_hr(workout), cached["hr_samples"]) or None
        return build_workout_hr(garmin_client, workout, limiter) or None
    except Exception:
        logger.debug("HR enrichment skipped for sync", exc_info=True)
        return None
