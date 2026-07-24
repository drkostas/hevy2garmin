"""Sync orchestrator — pulls Hevy workouts, generates FIT files, uploads to Garmin."""

from __future__ import annotations

import logging
import os
import tempfile
from dataclasses import dataclass
from datetime import date as _date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from hevy2garmin import db
from hevy2garmin.config import load_config
from hevy2garmin.fit import generate_fit, _parse_timestamp
from hevy2garmin.garmin import (
    GarminUploadRejected,
    activity_matches_start_time,
    activities_for_workout,
    create_workout,
    delete_activity,
    delete_workout,
    find_activity_by_start_time,
    generate_description,
    get_client,
    list_workouts,
    rename_activity,
    schedule_workout,
    set_description,
    unschedule_workout,
    upload_fit,
)
from hevy2garmin.hevy import HevyClient
from hevy2garmin.mapper import lookup_exercise
from hevy2garmin.routine import (
    ROUTINE_DESC_MARKER,
    routine_to_garmin_workout,
    workout_content_hash,
)
from hevy2garmin.merge import attempt_merge, reset_circuit_breaker
from hevy2garmin.db_interface import Database

try:  # rate-limit HR fetches like other Garmin data calls
    from garmin_auth import RateLimiter
    _hr_limiter = RateLimiter(delay=1.0)
except Exception:  # pragma: no cover
    _hr_limiter = None

logger = logging.getLogger("hevy2garmin")


def _resolve_store() -> Any:
    """Return the active ``Database`` singleton, or the ``db`` module facade as fallback."""
    candidate = db.get_db() if callable(getattr(db, "get_db", None)) else None
    return candidate if isinstance(candidate, Database) else db


def _cache_routines_total(store: Any, count: int) -> None:
    """Cache the routine count so the dashboard can show "pending" without a Hevy call."""
    try:
        store.set_app_config("routines_total", {"count": count})
    except Exception:
        logger.debug("Could not cache routines_total", exc_info=True)


@dataclass
class SyncOneResult:
    """Outcome of syncing a single Hevy workout."""

    status: str  # "synced" | "dry_run" | "deferred" | "processing" | "needs_review" | "failed"
    activity_id: int | None = None
    sync_method: str = "upload"
    merged: bool = False
    merge_fallback: bool = False
    calories: int | None = None
    avg_hr: int | None = None
    no_hr: bool = False


def _activity_id(activity: dict) -> int | None:
    try:
        value = int(str(activity.get("activityId", "")).strip("'\""))
        return value if value > 0 else None
    except (TypeError, ValueError):
        return None


def _pending_status(pending: dict | None) -> str:
    """Normalize durable phases to the public sync result statuses."""
    phase = (pending or {}).get("phase")
    return phase if phase in {"failed", "needs_review"} else "processing"


def _terminal_payload(payload: dict, activity_id: int) -> dict:
    return {
        "garmin_activity_id": str(activity_id),
        "title": payload.get("title", ""),
        "calories": payload.get("calories"),
        "avg_hr": payload.get("avg_hr"),
        "hevy_updated_at": payload.get("hevy_updated_at"),
        "sync_method": payload.get("sync_method", "upload"),
    }


def _complete(store, hevy_id: str, payload: dict, activity_id: int) -> None:
    terminal = _terminal_payload(payload, activity_id)
    if isinstance(store, Database):
        store.complete_pending(hevy_id, terminal)
    else:  # preserves compatibility with the module facade and test doubles
        store.mark_synced(hevy_id=hevy_id, **terminal)


def finalize_pending(store, client, pending: dict) -> SyncOneResult:
    """Resume remote finalization from a durable checkpoint; never uploads."""
    wid = pending["hevy_id"]
    payload = pending.get("payload") or {}
    activity_id = int(pending["garmin_activity_id"])
    watch_id = pending.get("watch_activity_id")
    step = pending.get("next_step") or "rename"
    try:
        if step == "rename":
            rename_activity(client, activity_id, payload.get("title", "Workout"))
            step = "description" if payload.get("description_enabled") else ("delete" if watch_id else "commit")
            store.update_pending(wid, phase="finalizing", next_step=step, last_error=None)
        if step == "description":
            set_description(client, activity_id, payload.get("description", ""))
            step = "delete" if watch_id else "commit"
            store.update_pending(wid, next_step=step, last_error=None)
        if step == "delete":
            if not watch_id:
                step = "commit"
                store.update_pending(wid, next_step=step, last_error=None)
            elif int(watch_id) == activity_id:
                store.update_pending(wid, phase="needs_review", last_error="replacement equals watch activity; deletion blocked")
                return SyncOneResult(status="needs_review", activity_id=activity_id)
            else:
                try:
                    delete_activity(client, int(watch_id))
                except Exception as exc:
                    attempts = int(pending.get("delete_attempt_count") or 0) + 1
                    phase = "needs_review" if attempts >= 3 else "finalizing"
                    store.update_pending(wid, phase=phase, next_step="delete", delete_attempt_count=attempts, last_error=str(exc)[:1000])
                    return SyncOneResult(status="needs_review" if phase == "needs_review" else "processing", activity_id=activity_id)
                step = "commit"
                store.update_pending(wid, next_step=step, last_error=None)
        _complete(store, wid, payload, activity_id)
        return SyncOneResult(status="synced", activity_id=activity_id, sync_method=payload.get("sync_method", "upload"), merge_fallback=payload.get("merge_fallback", False), calories=payload.get("calories"), avg_hr=payload.get("avg_hr"))
    except Exception as exc:
        store.update_pending(wid, phase="finalizing", next_step=step, last_error=str(exc)[:1000])
        return SyncOneResult(status="processing", activity_id=activity_id)


def reconcile_pending(store, client, hevy_id: str) -> SyncOneResult:
    """Discover an accepted activity or resume finalization without uploading."""
    pending = store.get_pending(hevy_id)
    if not pending:
        raise ValueError(f"no pending operation for {hevy_id}")
    if pending.get("phase") == "failed":
        return SyncOneResult(status="failed")
    if pending.get("garmin_activity_id"):
        return finalize_pending(store, client, pending)
    upload_id = pending.get("upload_id")
    if upload_id:
        for method_name in ("get_upload_status", "get_activity_from_upload"):
            method = getattr(client, method_name, None)
            if not callable(method):
                continue
            try:
                response = method(upload_id)
                raw_id = response.get("activityId") or response.get("activity_id") or response.get("internalId") if isinstance(response, dict) else None
                resolved = int(str(raw_id).strip("'\"")) if raw_id else None
            except Exception:
                continue
            if resolved and str(resolved) not in {str(pending.get("watch_activity_id")), *map(str, pending.get("pre_upload_ids", []))}:
                store.update_pending(hevy_id, phase="finalizing", next_step="rename", garmin_activity_id=str(resolved), resolution_source="upload_id", last_error=None)
                return finalize_pending(store, client, store.get_pending(hevy_id))
    phase = pending.get("phase")
    attempt_count = int(pending.get("attempt_count") or 0)
    has_recovery_evidence = bool(
        upload_id
        or pending.get("pre_upload_ids")
        or (phase in {"processing", "finalizing", "needs_review"} and attempt_count > 0)
    )
    if not has_recovery_evidence:
        store.update_pending(
            hevy_id,
            phase="needs_review",
            last_error="no upload attempt checkpoint; refusing snapshot adoption",
        )
        return SyncOneResult(status="needs_review")
    workout = (pending.get("payload") or {}).get("workout") or {}
    try:
        activities = activities_for_workout(client, workout)
    except Exception as exc:
        store.update_pending(hevy_id, last_error=str(exc)[:1000])
        return SyncOneResult(status="processing")
    excluded = {str(x) for x in pending.get("pre_upload_ids", [])}
    if pending.get("watch_activity_id"):
        excluded.add(str(pending["watch_activity_id"]))
    candidates = [a for a in activities if _activity_id(a) and str(_activity_id(a)) not in excluded]
    start_time = workout.get("start_time") or workout.get("startTime", "")
    # Snapshot-only recovery is deliberately strict: exactly one matching
    # DEVELOPMENT strength activity at the workout's start time.
    safe = [
        a for a in candidates
        if str(a.get("manufacturer", "")).upper() == "DEVELOPMENT"
        and (a.get("activityType") or {}).get("typeKey") in {"strength_training", "other"}
        and activity_matches_start_time(a, start_time)
    ]
    if len(safe) != 1:
        if candidates:
            store.update_pending(hevy_id, phase="needs_review", last_error=f"{len(candidates)} unverified snapshot candidate(s)")
            return SyncOneResult(status="needs_review")
        return SyncOneResult(status="processing")
    activity_id = _activity_id(safe[0])
    store.update_pending(hevy_id, phase="finalizing", next_step="rename", garmin_activity_id=str(activity_id), resolution_source="snapshot", last_error=None)
    return finalize_pending(store, client, store.get_pending(hevy_id))


def _workout_within_grace(workout: dict, grace_minutes: int) -> bool:
    """True when the workout ended less than ``grace_minutes`` ago."""
    if grace_minutes <= 0:
        return False
    end_raw = workout.get("end_time") or workout.get("endTime", "")
    end_dt = _parse_timestamp(end_raw)
    if end_dt is None or end_dt.tzinfo is None:
        return False
    age_min = (datetime.now(timezone.utc) - end_dt).total_seconds() / 60.0
    return age_min < grace_minutes


def fetch_workouts(
    hevy: HevyClient,
    limit: int | None = None,
    since: str | None = None,
    fetch_all: bool = False,
) -> list[dict]:
    """Fetch workouts from Hevy with optional limit, date filter, or full history.

    Args:
        hevy: HevyClient instance.
        limit: Max workouts to fetch (None = use default or all).
        since: ISO date string — stop fetching at this date.
        fetch_all: If True, paginate through entire history.
    """
    if not fetch_all and limit and limit <= 10:
        data = hevy.get_workouts(page=1, page_size=limit)
        return data.get("workouts", [])[:limit]

    all_workouts: list[dict] = []
    page = 1
    while True:
        page_size = min(10, limit - len(all_workouts)) if limit else 10
        if page_size <= 0:
            break
        data = hevy.get_workouts(page=page, page_size=page_size)
        workouts = data.get("workouts", [])
        if not workouts:
            break
        for w in workouts:
            start = w.get("start_time") or w.get("startTime", "")
            if since and start < since:
                logger.info("Reached date boundary (%s), stopping", since)
                return all_workouts
            all_workouts.append(w)
            if limit and len(all_workouts) >= limit:
                return all_workouts
        logger.info("  Fetched %d workouts so far...", len(all_workouts))
        if page >= data.get("page_count", page):
            break
        page += 1
    return all_workouts


def _estimate_fit_stats(workout: dict, hr_samples: list[int] | None = None) -> dict:
    """Generate a FIT file in a temp dir to obtain calorie/HR estimates."""
    with tempfile.TemporaryDirectory() as tmp:
        fit_path = str(Path(tmp) / f"{workout.get('id', 'workout')}.fit")
        return generate_fit(workout, hr_samples=hr_samples, output_path=fit_path)


def sync_one_workout(
    workout: dict,
    *,
    cfg: dict[str, Any],
    garmin_client=None,
    dry_run: bool = False,
    force_upload: bool = False,
    respect_grace: bool = False,
    database: Any | None = None,
) -> SyncOneResult:
    """Sync one Hevy workout to Garmin (merge, FIT upload, or dry-run).

    When ``respect_grace`` is True (autosync/cron), too-new workouts return
    ``status="deferred"`` so a watch activity can land before we upload.

    Raises on FIT generation / upload failures so callers can map errors.
    """
    merge_store = database if database is not None else db
    wid = workout.get("id", "unknown")
    title = workout.get("title", "Workout")
    start_time = workout.get("start_time") or workout.get("startTime", "")

    if not dry_run:
        pending = merge_store.get_pending(wid)
        if isinstance(pending, dict) and pending:
            status = _pending_status(pending)
            logger.debug("Skipping %s (%s) — pending upload is %s", wid, title, pending.get("phase"))
            return SyncOneResult(status=status)

    grace_minutes = cfg.get("sync", {}).get("grace_period_minutes", 120)
    if respect_grace and _workout_within_grace(workout, grace_minutes):
        end_raw = workout.get("end_time") or workout.get("endTime", "")
        end_dt = _parse_timestamp(end_raw)
        age_min = (
            (datetime.now(timezone.utc) - end_dt).total_seconds() / 60.0
            if end_dt is not None
            else 0.0
        )
        logger.info(
            "  Deferring %s — ended %.0f min ago (< %d min grace); waiting for watch data",
            wid,
            age_min,
            grace_minutes,
        )
        return SyncOneResult(status="deferred")

    logger.info("Syncing: %s (%s)", title, wid)

    merge_mode = cfg.get("merge_mode", True)
    merge_overlap_pct = cfg.get("merge_overlap_pct", 70) / 100.0
    merge_max_drift_min = cfg.get("merge_max_drift_min", 20)
    merge_activity_types = set(cfg.get("merge_activity_types", ["strength_training"]))
    merge_watch_strategy = cfg.get("merge_watch_strategy", "replace")
    description_enabled = cfg.get("description_enabled", True)
    hr_fusion_on = cfg.get("hr_fusion", {}).get("enabled", True)

    merge_forced_fresh = False
    merge_delete_id = None
    protected_source_hr = None

    if merge_mode and garmin_client and not dry_run:
        merge_result = attempt_merge(
            garmin_client,
            workout,
            merge_store,
            overlap_threshold=merge_overlap_pct,
            max_drift_minutes=merge_max_drift_min,
            activity_types=merge_activity_types,
            watch_strategy=merge_watch_strategy,
        )
        if merge_result.merged:
            fit_stats = _estimate_fit_stats(workout)
            merge_store.mark_synced(
                hevy_id=wid,
                garmin_activity_id=str(merge_result.activity_id),
                title=title,
                calories=fit_stats.get("calories"),
                avg_hr=fit_stats.get("avg_hr"),
                hevy_updated_at=workout.get("updated_at"),
                sync_method="merge",
            )
            logger.info("  ⚡ Enhanced → Garmin activity %s", merge_result.activity_id)
            return SyncOneResult(
                status="synced",
                activity_id=merge_result.activity_id,
                sync_method="merge",
                merged=True,
                calories=fit_stats.get("calories"),
                avg_hr=fit_stats.get("avg_hr"),
            )

        logger.info("  Merge fallback: %s", merge_result.fallback_reason)
        merge_forced_fresh = merge_result.force_fresh_upload
        merge_delete_id = merge_result.delete_after_upload
        merge_fallback = True
    else:
        merge_fallback = False

    if merge_delete_id is not None and not dry_run:
        # Replace wants to delete the watch activity. That is only safe once the
        # watch's high-resolution HR is durably backed up so it can be embedded
        # in the named replacement. Runs even with HR embedding disabled:
        # disabling fusion must not discard the only recoverable recording.
        from hevy2garmin.hr import HRBackupError, backup_activity_hr

        try:
            protected_source_hr = backup_activity_hr(
                merge_store, garmin_client, workout, merge_delete_id, _hr_limiter,
            ) or None
        except HRBackupError as exc:
            logger.warning(
                "  ⚠ Could not durably back up HR from watch activity %s: %s",
                merge_delete_id, exc,
            )
            protected_source_hr = None

        if protected_source_hr is None:
            # The watch's hi-res HR could not be preserved (e.g. the FIT has no
            # per-record HR, or the download failed). Deleting the watch copy
            # would lose that HR for good, so instead of aborting the whole sync
            # (#244 regression) fall back to merging the sets into the watch
            # activity in place: the watch and its HR stay, the structured sets
            # land, and the exercise names show as placeholders. Always syncs and
            # never loses HR — only the named-exercise nicety is dropped when the
            # HR cannot be preserved.
            logger.info(
                "  ⚠ Hi-res HR unavailable for watch activity %s; keeping it and "
                "merging sets in place instead of replacing (names may show as Unknown)",
                merge_delete_id,
            )
            fallback = attempt_merge(
                garmin_client,
                workout,
                merge_store,
                overlap_threshold=merge_overlap_pct,
                max_drift_minutes=merge_max_drift_min,
                activity_types=merge_activity_types,
                watch_strategy="merge",
            )
            if fallback.merged:
                fit_stats = _estimate_fit_stats(workout)
                merge_store.mark_synced(
                    hevy_id=wid,
                    garmin_activity_id=str(fallback.activity_id),
                    title=title,
                    calories=fit_stats.get("calories"),
                    avg_hr=fit_stats.get("avg_hr"),
                    hevy_updated_at=workout.get("updated_at"),
                    sync_method="merge",
                )
                logger.info(
                    "  ⚡ Merged sets into watch activity %s (HR preserved in place)",
                    fallback.activity_id,
                )
                return SyncOneResult(
                    status="synced",
                    activity_id=fallback.activity_id,
                    sync_method="merge",
                    merged=True,
                    calories=fit_stats.get("calories"),
                    avg_hr=fit_stats.get("avg_hr"),
                )
            # In-place merge also failed. Do NOT delete the watch activity —
            # leave it intact and upload a fresh named activity alongside it, so
            # the workout still syncs and nothing is lost.
            logger.warning(
                "  In-place merge fallback failed (%s); uploading a named activity "
                "without removing the watch copy",
                fallback.fallback_reason,
            )
            merge_delete_id = None
            merge_forced_fresh = True

    hr_samples = None
    if not dry_run and hr_fusion_on:
        from hevy2garmin.hr import extract_hevy_hr, hr_for_sync, merge_hr_sources

        if protected_source_hr:
            hr_samples = merge_hr_sources(
                extract_hevy_hr(workout), protected_source_hr
            ) or None
        else:
            hr_samples = hr_for_sync(
                merge_store, garmin_client, workout, cfg, _hr_limiter
            )
        if not hr_samples:
            # One retry — the watch's daily HR for this window may not
            # have settled on the first try.
            hr_samples = hr_for_sync(
                merge_store, garmin_client, workout, cfg, _hr_limiter
            )

    with tempfile.TemporaryDirectory() as tmp:
        fit_path = str(Path(tmp) / f"{wid}.fit")
        result = generate_fit(workout, hr_samples=hr_samples, output_path=fit_path)
        logger.info(
            "  FIT: %d exercises, %d sets, %d cal",
            result["exercises"],
            result["total_sets"],
            result["calories"],
        )

        if dry_run:
            logger.info("  [DRY RUN] Would upload %s", fit_path)
            return SyncOneResult(
                status="dry_run",
                merge_fallback=merge_fallback,
                calories=result.get("calories"),
                avg_hr=result.get("avg_hr"),
            )

        existing_id = None
        uploaded = False
        exclude_ids = [merge_delete_id] if merge_delete_id else None
        if start_time and not force_upload and not merge_forced_fresh:
            existing_id = find_activity_by_start_time(
                garmin_client,
                start_time,
                exclude_activity_ids=exclude_ids,
            )

        if existing_id:
            logger.info("  Activity already on Garmin (%s), skipping upload", existing_id)
            activity_id = existing_id
        else:
            sync_method = "upload_fallback" if merge_mode else "upload"
            desc = generate_description(workout, calories=result.get("calories"), avg_hr=result.get("avg_hr")) if description_enabled else ""
            pending_payload = {
                "workout": workout,
                "title": title,
                "description": desc,
                "description_enabled": description_enabled,
                "calories": result.get("calories"),
                "avg_hr": result.get("avg_hr"),
                "hevy_updated_at": workout.get("updated_at"),
                "sync_method": sync_method,
                "merge_fallback": merge_fallback,
            }
            claimed = merge_store.claim_pending(wid, pending_payload)
            if claimed is False:
                pending = merge_store.get_pending(wid)
                return SyncOneResult(status=_pending_status(pending))
            try:
                snapshot = activities_for_workout(garmin_client, workout)
                snapshot_ids = [str(x) for a in snapshot if (x := _activity_id(a))]
            except Exception:
                merge_store.delete_pending(wid)
                raise
            merge_store.update_pending(wid, pre_upload_ids=snapshot_ids, watch_activity_id=str(merge_delete_id) if merge_delete_id else None, phase="processing", attempt_count=1)
            try:
                upload_result = upload_fit(
                    garmin_client,
                    fit_path,
                    workout_start=start_time,
                    exclude_activity_ids=exclude_ids,
                )
            except GarminUploadRejected as exc:
                merge_store.update_pending(wid, phase="failed", last_error=str(exc)[:1000])
                return SyncOneResult(status="failed", merge_fallback=merge_fallback)
            except Exception as exc:
                # The request may have reached Garmin. Park it; never resubmit automatically.
                merge_store.update_pending(wid, phase="processing", last_error=str(exc)[:1000])
                return SyncOneResult(status="processing", merge_fallback=merge_fallback)
            raw_id = upload_result.get("activity_id")
            activity_id = int(raw_id) if raw_id and str(raw_id).isdigit() else None
            upload_id = upload_result.get("upload_id")
            merge_store.update_pending(wid, upload_id=str(upload_id) if upload_id else None, last_error=None)
            if activity_id and str(activity_id) not in set(snapshot_ids) and (not merge_delete_id or activity_id != int(merge_delete_id)):
                merge_store.update_pending(wid, phase="finalizing", next_step="rename", garmin_activity_id=str(activity_id), resolution_source="response")
                if isinstance(merge_store, Database):
                    pending_after = merge_store.get_pending(wid)
                else:
                    pending_after = {
                        "hevy_id": wid, "phase": "finalizing", "next_step": "rename",
                        "garmin_activity_id": str(activity_id),
                        "watch_activity_id": str(merge_delete_id) if merge_delete_id else None,
                        "payload": pending_payload, "delete_attempt_count": 0,
                    }
                finalized = finalize_pending(merge_store, garmin_client, pending_after)
                finalized.no_hr = bool(hr_fusion_on and not hr_samples)
                return finalized
            return SyncOneResult(status="processing", merge_fallback=merge_fallback)

        if activity_id:
            rename_activity(garmin_client, activity_id, title)
            if description_enabled:
                desc = generate_description(
                    workout,
                    calories=result.get("calories"),
                    avg_hr=result.get("avg_hr"),
                )
                set_description(garmin_client, activity_id, desc)

        sync_method = "upload_fallback" if merge_mode else "upload"
        merge_store.mark_synced(
            hevy_id=wid,
            garmin_activity_id=str(activity_id) if activity_id else None,
            title=title,
            calories=result.get("calories"),
            avg_hr=result.get("avg_hr"),
            hevy_updated_at=workout.get("updated_at"),
            sync_method=sync_method,
        )
        no_hr = bool(hr_fusion_on and uploaded and not hr_samples)
        if no_hr:
            logger.warning(
                "  ⚠ No heart-rate data available for %s — activity uploaded without HR",
                wid,
            )
        logger.info("  ✓ Synced → Garmin activity %s", activity_id)
        return SyncOneResult(
            status="synced",
            activity_id=activity_id,
            sync_method=sync_method,
            merge_fallback=merge_fallback,
            calories=result.get("calories"),
            avg_hr=result.get("avg_hr"),
            no_hr=no_hr,
        )


def sync(
    config: dict[str, Any] | None = None,
    limit: int | None = None,
    since: str | None = None,
    fetch_all: bool = False,
    dry_run: bool = False,
    respect_grace: bool = True,
    record_log: bool = True,
    log_trigger: str | None = None,
    **overrides: Any,
) -> dict:
    """Sync Hevy workouts to Garmin Connect.

    Args:
        config: Config dict (loaded from file if None).
        limit: Max workouts to sync.
        since: ISO date — sync workouts after this date.
        fetch_all: Sync entire Hevy history.
        dry_run: Generate FIT files but don't upload.
        respect_grace: Defer too-new workouts when True (autosync/cron).
        record_log: Persist a sync_log row when True.
        log_trigger: Override sync_log trigger (default: cli or github-actions).
        **overrides: Override config values (hevy_api_key, garmin_email, garmin_password).

    Returns:
        Dict with sync stats: synced, skipped, failed, total, unmapped.
    """
    cfg = config or load_config()
    store = _resolve_store()
    hevy_api_key = overrides.get("hevy_api_key") or cfg.get("hevy_api_key")
    garmin_email = overrides.get("garmin_email") or cfg.get("garmin_email")
    garmin_password = overrides.get("garmin_password") or cfg.get("garmin_password", "")
    garmin_token_dir = cfg.get("garmin_token_dir", "~/.garminconnect")
    skip_existing = cfg.get("sync", {}).get("skip_existing", True)

    if not limit and not fetch_all and not since:
        limit = cfg.get("sync", {}).get("default_limit", 10)

    hevy = HevyClient(api_key=hevy_api_key)
    total_count = hevy.get_workout_count()
    logger.info("Hevy reports %d total workouts", total_count)

    workouts = fetch_workouts(hevy, limit=limit, since=since, fetch_all=fetch_all)
    logger.info("Fetched %d workouts to process", len(workouts))

    garmin_client = None
    if not dry_run:
        logger.info("Authenticating with Garmin Connect...")
        garmin_client = get_client(garmin_email, garmin_password, garmin_token_dir)
        logger.info("Authenticated successfully")

    merge_mode = cfg.get("merge_mode", True)
    stats = {
        "synced": 0,
        "skipped": 0,
        "failed": 0,
        "total": len(workouts),
        "unmapped": [],
        "merged": 0,
        "merge_fallback": 0,
        "deferred": 0,
        "no_hr": 0,
        "duplicates": 0,
        "processing": 0,
        "needs_review": 0,
    }

    if merge_mode:
        reset_circuit_breaker()
        logger.info("Merge mode enabled — will try to enhance watch activities")

    pending_by_id = {}
    if not dry_run:
        pending_by_id = {row["hevy_id"]: row for row in store.list_pending()}

    for workout in workouts:
        wid = workout.get("id", "unknown")
        title = workout.get("title", "Workout")

        if skip_existing and store.is_synced(wid):
            logger.debug("Skipping %s (%s) — already synced", wid, title)
            stats["skipped"] += 1
            continue

        pending = pending_by_id.get(wid)
        if pending:
            phase = pending.get("phase")
            bucket = _pending_status(pending)
            logger.debug("Skipping %s (%s) — pending upload is %s", wid, title, phase)
            stats[bucket] += 1
            continue

        for ex in workout.get("exercises", []):
            ex_name = ex.get("title") or ex.get("name", "")
            cat, _, _ = lookup_exercise(ex_name, ex.get("exercise_template_id"))
            if cat == 65534 and ex_name not in stats["unmapped"]:
                stats["unmapped"].append(ex_name)

        try:
            one = sync_one_workout(
                workout,
                cfg=cfg,
                garmin_client=garmin_client,
                dry_run=dry_run,
                respect_grace=respect_grace,
                database=store,
            )
            if one.status == "deferred":
                stats["deferred"] += 1
                continue
            if one.status == "processing":
                stats["processing"] += 1
                continue
            if one.status == "needs_review":
                stats["needs_review"] += 1
                continue
            if one.status == "failed":
                stats["failed"] += 1
                continue

            if one.status == "dry_run":
                stats["synced"] += 1
            elif one.merged:
                stats["synced"] += 1
                stats["merged"] += 1
            else:
                stats["synced"] += 1
                if one.merge_fallback:
                    stats["merge_fallback"] += 1
            if one.no_hr:
                stats["no_hr"] += 1
        except Exception as e:
            logger.error("  ✗ Failed to sync %s: %s", wid, e)
            stats["failed"] += 1

    if stats["unmapped"]:
        logger.warning("\nUnmapped exercises: %s", ", ".join(stats["unmapped"]))
        logger.warning(
            'Add custom mappings: hevy2garmin map "Exercise Name" --category N --subcategory N'
        )

    # Log-only duplicate scan (best-effort; never breaks a sync).
    if not dry_run and garmin_client:
        try:
            from hevy2garmin.reconcile import detect_duplicates
            dups = detect_duplicates(garmin_client, workouts, _hr_limiter)
            stats["duplicates"] = len(dups)
            if dups:
                logger.warning(
                    "Found %d possible duplicate activity pair(s) from past races",
                    len(dups),
                )
        except Exception:
            logger.debug("duplicate scan skipped", exc_info=True)

    if record_log:
        trigger = log_trigger
        if trigger is None:
            trigger = "cli"
            if os.environ.get("GITHUB_ACTIONS"):
                trigger = "github-actions"
        store.record_sync_log(
            synced=stats["synced"],
            skipped=stats["skipped"],
            failed=stats["failed"],
            trigger=trigger,
        )

    return stats


def fetch_all_routines(hevy: HevyClient, page_size: int = 10) -> list[dict]:
    """Fetch every Hevy routine (paginated). Returns a list of routine dicts."""
    routines: list[dict] = []
    page = 1
    while True:
        data = hevy.get_routines(page, page_size)
        batch = data.get("routines", [])
        routines.extend(batch)
        logger.info("  Routines page %d/%s — %d", page, data.get("page_count", "?"), len(batch))
        if page >= data.get("page_count", page):
            break
        page += 1
    return routines


def _is_not_found(exc: Exception) -> bool:
    """True only when ``exc`` is a Garmin HTTP 404 (the calendar entry is already gone).

    garth raises ``requests`` ``HTTPError`` carrying ``response.status_code``; trust only
    that. A missing status is treated as transient (keep the row and re-raise) rather than
    string-matching "404" in the message — a transient error whose text merely contains
    404 (a scheduleId, a retry delay like ``40400ms``) would otherwise drop the row, the
    exact orphan this guard prevents.
    """
    resp = getattr(exc, "response", None)
    return resp is not None and getattr(resp, "status_code", None) == 404


def _reschedule_routine(
    client, store, hevy_routine_id, workout_id, dates: list[str], *, unschedule_prior: bool = True
) -> None:
    """Book ``dates`` for a routine's workout, replacing its prior calendar entries.

    Garmin appends a fresh calendar entry on every schedule POST (no server-side
    dedup), so re-scheduling would stack duplicates. We unschedule every entry we
    previously tracked for this routine first, then book the new dates and record
    the ids Garmin returns so the next reschedule can clean them up too.

    ``unschedule_prior=False`` skips the unschedule calls — used when the workout was
    just deleted (its calendar entries already cascaded away on Garmin), so hitting
    the schedule endpoint for each stale id would only waste rate-limited 404s.
    """
    if unschedule_prior:
        for old_id in store.get_routine_schedule_ids(hevy_routine_id):
            try:
                unschedule_workout(client, old_id)
            except Exception:
                logger.warning("  Could not unschedule stale calendar entry %s", old_id)
    store.clear_routine_schedules(hevy_routine_id)
    for day in dates:
        schedule_id = schedule_workout(client, workout_id, day)
        if schedule_id is not None:
            store.add_routine_schedule(hevy_routine_id, str(schedule_id), day)


def _build_library_by_name(garmin_client) -> dict[str, list[dict]]:
    """Map ``workoutName`` -> ``[{"id", "description"}, ...]`` of the workouts already in
    the Garmin library, so a sync can reconcile against Garmin's actual state before
    creating (not just the local DB row) — a DB reset or a crash in the create->persist
    window would otherwise leave an untracked workout that gets recreated as a duplicate.
    Best-effort: if the listing fails we fall back to DB-only dedup.
    """
    library_by_name: dict[str, list[dict]] = {}
    try:
        for w in list_workouts(garmin_client, limit=999):
            name, wid = w.get("workoutName"), w.get("workoutId")
            if name and wid is not None:
                library_by_name.setdefault(name, []).append(
                    {"id": str(wid), "description": w.get("description") or ""}
                )
    except Exception:
        logger.warning("Could not list Garmin workouts; falling back to DB-only dedup")
    return library_by_name


def _sync_one_routine(
    routine: dict,
    store,
    garmin_client,
    library_by_name: dict[str, list[dict]],
    *,
    weight_unit: str,
    default_rest_seconds: int | None,
    schedule_date: str | None = None,
    force: bool = False,
    dry_run: bool = False,
) -> dict:
    """Sync one Hevy routine to a Garmin planned workout.

    Returns ``{"outcome": "created"|"updated"|"skipped"|"failed", "scheduled": 0|1}``.
    Shared by :func:`sync_routines` (bulk) and :func:`sync_routine` (single) so both
    paths behave identically. Catches its own errors and reports ``"failed"``.
    """
    rid = routine.get("id", "unknown")
    title = routine.get("title") or routine.get("name") or "Routine"
    updated_at = routine.get("updated_at")
    try:
        payload = routine_to_garmin_workout(
            routine, weight_unit=weight_unit, default_rest_seconds=default_rest_seconds
        )
        content_hash = workout_content_hash(payload)

        # Skip when the generated payload is byte-for-byte what we last synced AND the
        # workout is fully landed. A row left in 'schedule_pending' isn't done, so we
        # don't skip it — the next sync retries the schedule below. --force overrides.
        existing = store.get_synced_routine(rid)
        content_synced = bool(existing and existing.get("content_hash") == content_hash)
        already_done = content_synced and (existing.get("status") or "success") == "success"
        if not force and already_done:
            logger.debug("Skipping routine %s (%s) — unchanged", rid, title)
            return {"outcome": "skipped", "scheduled": 0}

        # A prior sync record means this run replaces it (an update), not a new create.
        outcome = "updated" if existing else "created"

        if dry_run:
            verb = "update" if existing else "create"
            logger.info(
                "[dry-run] Would %s Garmin workout '%s' with %d step(s)",
                verb, title, len(payload["workoutSegments"][0]["workoutSteps"]),
            )
            return {"outcome": outcome, "scheduled": 0}

        # Content changed (or forced) — drop the stale Garmin workout(s) first: the
        # DB-tracked id plus any same-named library entry carrying our provenance marker
        # (an orphan from a crash or DB reset). Same-named entries without the marker are
        # the user's own workouts and are left untouched.
        stale_ids = set()
        if existing and existing.get("garmin_workout_id"):
            stale_ids.add(str(existing["garmin_workout_id"]))
        for entry in library_by_name.get(payload["workoutName"], []):
            if ROUTINE_DESC_MARKER in entry["description"]:
                stale_ids.add(entry["id"])
        for wid in stale_ids:
            try:
                delete_workout(garmin_client, wid)
            except Exception:
                logger.warning("  Could not delete stale/orphan workout %s", wid)

        workout_id = create_workout(garmin_client, payload)
        if workout_id is None:
            logger.warning("  Garmin did not return a workoutId for '%s'", title)
            return {"outcome": "failed", "scheduled": 0}

        # Recreating the workout drops the calendar entries the old one had, so re-apply
        # the prior schedule when this run doesn't set a new one. An explicit schedule_date
        # overrides; otherwise restore every date the routine had booked (recurring), with
        # a fallback to the single stored date for rows predating per-entry tracking. Only
        # an explicit schedule_date counts toward the "scheduled" stat.
        if schedule_date:
            dates_to_book = [schedule_date]
        else:
            dates_to_book = store.get_routine_scheduled_dates(rid)
            if not dates_to_book and (existing or {}).get("scheduled_date"):
                dates_to_book = [existing["scheduled_date"]]
        effective_schedule_date = min(dates_to_book) if dates_to_book else None

        scheduled = 0
        if dates_to_book:
            # Persist the created workout before scheduling, marked 'schedule_pending', so
            # a schedule failure leaves it tracked (recovered next sync) not orphaned.
            store.mark_routine_synced(
                rid, garmin_workout_id=str(workout_id), title=title,
                hevy_updated_at=updated_at, scheduled_date=effective_schedule_date,
                content_hash=content_hash, status="schedule_pending",
            )
            # The old workout (and its calendar entries) was just deleted, so its tracked
            # ids are already gone — clear+rebook without a rate-limited unschedule per id.
            _reschedule_routine(
                garmin_client, store, rid, workout_id, dates_to_book, unschedule_prior=False
            )
            if schedule_date:
                scheduled = 1

        store.mark_routine_synced(
            rid, garmin_workout_id=str(workout_id), title=title,
            hevy_updated_at=updated_at, scheduled_date=effective_schedule_date,
            content_hash=content_hash,
        )
        return {"outcome": outcome, "scheduled": scheduled}
    except Exception:
        logger.exception("Failed to sync routine %s (%s)", rid, title)
        return {"outcome": "failed", "scheduled": 0}


def sync_routines(
    config: dict[str, Any] | None = None,
    dry_run: bool = False,
    schedule_date: str | None = None,
    force: bool = False,
    **overrides: Any,
) -> dict:
    """Sync Hevy routines (templates) to Garmin as planned workouts.

    Each Hevy routine becomes a planned workout in the Garmin Workouts library
    (not an uploaded activity). A routine is skipped when the workout payload it
    now produces hashes identically to the last one synced; otherwise the old
    Garmin workout is deleted and recreated. Because the hash covers the
    *generated payload*, changes to this builder (e.g. new rest steps) re-sync
    automatically without ``--force``. When ``schedule_date`` (an ISO
    ``YYYY-MM-DD``) is given, each created workout is also scheduled onto the
    Garmin calendar for that date; otherwise only the library entry is created.

    Args:
        config: Config dict (loaded from file if None).
        dry_run: Build payloads and log them, but don't call Garmin.
        schedule_date: Optional ``YYYY-MM-DD`` to schedule the workouts.
        force: Re-create every routine even when its payload hash is unchanged
            (deletes the old Garmin workout first).
        **overrides: Override config values (hevy_api_key, garmin_email, garmin_password).

    Returns:
        Dict with stats: created, skipped, failed, scheduled, total.
    """
    cfg = config or load_config()
    store = _resolve_store()
    hevy_api_key = overrides.get("hevy_api_key") or cfg.get("hevy_api_key")
    garmin_email = overrides.get("garmin_email") or cfg.get("garmin_email")
    garmin_password = overrides.get("garmin_password") or cfg.get("garmin_password", "")
    garmin_token_dir = cfg.get("garmin_token_dir", "~/.garminconnect")
    # ``or {}`` guards against a config key present but explicitly null.
    weight_unit = (cfg.get("sync") or {}).get("weight_unit", "kilogram")
    # Fallback rest between sets when a Hevy routine doesn't specify one, mirroring
    # the FIT timing default used for logged workouts.
    default_rest_seconds = (cfg.get("timing") or {}).get("rest_between_sets_seconds", 75)

    hevy = HevyClient(api_key=hevy_api_key)
    routines = fetch_all_routines(hevy)
    logger.info("Fetched %d routines to process", len(routines))
    _cache_routines_total(store, len(routines))

    garmin_client = None
    library_by_name: dict[str, list[dict]] = {}
    if not dry_run:
        logger.info("Authenticating with Garmin Connect...")
        garmin_client = get_client(garmin_email, garmin_password, garmin_token_dir)
        logger.info("Authenticated successfully")
        library_by_name = _build_library_by_name(garmin_client)

    stats = {
        "created": 0,
        "updated": 0,
        "skipped": 0,
        "failed": 0,
        "scheduled": 0,
        "total": len(routines),
    }

    for routine in routines:
        res = _sync_one_routine(
            routine, store, garmin_client, library_by_name,
            weight_unit=weight_unit, default_rest_seconds=default_rest_seconds,
            schedule_date=schedule_date, force=force, dry_run=dry_run,
        )
        stats[res["outcome"]] += 1
        stats["scheduled"] += res["scheduled"]

    logger.info(
        "Routine sync done — created=%d updated=%d skipped=%d failed=%d scheduled=%d",
        stats["created"], stats["updated"], stats["skipped"], stats["failed"], stats["scheduled"],
    )
    return stats


def sync_routine(
    hevy_routine_id: str,
    *,
    config: dict[str, Any] | None = None,
    force: bool = False,
    **overrides: Any,
) -> dict:
    """Sync a single Hevy routine to Garmin (the per-row "Sync" action).

    Fetches the routine from Hevy, reconciles against the Garmin library, and runs the
    same per-routine logic as :func:`sync_routines`. Returns
    ``{"outcome": ..., "row": {id, title, exercises, exercise_count, synced, scheduled_date}}`` —
    ``row`` is a render-ready dict for the routines card. Raises ``ValueError`` when the
    routine isn't found in the Hevy account.
    """
    cfg = config or load_config()
    store = _resolve_store()
    hevy_api_key = overrides.get("hevy_api_key") or cfg.get("hevy_api_key")
    garmin_email = overrides.get("garmin_email") or cfg.get("garmin_email")
    garmin_password = overrides.get("garmin_password") or cfg.get("garmin_password", "")
    garmin_token_dir = cfg.get("garmin_token_dir", "~/.garminconnect")
    weight_unit = (cfg.get("sync") or {}).get("weight_unit", "kilogram")
    default_rest_seconds = (cfg.get("timing") or {}).get("rest_between_sets_seconds", 75)

    hevy = HevyClient(api_key=hevy_api_key)
    routine = next(
        (r for r in fetch_all_routines(hevy) if r.get("id") == hevy_routine_id), None
    )
    if routine is None:
        raise ValueError("Routine not found in Hevy")

    logger.info("Authenticating with Garmin Connect...")
    garmin_client = get_client(garmin_email, garmin_password, garmin_token_dir)
    library_by_name = _build_library_by_name(garmin_client)
    res = _sync_one_routine(
        routine, store, garmin_client, library_by_name,
        weight_unit=weight_unit, default_rest_seconds=default_rest_seconds,
        schedule_date=None, force=force, dry_run=False,
    )

    record = store.get_synced_routine(hevy_routine_id)
    exercises = [
        {
            "name": ex.get("title") or ex.get("name") or "Exercise",
            "sets": len(ex.get("sets") or []),
        }
        for ex in (routine.get("exercises") or [])
    ]
    row = {
        "id": hevy_routine_id,
        "title": routine.get("title") or routine.get("name") or "Routine",
        "exercises": exercises,
        "exercise_count": len(exercises),
        "synced": record is not None,
        "scheduled_date": (record or {}).get("scheduled_date"),
    }
    logger.info("Synced routine %s — %s", hevy_routine_id, res["outcome"])
    return {"outcome": res["outcome"], "row": row}


# Cap on recurring occurrences, so a typo in "weeks" can't schedule years of entries.
MAX_SCHEDULE_OCCURRENCES = 52


def routine_schedule_dates(
    mode: str,
    *,
    date: str | None = None,
    weekday: int | str | None = None,
    start_date: str | None = None,
    weeks: int | str | None = None,
) -> list[str]:
    """Compute the calendar dates to schedule a routine on.

    ``mode="once"`` returns ``[date]``. ``mode="recurring"`` returns one date per
    week for ``weeks`` weeks, on the given ``weekday`` (0=Monday .. 6=Sunday),
    starting at the first matching weekday on or after ``start_date``. All inputs
    are ISO ``YYYY-MM-DD`` strings; raises ``ValueError`` on missing/invalid data.
    """
    if mode == "once":
        if not date:
            raise ValueError("a date is required for a one-off schedule")
        return [_date.fromisoformat(date).isoformat()]

    if mode == "recurring":
        if weekday is None or start_date in (None, "") or weeks in (None, ""):
            raise ValueError("weekday, start_date and weeks are required for a recurring schedule")
        weekday = int(weekday)
        weeks = int(weeks)
        if not 0 <= weekday <= 6:
            raise ValueError("weekday must be 0 (Monday) .. 6 (Sunday)")
        if weeks < 1:
            raise ValueError("weeks must be at least 1")
        weeks = min(weeks, MAX_SCHEDULE_OCCURRENCES)
        start = _date.fromisoformat(start_date)
        first = start + timedelta(days=(weekday - start.weekday()) % 7)
        return [(first + timedelta(weeks=i)).isoformat() for i in range(weeks)]

    raise ValueError(f"unknown schedule mode: {mode!r}")


def schedule_routine(
    hevy_routine_id: str,
    dates: list[str],
    *,
    config: dict[str, Any] | None = None,
    **overrides: Any,
) -> dict:
    """Schedule an already-synced routine's Garmin workout on the given dates.

    Looks up the routine's ``garmin_workout_id`` (it must have been synced first),
    then calls the Garmin schedule endpoint once per date. Persists the earliest
    date on the routine record for display. Returns
    ``{"scheduled": n, "workout_id": id, "dates": [...]}``.
    """
    if not dates:
        raise ValueError("no dates to schedule")

    cfg = config or load_config()
    store = _resolve_store()

    record = store.get_synced_routine(hevy_routine_id)
    if not record or not record.get("garmin_workout_id"):
        raise ValueError("Routine is not synced yet — sync it before scheduling.")
    workout_id = record["garmin_workout_id"]

    garmin_email = overrides.get("garmin_email") or cfg.get("garmin_email")
    garmin_password = overrides.get("garmin_password") or cfg.get("garmin_password", "")
    garmin_token_dir = cfg.get("garmin_token_dir", "~/.garminconnect")

    logger.info("Authenticating with Garmin Connect...")
    client = get_client(garmin_email, garmin_password, garmin_token_dir)

    # Unschedule the routine's prior calendar entries before booking the new dates,
    # so re-scheduling replaces rather than stacks duplicate entries (Garmin appends).
    _reschedule_routine(client, store, hevy_routine_id, workout_id, dates)

    store.mark_routine_synced(
        hevy_routine_id,
        garmin_workout_id=workout_id,
        title=record.get("title", ""),
        hevy_updated_at=record.get("hevy_updated_at"),
        scheduled_date=min(dates),
        content_hash=record.get("content_hash"),
    )
    logger.info("Scheduled routine %s on %d date(s)", hevy_routine_id, len(dates))
    return {"scheduled": len(dates), "workout_id": workout_id, "dates": dates}


def unschedule_routine_entry(
    hevy_routine_id: str,
    schedule_id: str,
    *,
    config: dict[str, Any] | None = None,
    **overrides: Any,
) -> None:
    """Remove one Garmin calendar entry of a routine and stop tracking it.

    Unscheduling is best-effort — an entry already gone on Garmin just 404s — but
    the local row is always dropped afterward so the UI reflects the removal.
    """
    cfg = config or load_config()
    store = _resolve_store()
    garmin_email = overrides.get("garmin_email") or cfg.get("garmin_email")
    garmin_password = overrides.get("garmin_password") or cfg.get("garmin_password", "")
    garmin_token_dir = cfg.get("garmin_token_dir", "~/.garminconnect")

    logger.info("Authenticating with Garmin Connect...")
    client = get_client(garmin_email, garmin_password, garmin_token_dir)
    try:
        unschedule_workout(client, schedule_id)
    except Exception as e:
        # A 404 means the entry is already gone on Garmin — safe to drop our row. Any
        # other error (429/500/network) is transient: keep the row and re-raise so the
        # caller surfaces the failure and the user can retry, instead of orphaning a
        # calendar entry we can no longer see or remove.
        if not _is_not_found(e):
            raise
        logger.info("  Calendar entry %s already gone on Garmin", schedule_id)
    store.delete_routine_schedule(hevy_routine_id, schedule_id)
    logger.info("Unscheduled routine %s entry %s", hevy_routine_id, schedule_id)
