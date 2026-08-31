"""Server-rendered pages: the dashboard, setup, and the browsing views.

Every route here renders a full HTML page (or, for the heart-rate endpoint, the
JSON one of those pages fetches). They are grouped away from
:mod:`hevy2garmin.server` because the module that owns the app, the middleware
and the HTMX fragment endpoints does not need to own the page bodies too.

The routes are collected on an ``APIRouter`` that ``server`` includes, so the
dependency runs one way: ``server`` imports ``pages``, never the reverse.
"""

from __future__ import annotations

import logging
import os
import re

from fastapi import APIRouter, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse

from hevy2garmin import autosync, db, mapper
from hevy2garmin.config import load_config, save_config
from hevy2garmin.demo import is_demo_mode
from hevy2garmin.ratelimit import record_rate_limit, cooldown_remaining, clear_rate_limit, format_cooldown
from hevy2garmin.webctx import _render, is_https

logger = logging.getLogger("hevy2garmin")

router = APIRouter()


# ── Unmapped-exercise cache ─────────────────────────────────────────────────
# Only the pages below read this, so it moved out of server.py with them.

_unmapped_cache: list[tuple[str, int]] | None = None
_unmapped_cache_time: float = 0


def invalidate_unmapped_cache() -> None:
    """Drop the process-local unmapped list after a mapping/data change."""
    global _unmapped_cache, _unmapped_cache_time
    _unmapped_cache = None
    _unmapped_cache_time = 0


def _get_unmapped_exercises() -> list[tuple[str, int]]:
    """Get unmapped exercises. Uses DB cache (updated during sync).

    Exercises that now have a mapping are filtered out, so a freshly mapped one
    leaves the list immediately instead of lingering until the next sync (#172).
    """
    from hevy2garmin.mapper import lookup_exercise

    def _still_unmapped(items):
        return sorted(
            ((name, count) for name, count in items if lookup_exercise(name)[0] == 65534),
            key=lambda x: -x[1],
        )

    # Try DB cache first (instant)
    try:
        _db = db.get_db()
        cached = _db.get_app_config("unmapped_exercises")
        if cached and isinstance(cached, dict):
            return _still_unmapped(cached.items())
    except Exception:
        pass

    # Fallback: in-memory cache (local installs)
    global _unmapped_cache, _unmapped_cache_time
    import time as _t
    if _unmapped_cache is not None and (_t.time() - _unmapped_cache_time) < 600:
        return _unmapped_cache

    config = load_config()
    unmapped: dict[str, int] = {}
    try:
        from hevy2garmin.hevy import HevyClient
        from hevy2garmin.mapper import lookup_exercise
        hevy = HevyClient(api_key=config.get("hevy_api_key"))
        for pg in range(1, 6):
            data = hevy.get_workouts(page=pg, page_size=10)
            for w in data.get("workouts", []):
                for ex in w.get("exercises", []):
                    name = ex.get("title") or ex.get("name", "")
                    if name and lookup_exercise(name, ex.get("exercise_template_id"))[0] == 65534:
                        unmapped[name] = unmapped.get(name, 0) + 1
            if pg >= data.get("page_count", 1):
                break
    except Exception:
        pass

    _unmapped_cache = sorted(unmapped.items(), key=lambda x: -x[1])
    _unmapped_cache_time = _t.time()
    return _unmapped_cache


# ── Pages ────────────────────────────────────────────────────────────────────

@router.get("/", response_class=HTMLResponse)
async def dashboard(request: Request):
    config = load_config()
    terminal_counts = db.get_terminal_counts()
    synced_count = terminal_counts["uploaded"]
    terminal_count = terminal_counts["terminal"]
    recent = db.get_recent_synced(5)

    # Check garmin_connected FIRST (DB/file check only, no HTTP to Garmin)
    garmin_connected = False
    try:
        if db.get_database_url():
            _db = db.get_db()
            if hasattr(_db, '_get_conn'):
                with _db._get_conn() as conn:
                    with conn.cursor() as cur:
                        cur.execute("SELECT 1 FROM platform_credentials WHERE platform = 'garmin_tokens' AND credentials != '{}' LIMIT 1")
                        garmin_connected = cur.fetchone() is not None
        else:
            from pathlib import Path
            token_dir = Path(config.get("garmin_token_dir", "~/.garminconnect")).expanduser()
            # garmin-auth >= 0.3.0 uses a single DI OAuth token file
            garmin_connected = (token_dir / "garmin_tokens.json").exists()
    except Exception:
        pass

    hevy_total = 0
    matched_count = synced_count  # Use DB count (fast) instead of Garmin API (slow)
    try:
        # Try cached count from DB first (instant), fall back to Hevy API
        _db = db.get_db()
        cached = _db.get_app_config("hevy_total")
        if cached and isinstance(cached, dict):
            hevy_total = cached.get("count", 0)
        else:
            from hevy2garmin.hevy import HevyClient
            hevy = HevyClient(api_key=config.get("hevy_api_key"))
            hevy_total = hevy.get_workout_count()
            _db.set_app_config("hevy_total", {"count": hevy_total})
    except Exception:
        pass
    mapping_count = 0
    try:
        from hevy2garmin.mapper import HEVY_TO_GARMIN, _custom_mappings, _ensure_custom_loaded
        _ensure_custom_loaded()
        mapping_count = len(HEVY_TO_GARMIN) + len(_custom_mappings)
    except Exception:
        pass
    garmin_cooldown = 0
    garmin_cooldown_str = ""
    try:
        garmin_cooldown = cooldown_remaining(db.get_db())
        if garmin_cooldown > 0:
            garmin_cooldown_str = format_cooldown(garmin_cooldown)
    except Exception:
        pass

    # Routine summary — all DB-backed (no Hevy call). "pending" needs the total
    # routine count, cached by the /routines page and by routine sync.
    routine_stats = {"synced": 0, "scheduled": 0}
    recent_routines: list = []
    routines_pending = None
    try:
        routine_stats = db.get_routine_stats()
        recent_routines = db.get_recent_synced_routines(5)
        cached_total = db.get_app_config("routines_total")
        if isinstance(cached_total, dict) and isinstance(cached_total.get("count"), int):
            routines_pending = max(0, cached_total["count"] - routine_stats["synced"])
    except Exception:
        logger.warning("Could not build routine summary for dashboard", exc_info=True)

    return _render(
        "dashboard.html",
        routine_stats=routine_stats,
        recent_routines=recent_routines,
        routines_pending=routines_pending,
        synced_count=synced_count,
        matched_count=matched_count,
        terminal_count=terminal_count,
        manual_count=terminal_counts["manual"],
        skipped_count=terminal_counts["skipped"],
        hevy_total=hevy_total,
        recent=recent,
        auto_sync=autosync.status(),
        sync_log=db.get_sync_log(10),
        mapping_count=mapping_count,
        garmin_connected=garmin_connected,
        needs_actions_setup=False,
        garmin_cooldown=garmin_cooldown,
        garmin_cooldown_str=garmin_cooldown_str,
    )



def _direct_garmin_login() -> bool:
    """Whether the dashboard collects Garmin credentials itself.

    Off by default: the hosted deployment hands the login to the exchange
    worker so the app never sees a Garmin password. Self-hosted installs can
    opt in, keeping the credentials on their own machine.
    """
    return os.environ.get("H2G_DIRECT_GARMIN_LOGIN", "").strip().lower() in ("1", "true", "yes", "on")


@router.get("/setup", response_class=HTMLResponse)
async def setup_page(request: Request):
    garmin_cooldown = 0
    garmin_cooldown_str = ""
    try:
        garmin_cooldown = cooldown_remaining(db.get_db())
        if garmin_cooldown > 0:
            garmin_cooldown_str = format_cooldown(garmin_cooldown)
    except Exception:
        pass
    return _render("setup.html", config=load_config(), is_cloud=bool(db.get_database_url()),
                   garmin_cooldown=garmin_cooldown, garmin_cooldown_str=garmin_cooldown_str,
                   direct_garmin_login=_direct_garmin_login())


@router.post("/setup")
async def setup_save(
    request: Request,
    hevy_api_key: str = Form(""),
    garmin_email: str = Form(""),
    garmin_password: str = Form(""),
    weight_kg: float = Form(80.0),
    birth_year: int = Form(1990),
    sex: str = Form("male"),
):
    if is_demo_mode():
        return RedirectResponse("/", status_code=303)

    config = load_config()
    if hevy_api_key:
        config["hevy_api_key"] = hevy_api_key
    if garmin_email:
        config["garmin_email"] = garmin_email
    config["user_profile"]["weight_kg"] = weight_kg
    config["user_profile"]["birth_year"] = birth_year
    config["user_profile"]["sex"] = sex
    save_config(config)

    # On cloud deployments, persist credentials to DB so GitHub Actions can read them
    if db.get_database_url():
        try:
            _db = db.get_db()
            if hasattr(_db, '_get_conn'):
                hevy_key = hevy_api_key or os.environ.get("HEVY_API_KEY", "")
                g_email = garmin_email or os.environ.get("GARMIN_EMAIL", "")
                g_password = garmin_password or os.environ.get("GARMIN_PASSWORD", "")
                import json as _json
                with _db._get_conn() as conn:
                    with conn.cursor() as cur:
                        if hevy_key:
                            cur.execute("""
                                INSERT INTO platform_credentials (platform, auth_type, credentials, status)
                                VALUES ('hevy', 'api_key', %s, 'active')
                                ON CONFLICT (platform) DO UPDATE SET credentials = EXCLUDED.credentials, status = 'active'
                            """, (_json.dumps({"api_key": hevy_key}),))
                        if g_email:
                            cur.execute("""
                                INSERT INTO platform_credentials (platform, auth_type, credentials, status)
                                VALUES ('garmin', 'password', %s, 'active')
                                ON CONFLICT (platform) DO UPDATE SET credentials = EXCLUDED.credentials, status = 'active'
                            """, (_json.dumps({"email": g_email, "password": g_password}),))
                    conn.commit()
        except Exception as e:
            logger.warning("Failed to persist credentials to DB: %s", e)

    # Try server-side Garmin auth — LOCAL/self-host only.
    #
    # On cloud (serverless) deployments we deliberately skip this test login:
    # the datacenter IP is blocked by Garmin, and real auth happens through the
    # browser-based worker flow. A server-side login here would either fail or
    # add to Garmin's per-account login rate limit, surfacing a scary error that
    # reads like setup failed (#148). Credentials are already persisted to the DB
    # above, so the scheduled sync can authenticate via the worker.
    garmin_pw = garmin_password or os.environ.get("GARMIN_PASSWORD", "")
    garmin_em = garmin_email or config.get("garmin_email", "")

    garmin_error = None
    if garmin_pw and garmin_em and not db.get_database_url():
        # Gate: enforce local cooldown before attempting any Garmin login.
        # Retrying resets Garmin's own rate-limit timer, so we must skip the
        # attempt entirely when cooling down — not just warn about it.
        _cooldown = 0
        try:
            _cooldown = cooldown_remaining(db.get_db())
        except Exception:
            pass
        if _cooldown > 0:
            garmin_error = (
                "Garmin is still cooling down, "
                + format_cooldown(_cooldown)
                + " left. Leave it be. Retrying resets the timer. "
                "Click 'Skip for now'; your credentials are saved and "
                "sync will resume automatically once it clears."
            )
        else:
            try:
                from hevy2garmin.garmin import get_client
                get_client(garmin_em, garmin_pw)
                # Login succeeded — reset the backoff counter.
                try:
                    clear_rate_limit(db.get_db())
                except Exception:
                    pass
            except Exception as e:
                logger.warning("Garmin login test failed: %s", e)
                err = str(e)
                if "MFA" in err.upper():
                    garmin_error = (
                        "Garmin MFA (two-factor authentication) is enabled. "
                        "Temporarily disable MFA in your Garmin account settings, "
                        "connect here, then re-enable it."
                    )
                elif "429" in err or "rate limit" in err.lower():
                    _cd_secs = 2 * 3600
                    try:
                        _cd_secs = record_rate_limit(db.get_db())
                    except Exception:
                        pass
                    garmin_error = (
                        "Garmin has rate-limited login attempts for your account "
                        "(enforcing a " + format_cooldown(_cd_secs) + " cooldown locally "
                        "to protect your account). It clears on its own. Retrying "
                        "resets the timer. Click 'Skip for now'; your credentials are "
                        "saved and sync will resume automatically."
                    )
                elif "SSO login failed" in err:
                    garmin_error = (
                        "Garmin login failed. Double-check your email and password. "
                        "If they're correct, Garmin may be temporarily blocking logins "
                        "from this server. Try again in an hour."
                    )
                else:
                    # Strip any HTML tags from Garmin error responses
                    cleaned = re.sub(r"<[^>]+>", " ", err)
                    cleaned = re.sub(r"\s{2,}", " ", cleaned).strip()[:200]
                    garmin_error = cleaned or "Unknown error. Check your email and password."
    if garmin_error:
        _cd2 = 0
        _cd2_str = ""
        try:
            _cd2 = cooldown_remaining(db.get_db())
            if _cd2 > 0:
                _cd2_str = format_cooldown(_cd2)
        except Exception:
            pass
        return _render("setup.html", config=load_config(), garmin_error=garmin_error,
                        allow_skip=True, is_cloud=bool(db.get_database_url()),
                        garmin_cooldown=_cd2, garmin_cooldown_str=_cd2_str)

    response = RedirectResponse("/", status_code=303)
    # Set auth cookie if HEVY2GARMIN_SECRET is configured (cloud deployments)
    secret = os.environ.get("HEVY2GARMIN_SECRET")
    if secret:
        response.set_cookie("h2g_auth", secret, httponly=True, samesite="strict",
                            secure=is_https(request), max_age=365 * 86400)
    return response


@router.get("/workouts", response_class=HTMLResponse)
async def workouts_page(request: Request):
    config = load_config()
    workouts = []
    page = int(request.query_params.get("page", 1))
    page_count = 1
    fetch_error = None
    try:
        from hevy2garmin.hevy import HevyClient

        _db = db.get_db()
        cache_key = f"hevy_workouts_page_{page}"

        # Try DB cache first (populated during sync). Fall back to Hevy API on miss.
        cached = _db.get_app_config(cache_key)
        if cached:
            workouts_raw = cached.get("workouts", [])
            page_count = cached.get("page_count", 1)
        else:
            data = HevyClient(api_key=config.get("hevy_api_key")).get_workouts(page=page, page_size=10)
            workouts_raw = data.get("workouts", [])
            page_count = data.get("page_count", 1)
            _db.set_app_config(cache_key, {"workouts": workouts_raw, "page_count": page_count})

        # Batch check sync status (1 query instead of N)
        hevy_ids = [w.get("id", "") for w in workouts_raw]
        states = _db.get_workout_states(hevy_ids)
        # Check for workouts edited on Hevy since last sync
        stale_ids = set(_db.get_stale_synced(workouts_raw))

        # Get profile for calorie calculation
        profile = config.get("user_profile", {})
        weight_kg = profile.get("weight_kg", 80.0)
        birth_year = profile.get("birth_year", 1990)
        vo2max = profile.get("vo2max", 45.0)

        for w in workouts_raw:
            w["start_time"] = w.get("start_time") or w.get("startTime", "")
            w["end_time"] = w.get("end_time") or w.get("endTime", "")
            state = states.get(w["id"])
            if state and state["kind"] == "terminal":
                terminal_status = state.get("status") or "success"
                w["status"] = {"success": "uploaded", "manual": "manual", "skipped": "skipped"}.get(terminal_status, "uploaded")
                w["state_detail"] = state
                gid = state.get("garmin_activity_id")
                if gid:
                    w["garmin_match"] = {"garmin_id": gid, "garmin_name": w.get("title", "")}
                if w["id"] in stale_ids:
                    w["edited_since_sync"] = True
            elif state and state["kind"] == "pending":
                phase = state.get("status")
                w["status"] = "processing" if phase in {"preparing", "processing", "finalizing"} else phase
                w["state_detail"] = state
                if state.get("garmin_activity_id"):
                    w["garmin_match"] = {"garmin_id": state["garmin_activity_id"], "garmin_name": w.get("title", "")}
            else:
                w["status"] = "pending"

            # Calculate calorie breakdown for display
            try:
                start = w["start_time"]
                end = w["end_time"]
                if start and end:
                    from hevy2garmin.fit import _parse_timestamp, _DEFAULT_HR_BPM
                    start_dt = _parse_timestamp(start)
                    end_dt = _parse_timestamp(end)
                    if not start_dt or not end_dt:
                        raise ValueError("bad timestamp")
                    duration_s = (end_dt - start_dt).total_seconds()
                    workout_year = start_dt.year
                    age = workout_year - birth_year
                    # Default HR (no samples available in listing)
                    hr = _DEFAULT_HR_BPM
                    kcal_per_min = (
                        -95.7735 + 0.634 * hr + 0.404 * vo2max
                        + 0.394 * weight_kg + 0.271 * age
                    ) / 4.184
                    total_kcal = max(0, round(max(0.0, kcal_per_min) * (duration_s / 60.0)))
                    duration_min = int(duration_s // 60)
                    w["cal_info"] = {
                        "duration_min": duration_min,
                        "avg_hr": hr,
                        "hr_source": "default 90 bpm",
                        "weight_kg": weight_kg,
                        "age": age,
                        "vo2max": vo2max,
                        "kcal_per_min": round(kcal_per_min, 2),
                        "total_kcal": total_kcal,
                    }
            except Exception:
                pass

        workouts = workouts_raw
    except Exception as e:
        logger.error("Failed to fetch workouts: %s", e)
        fetch_error = str(e)
    hr_fusion = config.get("hr_fusion", {}).get("enabled", True)
    return _render("workouts.html", workouts=workouts, hr_fusion_enabled=hr_fusion, page=page, page_count=page_count, fetch_error=fetch_error)


def _daily_hr_to_samples(daily_hr: object, start_ms: int, end_ms: int) -> list[dict]:
    """Slice Garmin daily HR (``heartRateValues``) to a workout window.

    Garmin returns ``{"heartRateValues": null}`` for a day with no wellness HR yet
    (common for the current day, before all-day HR is populated), so the key is
    present with value ``None`` and ``.get(..., [])`` does NOT fall back. Guard the
    ``None`` before iterating so the endpoint returns an empty series instead of
    crashing with "'NoneType' object is not iterable" (#326).
    """
    hr_values = daily_hr.get("heartRateValues") if isinstance(daily_hr, dict) else None
    samples: list[dict] = []
    for entry in hr_values or []:
        if isinstance(entry, list) and len(entry) >= 2 and entry[1] is not None:
            ts, bpm = entry[0], entry[1]
            if start_ms - 60000 <= ts <= end_ms + 60000:  # ±1 min buffer
                secs_from_start = (ts - start_ms) / 1000
                samples.append({"time": max(0, secs_from_start), "hr": bpm})
    samples.sort(key=lambda x: x["time"])
    return samples


@router.get("/api/workout/{hevy_id}/hr", response_class=HTMLResponse)
async def api_workout_hr(request: Request, hevy_id: str):
    """Fetch HR data for a workout's matched Garmin activity. Returns JSON for Chart.js.

    Results are cached in SQLite — first load hits Garmin API, subsequent loads are instant.
    """
    from fastapi.responses import JSONResponse

    config = load_config()

    # Check if HR fusion is enabled
    if not config.get("hr_fusion", {}).get("enabled", True):
        return JSONResponse({"error": "HR fusion disabled in settings"}, status_code=404)

    # Check cache first
    cached = db.get_cached_hr(hevy_id)
    if cached:
        return JSONResponse(cached)

    try:
        from hevy2garmin.hevy import HevyClient
        from hevy2garmin.garmin import get_client
        from hevy2garmin.matcher import fetch_garmin_activities, match_workouts_to_garmin
        from garmin_auth import RateLimiter

        hevy = HevyClient(api_key=config.get("hevy_api_key"))
        # Fetch by ID so HR works for older workouts too, not just the first page (#165).
        workout = hevy.get_workout(hevy_id)
        if not workout:
            return JSONResponse({"error": "Workout not found"}, status_code=404)

        garmin_client = get_client(config.get("garmin_email"))
        garmin_acts = fetch_garmin_activities(garmin_client, count=1000)
        matches = match_workouts_to_garmin([workout], garmin_acts)

        if hevy_id not in matches:
            return JSONResponse({"error": "No matching Garmin activity"}, status_code=404)

        garmin_id = matches[hevy_id]["garmin_id"]
        limiter = RateLimiter(delay=1.0)

        # Fetch activity summary for avg/max HR
        details = limiter.call(garmin_client.get_activity, garmin_id)

        # Get workout start/end timestamps to slice daily HR
        from hevy2garmin.fit import _parse_timestamp
        w_start = workout.get("start_time") or workout.get("startTime", "")
        w_end = workout.get("end_time") or workout.get("endTime", "")
        start_dt = _parse_timestamp(w_start)
        end_dt = _parse_timestamp(w_end)
        if not start_dt or not end_dt:
            return HTMLResponse('<div style="padding:20px;color:var(--text-muted);">Workout timestamps missing</div>')
        start_ms = int(start_dt.timestamp() * 1000)
        end_ms = int(end_dt.timestamp() * 1000)
        total_duration_s = max(1, (end_ms - start_ms) / 1000)

        # Fetch daily HR data and slice to workout window
        date_str = w_start[:10]
        daily_hr = limiter.call(garmin_client.get_heart_rates, date_str)
        hr_samples = _daily_hr_to_samples(daily_hr, start_ms, end_ms)

        # Build exercise segments — proportional to actual workout duration
        exercises = workout.get("exercises", [])
        seg_colors = ["#3b82f6", "#22c55e", "#f97316", "#a855f7", "#ef4444", "#06b6d4", "#eab308", "#ec4899"]
        total_sets = sum(len(ex.get("sets", [])) for ex in exercises)
        segments = []
        cursor = 0.0
        for i, ex in enumerate(exercises):
            n_sets = len(ex.get("sets", []))
            if total_sets > 0:
                ex_duration = total_duration_s * (n_sets / total_sets)
            else:
                ex_duration = total_duration_s / max(1, len(exercises))
            segments.append({
                "name": ex.get("title") or ex.get("name", f"Exercise {i+1}"),
                "start": round(cursor),
                "end": round(cursor + ex_duration),
                "color": seg_colors[i % len(seg_colors)],
            })
            cursor += ex_duration

        result = {
            "hr_samples": hr_samples,
            "segments": segments,
            "garmin_id": garmin_id,
            "garmin_name": matches[hevy_id].get("garmin_name", ""),
            "avg_hr": details.get("averageHR") or details.get("summaryDTO", {}).get("averageHR"),
            "max_hr": details.get("maxHR") or details.get("summaryDTO", {}).get("maxHR"),
            "calories": details.get("calories") or details.get("summaryDTO", {}).get("calories"),
        }

        # Cache for instant subsequent loads
        db.cache_hr(hevy_id, result)

        return JSONResponse(result)

    except Exception as e:
        logger.error("HR data fetch failed: %s", e)
        return JSONResponse({"error": str(e)}, status_code=500)


@router.get("/sync")
async def sync_page(request: Request):
    return RedirectResponse("/")


@router.get("/mappings", response_class=HTMLResponse)
async def mappings_page(request: Request):
    from hevy2garmin.mapper import HEVY_TO_GARMIN, _custom_mappings, _ensure_custom_loaded

    _ensure_custom_loaded()

    CAT_NAMES = mapper._get_cat_names()

    mappings = []
    for name, (cat, subcat) in sorted(HEVY_TO_GARMIN.items()):
        cat_name = CAT_NAMES.get(cat, f"Category {cat}")
        mappings.append((name, cat, subcat, cat_name))
    for name, (cat, subcat) in sorted(_custom_mappings.items()):
        cat_name = CAT_NAMES.get(cat, f"Category {cat}")
        mappings.append((name, cat, subcat, f"{cat_name} (custom)"))

    # Find unmapped exercises from recent workouts (cached)
    unmapped = _get_unmapped_exercises()

    custom_list = [(name, cat, subcat, CAT_NAMES.get(cat, f"Category {cat}"))
                   for name, (cat, subcat) in sorted(_custom_mappings.items())]

    return _render(
        "mappings.html",
        mappings=mappings,
        total=len(mappings),
        custom_count=len(_custom_mappings),
        custom_list=custom_list,
        unmapped=unmapped,
    )


@router.get("/history", response_class=HTMLResponse)
async def history_page(request: Request):
    return _render("history.html", total=db.get_synced_count(), history=db.get_recent_synced(50))


@router.get("/settings", response_class=HTMLResponse)
async def settings_page(request: Request):
    config = load_config()
    unmapped: dict[str, int] = {}
    try:
        # Use cached unmapped from DB (no Hevy API call)
        for name, count in _get_unmapped_exercises():
            unmapped[name] = count
    except Exception:
        pass
    merge_extra_types = ", ".join(
        t for t in config.get("merge_activity_types", ["strength_training"]) if t != "strength_training"
    )
    return _render("settings.html", config=config, unmapped=sorted(unmapped.items(), key=lambda x: -x[1]), merge_extra_types=merge_extra_types, err=request.query_params.get("err"))


@router.post("/settings")
async def settings_save(
    hevy_api_key: str = Form(""), garmin_email: str = Form(""), garmin_password: str = Form(""),
    weight_kg: float = Form(80.0), birth_year: int = Form(1990), sex: str = Form("male"), vo2max: float = Form(45.0),
    timezone: str = Form(""),
    working_set_seconds: int = Form(40), warmup_set_seconds: int = Form(25),
    rest_between_sets_seconds: int = Form(75), rest_between_exercises_seconds: int = Form(120),
    hr_fusion_enabled: str = Form("off"),
    merge_mode: str = Form("off"),
    description_enabled: str = Form("off"),
    merge_overlap_pct: int = Form(70),
    merge_max_drift_min: int = Form(20),
    merge_extra_types: str = Form(""),
    merge_watch_strategy: str = Form("merge"),
):
    if is_demo_mode():
        return HTMLResponse('<div class="toast toast-error">Settings are read-only in demo mode</div>')

    config = load_config()
    if hevy_api_key:
        config["hevy_api_key"] = hevy_api_key
    if garmin_email:
        config["garmin_email"] = garmin_email
    if garmin_password:
        config["garmin_password"] = garmin_password
    config["user_profile"].update(
        weight_kg=weight_kg, birth_year=birth_year, sex=sex, vo2max=vo2max,
        timezone=timezone.strip(),
    )
    config["timing"].update(
        working_set_seconds=working_set_seconds, warmup_set_seconds=warmup_set_seconds,
        rest_between_sets_seconds=rest_between_sets_seconds,
        rest_between_exercises_seconds=rest_between_exercises_seconds,
    )
    config.setdefault("hr_fusion", {})["enabled"] = hr_fusion_enabled == "on"
    config["merge_mode"] = merge_mode == "on"
    config["description_enabled"] = description_enabled == "on"
    config["merge_overlap_pct"] = max(50, min(95, merge_overlap_pct))
    config["merge_max_drift_min"] = max(5, min(60, merge_max_drift_min))
    extra_types = [
        t.strip().lower().replace(" ", "_")
        for t in merge_extra_types.split(",")
        if t.strip()
    ]
    config["merge_activity_types"] = ["strength_training"] + [
        t for t in dict.fromkeys(extra_types) if t != "strength_training"
    ]
    config["merge_watch_strategy"] = merge_watch_strategy if merge_watch_strategy in ("replace", "merge", "describe") else "merge"
    save_config(config)

    # Persist settings to DB on cloud (filesystem is read-only on Vercel)
    if db.get_database_url():
        try:
            _db = db.get_db()
            _db.set_app_config("user_profile", config["user_profile"])
            _db.set_app_config("timing", config["timing"])
            _db.set_app_config("hr_fusion", config.get("hr_fusion", {}))
            _db.set_app_config("merge_settings", {
                "merge_mode": config["merge_mode"],
                "description_enabled": config["description_enabled"],
                "merge_overlap_pct": config["merge_overlap_pct"],
                "merge_max_drift_min": config["merge_max_drift_min"],
                "merge_activity_types": config["merge_activity_types"],
                "merge_watch_strategy": config["merge_watch_strategy"],
            })
        except Exception as e:
            logger.warning("Failed to persist settings to DB: %s", e)

    return RedirectResponse("/settings", status_code=303)
