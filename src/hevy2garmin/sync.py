"""Sync orchestrator — pulls Hevy workouts, generates FIT files, uploads to Garmin."""

from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path
from typing import Any

from hevy2garmin import db
from hevy2garmin.config import load_config
from hevy2garmin.fit import generate_fit
from hevy2garmin.garmin import (
    find_activity_by_start_time,
    generate_description,
    get_client,
    rename_activity,
    set_description,
    upload_fit,
)
from hevy2garmin.hevy import HevyClient
from hevy2garmin.mapper import lookup_exercise

logger = logging.getLogger("hevy2garmin")


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


def sync(
    config: dict[str, Any] | None = None,
    limit: int | None = None,
    since: str | None = None,
    fetch_all: bool = False,
    dry_run: bool = False,
    **overrides: Any,
) -> dict:
    """Sync Hevy workouts to Garmin Connect.

    Args:
        config: Config dict (loaded from file if None).
        limit: Max workouts to sync.
        since: ISO date — sync workouts after this date.
        fetch_all: Sync entire Hevy history.
        dry_run: Generate FIT files but don't upload.
        **overrides: Override config values (hevy_api_key, garmin_email, garmin_password).

    Returns:
        Dict with sync stats: synced, skipped, failed, total, unmapped.
    """
    cfg = config or load_config()
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

    stats = {"synced": 0, "skipped": 0, "failed": 0, "total": len(workouts), "unmapped": []}

    for workout in workouts:
        wid = workout.get("id", "unknown")
        title = workout.get("title", "Workout")
        start_time = workout.get("start_time") or workout.get("startTime", "")

        if skip_existing and db.is_synced(wid):
            logger.debug("Skipping %s (%s) — already synced", wid, title)
            stats["skipped"] += 1
            continue

        logger.info("Syncing: %s (%s)", title, wid)

        # Track unmapped exercises
        for ex in workout.get("exercises", []):
            ex_name = ex.get("title") or ex.get("name", "")
            cat, _, _ = lookup_exercise(ex_name)
            if cat == 65534 and ex_name not in stats["unmapped"]:
                stats["unmapped"].append(ex_name)

        try:
            with tempfile.TemporaryDirectory() as tmp:
                fit_path = str(Path(tmp) / f"{wid}.fit")
                result = generate_fit(workout, hr_samples=None, output_path=fit_path)
                logger.info(
                    "  FIT: %d exercises, %d sets, %d cal",
                    result["exercises"], result["total_sets"], result["calories"],
                )

                if dry_run:
                    logger.info("  [DRY RUN] Would upload %s", fit_path)
                    stats["synced"] += 1
                    continue

                # Dedup: check if activity already exists on Garmin
                existing_id = find_activity_by_start_time(garmin_client, start_time) if start_time else None
                if existing_id:
                    logger.info("  Activity already on Garmin (%s), skipping upload", existing_id)
                    activity_id = existing_id
                else:
                    upload_result = upload_fit(garmin_client, fit_path, workout_start=start_time)
                    activity_id = upload_result.get("activity_id")

                if activity_id:
                    rename_activity(garmin_client, activity_id, title)
                    desc = generate_description(
                        workout,
                        calories=result.get("calories"),
                        avg_hr=result.get("avg_hr"),
                    )
                    set_description(garmin_client, activity_id, desc)

                db.mark_synced(
                    hevy_id=wid,
                    garmin_activity_id=str(activity_id) if activity_id else None,
                    title=title,
                    calories=result.get("calories"),
                    avg_hr=result.get("avg_hr"),
                    hevy_updated_at=workout.get("updated_at"),
                )
                stats["synced"] += 1
                logger.info("  ✓ Synced → Garmin activity %s", activity_id)

        except Exception as e:
            logger.error("  ✗ Failed to sync %s: %s", wid, e)
            stats["failed"] += 1

    if stats["unmapped"]:
        logger.warning("\nUnmapped exercises: %s", ", ".join(stats["unmapped"]))
        logger.warning("Add custom mappings: hevy2garmin map \"Exercise Name\" --category N --subcategory N")

    # Record to sync log (shows up in dashboard)
    trigger = "cli"
    if os.environ.get("GITHUB_ACTIONS"):
        trigger = "github-actions"
    db.record_sync_log(
        synced=stats["synced"],
        skipped=stats["skipped"],
        failed=stats["failed"],
        trigger=trigger,
    )

    return stats
