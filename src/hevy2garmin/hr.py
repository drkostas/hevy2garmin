"""Heart-rate sourcing + merging for FIT enrichment.

hevy2garmin can enrich an uploaded workout with heart rate from more than one
source, in priority order:

1. **In-workout HR recorded by Hevy** (e.g. AirPods Pro 3 in-ear HR, which Hevy
   captures via Apple HealthKit). This is the most consistent during a lift, but
   only present when the user wore a recording device for that session — and
   only when Hevy actually exposes it (see ``extract_hevy_hr``).
2. **Matched Garmin activity HR** from the watch-recorded FIT file. This is the
   preferred source for replacement uploads and is typically sampled every
   second.
3. **Garmin daily passive HR** (wrist monitoring, ~every couple of minutes).
   Usually available if the user wears the watch, but coarser.

``merge_hr_sources`` combines them: the higher-priority source wins wherever it
has a sample, and the lower-priority source fills the gaps. The result is a
timestamped ``[{"time": secs_from_start, "hr": bpm}]`` series that
``fit.generate_fit`` embeds at real offsets.
"""

from __future__ import annotations

import io
import logging
import zipfile
from datetime import datetime, timezone

logger = logging.getLogger(__name__)


def _patch_fit_tool_lenient_strings() -> None:
    """Make fit-tool tolerate non-UTF-8 bytes in FIT string fields.

    Some device FITs (a Garmin Fenix 7 Pro was the first confirmed, #244) carry a
    non-UTF-8 byte in a string field such as a manufacturer or product name.
    fit-tool decodes string containers with strict UTF-8, so a single bad byte
    raised UnicodeDecodeError and aborted the whole parse, losing all heart rate
    and silently dropping Replace to the merge fallback (names then "unknown").
    Decode leniently instead: the bad byte becomes the Unicode replacement
    character and the rest of the file, including the HR records, still parses.
    Idempotent, and safe because hevy2garmin only ever reads these FITs.
    """
    from fit_tool.field import Field

    if getattr(Field.read_strings_from_bytes, "_h2g_lenient", False):
        return

    def read_strings_from_bytes(self, bytes_buffer: bytes) -> None:
        string_container = bytes_buffer.decode("utf-8", errors="replace")
        strings = [s for s in string_container.split(chr(0))[:-1] if s]
        self.encoded_values = list(strings)

    read_strings_from_bytes._h2g_lenient = True  # type: ignore[attr-defined]
    Field.read_strings_from_bytes = read_strings_from_bytes  # type: ignore[method-assign]

_HR_BACKUP_PREFIX = "hr_backup_"


class HRBackupError(RuntimeError):
    """A high-resolution HR series could not be durably backed up."""


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


def fetch_activity_hr(
    garmin_client,
    activity_id: int | str,
    workout: dict,
    limiter=None,
) -> list[dict]:
    """Extract high-resolution HR from a Garmin-recorded activity.

    Garmin's ``ORIGINAL`` activity download is normally a zip containing the
    device-recorded FIT file.  Record timestamps are converted to offsets from
    the Hevy workout start so the samples can be embedded in the replacement
    FIT. Samples outside the Hevy workout window are discarded.

    Returns an empty list on any download or parse failure so callers can fall
    back to Garmin's coarser daily HR feed.
    """
    from garminconnect import Garmin
    from fit_tool.fit_file import FitFile
    from fit_tool.profile.messages.record_message import RecordMessage
    from hevy2garmin.fit import _parse_timestamp

    start_raw = workout.get("start_time") or workout.get("startTime", "")
    end_raw = workout.get("end_time") or workout.get("endTime", "")
    start_dt = _parse_timestamp(start_raw)
    end_dt = _parse_timestamp(end_raw)
    if not start_dt or not end_dt:
        return []
    start_ms = int(start_dt.timestamp() * 1000)

    try:
        call = (limiter.call if limiter is not None else (lambda f, *a: f(*a)))
        downloaded = call(
            garmin_client.download_activity,
            str(activity_id),
            Garmin.ActivityDownloadFormat.ORIGINAL,
        )
        if not isinstance(downloaded, bytes) or not downloaded:
            logger.warning("activity %s: HR download returned no bytes", activity_id)
            return []

        fit_bytes = downloaded
        stream = io.BytesIO(downloaded)
        if zipfile.is_zipfile(stream):
            with zipfile.ZipFile(stream) as archive:
                fit_member = next(
                    (member for member in archive.infolist() if member.filename.lower().endswith(".fit")),
                    None,
                )
                if fit_member is None:
                    logger.warning("activity %s: no .fit member in downloaded zip", activity_id)
                    return []
                fit_bytes = archive.read(fit_member)

        # Device FIT files can contain fields newer than fit-tool's bundled
        # profile. They are safely skipped, but fit-tool otherwise emits one
        # warning per record and floods normal sync output.
        fit_logger = logging.getLogger("fit_tool")
        previous_level = fit_logger.level
        fit_logger.setLevel(logging.ERROR)
        _patch_fit_tool_lenient_strings()
        try:
            fit_file = FitFile.from_bytes(fit_bytes, check_crc=False)
        finally:
            fit_logger.setLevel(previous_level)
    except Exception as exc:
        logger.warning("activity %s: HR download/parse failed: %s", activity_id, exc)
        return []

    # The downloaded FIT is the watch's own single recording of this workout, so
    # every heart-rate record in it belongs to the workout. Take them all and
    # rebase to the Hevy start for embedding, rather than intersecting with the
    # Hevy workout window (#244): a watch activity whose clock differs from the
    # Hevy log by more than a few minutes would otherwise lose all its samples.
    samples: list[dict] = []
    record_count = 0
    hr_record_count = 0
    for record in fit_file.records:
        message = record.message
        if not isinstance(message, RecordMessage):
            continue
        record_count += 1
        timestamp = getattr(message, "timestamp", None)
        bpm = getattr(message, "heart_rate", None)
        if timestamp is None or bpm is None:
            continue
        try:
            timestamp_ms = float(timestamp)
            # Be defensive if a FIT implementation returns Unix seconds rather
            # than the millisecond representation used by fit-tool.
            if timestamp_ms < 100_000_000_000:
                timestamp_ms *= 1000
            bpm_int = int(bpm)
        except (TypeError, ValueError):
            continue
        if not 0 < bpm_int < 256:
            continue
        hr_record_count += 1
        samples.append({
            "time": max(0.0, (timestamp_ms - start_ms) / 1000.0),
            "hr": bpm_int,
        })

    if not samples:
        logger.warning(
            "activity %s: no heart-rate samples extracted (%d record messages, "
            "%d with valid HR); replacement will fall back to keeping the watch copy",
            activity_id, record_count, hr_record_count,
        )
    samples.sort(key=lambda sample: sample["time"])
    return samples


def save_hr_backup(
    database,
    workout: dict,
    samples: list[dict],
    source_activity_id: int | str,
) -> dict | None:
    """Persist the best-known activity HR series for later replacements.

    Backups live in the generic durable app-config store rather than the
    dashboard HR cache. A later coarse import must never overwrite a denser
    activity recording.
    """
    workout_id = workout.get("id")
    if not workout_id or not samples:
        return None
    key = f"{_HR_BACKUP_PREFIX}{workout_id}"
    existing = database.get_app_config(key)
    try:
        existing_count = int((existing or {}).get("sample_count") or 0)
    except (TypeError, ValueError):
        existing_count = 0
    if existing_count >= len(samples):
        return existing

    payload = {
        "version": 1,
        "source": "garmin_activity_fit",
        "source_activity_id": str(source_activity_id),
        "workout_start": workout.get("start_time") or workout.get("startTime", ""),
        "workout_end": workout.get("end_time") or workout.get("endTime", ""),
        "sample_count": len(samples),
        "hr_samples": [
            {"time": float(sample["time"]), "hr": int(sample["hr"])}
            for sample in samples
            if sample.get("time") is not None and sample.get("hr") is not None
        ],
        "backed_up_at": datetime.now(timezone.utc).isoformat(),
    }
    database.set_app_config(key, payload)
    logger.info(
        "  HR backup: saved %d samples from Garmin activity %s",
        len(samples),
        source_activity_id,
    )
    return payload


def load_hr_backup(database, workout: dict) -> list[dict]:
    """Load, rebase, and clip a durable HR backup to the current Hevy window."""
    from hevy2garmin.fit import _parse_timestamp

    workout_id = workout.get("id")
    if not workout_id:
        return []
    backup = database.get_app_config(f"{_HR_BACKUP_PREFIX}{workout_id}")
    if not isinstance(backup, dict):
        return []
    raw_samples = backup.get("hr_samples")
    if not isinstance(raw_samples, list):
        return []

    stored_start = _parse_timestamp(backup.get("workout_start", ""))
    current_start = _parse_timestamp(
        workout.get("start_time") or workout.get("startTime", "")
    )
    current_end = _parse_timestamp(
        workout.get("end_time") or workout.get("endTime", "")
    )
    shift_s = (
        (stored_start - current_start).total_seconds()
        if stored_start is not None and current_start is not None
        else 0.0
    )
    duration_s = (
        (current_end - current_start).total_seconds()
        if current_start is not None and current_end is not None
        else None
    )

    samples: list[dict] = []
    for sample in raw_samples:
        if not isinstance(sample, dict):
            continue
        try:
            rebased_time = float(sample["time"]) + shift_s
            bpm = int(sample["hr"])
        except (KeyError, TypeError, ValueError):
            continue
        if rebased_time < 0 or (duration_s is not None and rebased_time > duration_s):
            continue
        if 0 < bpm < 256:
            samples.append({"time": rebased_time, "hr": bpm})
    samples.sort(key=lambda sample: sample["time"])
    return samples


def backup_activity_hr(
    database,
    garmin_client,
    workout: dict,
    source_activity_id: int | str,
    limiter=None,
) -> list[dict]:
    """Extract and durably save activity HR before any destructive action."""
    samples = fetch_activity_hr(
        garmin_client, source_activity_id, workout, limiter
    )
    if not samples:
        return []
    try:
        save_hr_backup(database, workout, samples, source_activity_id)
    except Exception as exc:
        raise HRBackupError(
            f"could not back up HR from Garmin activity {source_activity_id}: {exc}"
        ) from exc
    protected = load_hr_backup(database, workout)
    return protected if len(protected) >= len(samples) else samples


def require_activity_hr_backup(
    database,
    garmin_client,
    workout: dict,
    source_activity_id: int | str,
    limiter=None,
) -> list[dict]:
    """Return protected activity HR or stop before the source can be deleted."""
    protected = backup_activity_hr(
        database, garmin_client, workout, source_activity_id, limiter
    )
    if not protected:
        protected = load_hr_backup(database, workout)
    if not protected:
        raise HRBackupError(
            f"Garmin activity {source_activity_id} HR could not be extracted and no durable backup exists; source activity preserved"
        )
    return protected


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


def build_workout_hr(
    garmin_client,
    workout: dict,
    limiter=None,
    source_activity_id: int | str | None = None,
) -> list[dict]:
    """Top-level helper: merged HR for a workout (Hevy-preferred, watch fill).

    When replacing a matched watch activity, prefer its high-resolution FIT HR.
    Daily passive HR remains the best-effort fallback for ordinary uploads or
    when Garmin does not make the original activity downloadable.
    """
    hevy_hr = extract_hevy_hr(workout)        # AirPods / in-workout (empty today)
    activity_hr = (
        fetch_activity_hr(garmin_client, source_activity_id, workout, limiter)
        if source_activity_id is not None
        else []
    )
    if activity_hr:
        logger.info(
            "  HR: using %d samples from Garmin activity %s",
            len(activity_hr),
            source_activity_id,
        )
    watch_hr = activity_hr or fetch_watch_hr(garmin_client, workout, limiter)
    return merge_hr_sources(hevy_hr, watch_hr)


def hr_for_sync(
    db,
    garmin_client,
    workout: dict,
    config: dict,
    limiter=None,
    source_activity_id: int | str | None = None,
) -> list[dict] | None:
    """Merged HR samples for embedding in a sync's FIT — or None.

    Honors the ``hr_fusion.enabled`` toggle, reuses the dashboard's cached HR
    when present (avoids a duplicate Garmin call), and is fully best-effort:
    any failure returns None so HR never breaks a sync.
    """
    if not garmin_client or not config.get("hr_fusion", {}).get("enabled", True):
        return None
    try:
        # A matched watch recording has much denser, activity-specific HR than
        # either the dashboard cache or daily monitoring, so always try it first.
        if source_activity_id is not None:
            activity_hr = backup_activity_hr(
                db, garmin_client, workout, source_activity_id, limiter
            )
            if activity_hr:
                logger.info(
                    "  HR: using %d protected samples for Garmin activity %s",
                    len(activity_hr),
                    source_activity_id,
                )
                return merge_hr_sources(extract_hevy_hr(workout), activity_hr) or None

        backup_hr = load_hr_backup(db, workout)
        if backup_hr:
            logger.info("  HR: restored %d samples from durable backup", len(backup_hr))
            return merge_hr_sources(extract_hevy_hr(workout), backup_hr) or None
        if source_activity_id is not None:
            raise HRBackupError(
                f"Garmin activity {source_activity_id} HR could not be extracted and no durable backup exists; source activity preserved"
            )

        wid = workout.get("id")
        cached = db.get_cached_hr(wid) if wid else None
        if isinstance(cached, dict) and cached.get("hr_samples"):
            return merge_hr_sources(extract_hevy_hr(workout), cached["hr_samples"]) or None
        return build_workout_hr(garmin_client, workout, limiter) or None
    except HRBackupError:
        # A replacement must not proceed to deletion if the only high-resolution
        # source could not be saved durably.
        raise
    except Exception:
        logger.debug("HR enrichment skipped for sync", exc_info=True)
        return None
