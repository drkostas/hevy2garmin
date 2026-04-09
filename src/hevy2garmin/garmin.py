"""Garmin Connect upload — FIT files, activity renaming, descriptions.

Uses garmin-auth for authentication.
"""

from __future__ import annotations

import io
import logging
import time
from pathlib import Path

from garminconnect import Garmin
from garmin_auth import GarminAuth, RateLimiter

logger = logging.getLogger("hevy2garmin")

_limiter = RateLimiter(delay=1.0, max_retries=3, base_wait=30)


def get_client(
    email: str | None = None,
    password: str | None = None,
    token_dir: str = "~/.garminconnect",
) -> Garmin:
    """Get an authenticated Garmin client.

    Uses DBTokenStore when DATABASE_URL is set (cloud/Vercel),
    falls back to file-based tokens (local/Docker).
    """
    from hevy2garmin.db import get_database_url
    database_url = get_database_url()

    kwargs: dict = {"email": email, "password": password}
    if database_url:
        from garmin_auth.storage import DBTokenStore
        kwargs["store"] = DBTokenStore(database_url)
        # Use /tmp for garth token files on read-only filesystems (Vercel)
        kwargs["token_dir"] = "/tmp/.garminconnect"
    else:
        kwargs["token_dir"] = token_dir

    auth = GarminAuth(**kwargs)
    return auth.login()


def upload_fit(client: Garmin, fit_path: str | Path, workout_start: str | None = None) -> dict:
    """Upload a FIT file to Garmin Connect.

    Args:
        client: Authenticated Garmin client.
        fit_path: Path to the .fit file.
        workout_start: ISO-8601 start time for matching the uploaded activity.

    Returns dict with upload_id and activity_id (if found).
    """
    fit_path = Path(fit_path)
    if not fit_path.exists():
        raise FileNotFoundError(f"FIT file not found: {fit_path}")

    try:
        resp = _limiter.call(client.upload_activity, str(fit_path))
    except Exception as e:
        # Extract response body from exception chain for debugging
        response = getattr(e, 'response', None)
        if response is None and e.__cause__:
            response = getattr(e.__cause__, 'response', None)
        if response is None and e.__context__:
            response = getattr(e.__context__, 'response', None)
        if response is not None:
            body = response.text[:2000] if hasattr(response, 'text') else str(response)
            logger.error("Upload rejected — status=%s body=%s", getattr(response, 'status_code', '?'), body)
            raise RuntimeError(f"Garmin upload failed ({getattr(response, 'status_code', '?')}): {body}") from e
        logger.error("Upload failed (no response): %s", str(e)[:300])
        raise
    upload_id = None
    activity_id = None

    logger.info("  Upload response type=%s", type(resp).__name__)
    if isinstance(resp, dict):
        detail = resp.get("detailedImportResult", {})
        upload_id = detail.get("uploadId")
        successes = detail.get("successes", [])
        if successes and isinstance(successes, list):
            activity_id = successes[0].get("internalId")
        failures = detail.get("failures", [])
        if failures:
            logger.warning("  Upload failures: %s", failures)
        logger.info("  Upload result: upload_id=%s activity_id=%s", upload_id, activity_id)
    else:
        logger.info("  Upload response: %s", str(resp)[:200])

    # Find the activity ID for renaming (retry with backoff if needed).
    # Only match by start time — never grab "most recent activity" because
    # that can pick up an unrelated run/ride and rename the wrong thing.
    if not activity_id and workout_start:
        for attempt, wait in enumerate([3, 5, 10], 1):
            time.sleep(wait)
            activity_id = find_activity_by_start_time(client, workout_start)
            if activity_id:
                break
            logger.info("  Activity not found yet (attempt %d/%d), retrying...", attempt, 3)

    if activity_id:
        logger.info("  Found activity %s", activity_id)
    else:
        logger.warning("  Could not find activity ID after upload. Workout will appear as 'Strength Training' on Garmin.")

    return {"upload_id": upload_id, "activity_id": activity_id}


def find_activity_by_start_time(
    client: Garmin,
    target_start: str,
    window_minutes: int = 10,
) -> int | None:
    """Find a Garmin activity matching a start time within a window."""
    from datetime import datetime, timedelta

    try:
        target = datetime.fromisoformat(target_start.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None

    try:
        activities = _limiter.call(client.get_activities, 0, 10)
    except Exception:
        return None

    for act in activities:
        # Only match strength training activities — skip runs, bikes, yoga, etc.
        act_type = act.get("activityType", {}).get("typeKey", "")
        if act_type and act_type not in ("strength_training", "other"):
            continue

        # Prefer startTimeGMT (UTC) over startTimeLocal to avoid timezone mismatch
        act_start_str = act.get("startTimeGMT") or act.get("startTimeLocal", "")
        try:
            if "T" not in act_start_str:
                act_start_str = act_start_str.replace(" ", "T")
            act_start = datetime.fromisoformat(act_start_str)
            # Both should be UTC now, compare naive
            target_naive = target.replace(tzinfo=None) if target.tzinfo else target
            act_naive = act_start.replace(tzinfo=None) if act_start.tzinfo else act_start
            if abs((act_naive - target_naive).total_seconds()) < window_minutes * 60:
                return act.get("activityId")
        except (ValueError, TypeError):
            continue
    return None


def rename_activity(client: Garmin, activity_id: int, name: str) -> None:
    """Rename a Garmin activity."""
    _limiter.call(client.set_activity_name, activity_id, name)
    logger.info("  Renamed activity %s to '%s'", activity_id, name)


def set_description(client: Garmin, activity_id: int, description: str) -> None:
    """Set description for a Garmin activity."""
    url = f"/activity-service/activity/{activity_id}"
    payload = {"activityId": activity_id, "description": description}
    client.garth.put("connectapi", url, json=payload, api=True)
    time.sleep(1.0)
    logger.info("  Description set (%d chars)", len(description))


def upload_image(client: Garmin, activity_id: int, image_bytes: bytes, filename: str = "image.png") -> None:
    """Upload an image to a Garmin activity."""
    files = {"file": (filename, io.BytesIO(image_bytes))}
    client.garth.post(
        "connectapi",
        f"activity-service/activity/{activity_id}/image",
        files=files,
        api=True,
    )
    time.sleep(1.0)
    logger.info("  Image uploaded (%dKB)", len(image_bytes) // 1024)


def generate_description(workout: dict, calories: int | None = None, avg_hr: int | None = None) -> str:
    """Generate a text description for a gym workout."""
    lines: list[str] = []
    title = workout.get("title", "Workout")
    duration_s = 0

    start = workout.get("start_time") or workout.get("startTime", "")
    end = workout.get("end_time") or workout.get("endTime", "")
    if start and end:
        from datetime import datetime
        try:
            fmt = "%Y-%m-%dT%H:%M:%S%z" if "T" in start else "%Y-%m-%d %H:%M:%S"
            t0 = datetime.fromisoformat(start.replace("Z", "+00:00"))
            t1 = datetime.fromisoformat(end.replace("Z", "+00:00"))
            duration_s = int((t1 - t0).total_seconds())
        except Exception:
            pass

    lines.append(f"🏋️ {title}")
    if duration_s > 0:
        m = duration_s // 60
        lines.append(f"⏱️ {m} min")
    if calories:
        lines.append(f"🔥 {calories} kcal")
    if avg_hr:
        lines.append(f"❤️ avg {avg_hr} bpm")

    exercises = workout.get("exercises", [])
    if exercises:
        lines.append("")
        for ex in exercises:
            name = ex.get("title") or ex.get("name", "Unknown")
            all_sets = ex.get("sets", [])
            normal = [s for s in all_sets if s.get("type") == "normal"]
            warmup = [s for s in all_sets if s.get("type") == "warmup"]
            if normal:
                n_label = "set" if len(normal) == 1 else "sets"
                # Check if this is a cardio exercise (has distance or duration, no weight/reps)
                has_distance = any(s.get("distance_meters") for s in normal)
                has_duration = any(s.get("duration_seconds") for s in normal)
                has_weight = any(s.get("weight_kg") or s.get("weight") for s in normal)
                if has_distance or (has_duration and not has_weight):
                    # Cardio: show distance and/or duration
                    total_dist = sum(s.get("distance_meters", 0) or 0 for s in normal)
                    total_dur = sum(s.get("duration_seconds", 0) or 0 for s in normal)
                    parts = [f"{len(normal)} {n_label}"]
                    if total_dist > 0:
                        parts.append(f"{total_dist / 1000:.1f}km")
                    if total_dur > 0:
                        parts.append(f"{int(total_dur // 60)}min")
                    lines.append(f"• {name}: {' · '.join(parts)}")
                else:
                    weights = [s.get("weight_kg") or s.get("weight", 0) for s in normal]
                    reps = [s.get("reps", 0) for s in normal]
                    top_weight = max(weights) if weights else 0
                    top_reps = max(reps) if reps else 0
                    lines.append(f"• {name}: {len(normal)} {n_label} · {top_weight:.1f}kg × {top_reps}")
            elif warmup:
                s_label = "set" if len(warmup) == 1 else "sets"
                lines.append(f"• {name}: {len(warmup)} warmup {s_label}")

    lines.append("\n— synced by hevy2garmin")
    return "\n".join(lines)
