"""FastAPI web dashboard for hevy2garmin."""

from __future__ import annotations

import logging
import os
import re
import threading
import time
from datetime import date, datetime, timezone
from math import ceil
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from jinja2 import Environment, FileSystemLoader

from hevy2garmin import db, __version__
from hevy2garmin.db_interface import NoWritableDatabaseError
from hevy2garmin.auth import auth_enabled, verify_session, sign_session, check_password, SESSION_COOKIE
from hevy2garmin.config import is_configured, load_config, save_config
from hevy2garmin.demo import is_demo_mode
from hevy2garmin.ratelimit import record_rate_limit, cooldown_remaining, clear_rate_limit, format_cooldown
from hevy2garmin.sync import (
    sync,
    sync_routines,
    sync_routine,
    routine_schedule_dates,
    schedule_routine,
    unschedule_routine_entry,
)

logger = logging.getLogger("hevy2garmin")

TEMPLATES_DIR = Path(__file__).parent / "templates"
STATIC_DIR = Path(__file__).parent / "static"


def _get_cat_names() -> dict[int, str]:
    """Canonical Garmin FIT exercise category names."""
    return {
        0: "Bench Press", 1: "Calf Raise", 2: "Cardio", 3: "Carry", 4: "Chop",
        5: "Core", 6: "Crunch", 7: "Curl", 8: "Deadlift", 9: "Flye",
        10: "Hip Raise", 11: "Hip Stability", 12: "Hip Swing", 13: "Hyperextension",
        14: "Lateral Raise", 15: "Leg Curl", 16: "Leg Raise", 17: "Lunge",
        18: "Olympic Lift", 19: "Plank", 20: "Plyo", 21: "Pull Up", 22: "Push Up",
        23: "Row", 24: "Shoulder Press", 25: "Shoulder Stability", 26: "Shrug",
        27: "Sit Up", 28: "Squat", 29: "Total Body", 30: "Triceps Extension",
        31: "Warm Up", 32: "Run", 33: "Cycling", 36: "Yoga", 38: "Battle Ropes",
        39: "Elliptical", 41: "Indoor Bike", 42: "Indoor Row", 47: "Stair Machine",
        52: "Treadmill", 65534: "Unknown",
    }
_jinja_env = Environment(loader=FileSystemLoader(str(TEMPLATES_DIR)), autoescape=True)


def _render(template_name: str, **ctx) -> HTMLResponse:
    t = _jinja_env.get_template(template_name)
    ctx.setdefault("auth_enabled", auth_enabled())
    ctx.setdefault("demo_mode", is_demo_mode())
    ctx.setdefault("version", __version__)
    return HTMLResponse(t.render(**ctx))


app = FastAPI(title="hevy2garmin", docs_url=None, redoc_url=None)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


_NO_DB_PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>hevy2garmin — database needed</title>
<style>
 body{margin:0;background:#0f1115;color:#e6e6e6;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center}
 .card{max-width:560px;margin:24px;padding:32px;background:#171a21;border:1px solid #262b36;border-radius:14px}
 h1{margin:0 0 4px;font-size:20px}
 p{color:#aab2c0}
 ol{padding-left:20px} li{margin:8px 0}
 code{background:#0f1115;border:1px solid #262b36;border-radius:6px;padding:1px 6px;font-size:14px}
 a{color:#7aa2ff}
</style></head><body><div class="card">
 <h1>Almost there — hevy2garmin needs a database</h1>
 <p>This deployment has no database attached yet. Serverless hosts have a read-only
 filesystem, so the app can't fall back to a local file and needs Postgres.</p>
 <ol>
  <li>Open your project on <a href="https://vercel.com/dashboard" target="_blank" rel="noopener">Vercel</a>.</li>
  <li>Go to the <b>Storage</b> tab and add a <b>Neon Postgres</b> database (it's free). This sets <code>POSTGRES_URL</code> automatically.</li>
  <li>Go to <b>Deployments</b>, open the latest one, and click <b>Redeploy</b>.</li>
 </ol>
 <p>Once the database is connected and it redeploys, this page becomes your dashboard.</p>
</div></body></html>"""


@app.exception_handler(NoWritableDatabaseError)
async def _no_database_handler(request: Request, exc: NoWritableDatabaseError) -> HTMLResponse:
    """Render an actionable 'add a database' page instead of a raw 500 (#145, #142)."""
    logger.warning("No writable database on %s: %s", request.url.path, exc)
    return HTMLResponse(_NO_DB_PAGE, status_code=503)


# ── Auto-sync state ─────────────────────────────────────────────────────────

_autosync_timer: threading.Timer | None = None
_autosync_lock = threading.Lock()
_sync_executing = threading.Lock()  # Prevents concurrent sync execution
_sync_lock_acquired_at: float = 0  # time.time() when lock was acquired
_SYNC_LOCK_TIMEOUT = 300  # 5 minutes — force-release if exceeded
_last_sync_time: datetime | None = None
_unmapped_cache: list[tuple[str, int]] | None = None
_unmapped_cache_time: float = 0
_failed_ids: set[str] = set()  # Workouts that failed upload this session (retried next session)


def _acquire_sync_lock() -> bool:
    """Try to acquire the sync lock. Force-release if held too long (hung sync)."""
    global _sync_lock_acquired_at
    if _sync_executing.acquire(blocking=False):
        _sync_lock_acquired_at = time.time()
        return True
    # Check if the lock has been held too long (hung sync)
    if _sync_lock_acquired_at and (time.time() - _sync_lock_acquired_at) > _SYNC_LOCK_TIMEOUT:
        logger.warning("Sync lock held for >%ds — force-releasing (likely hung)", _SYNC_LOCK_TIMEOUT)
        try:
            _sync_executing.release()
        except RuntimeError:
            pass
        if _sync_executing.acquire(blocking=False):
            _sync_lock_acquired_at = time.time()
            return True
    return False


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


def _run_autosync() -> None:
    """Execute a sync and reschedule if still enabled."""
    global _last_sync_time
    config = load_config()
    auto_cfg = config.get("auto_sync", {})
    if not auto_cfg.get("enabled", False):
        return

    if not _acquire_sync_lock():
        logger.info("Auto-sync: skipped — another sync is running")
        _schedule_autosync(auto_cfg.get("interval_minutes", 30))
        return

    logger.info("Auto-sync: running scheduled sync")
    hevy_auth_failed = False
    try:
        result = sync(limit=10, dry_run=False, record_log=False, respect_grace=True)
    except Exception as e:
        from hevy2garmin.hevy import HevyAuthError
        if isinstance(e, HevyAuthError):
            logger.error("Auto-sync: Hevy API key invalid — disabling auto-sync. %s", e)
            config["auto_sync"]["enabled"] = False
            save_config(config)
            # Also persist to DB (Vercel filesystem is read-only)
            if db.get_database_url():
                try:
                    import json as _json
                    _db = db.get_db()
                    if hasattr(_db, '_get_conn'):
                        with _db._get_conn() as conn:
                            with conn.cursor() as cur:
                                cur.execute("""
                                    INSERT INTO platform_credentials (platform, auth_type, credentials, status)
                                    VALUES ('auto_sync', 'config', %s, 'active')
                                    ON CONFLICT (platform) DO UPDATE SET credentials = EXCLUDED.credentials
                                """, (_json.dumps({"enabled": False, "interval_minutes": config.get("auto_sync", {}).get("interval_minutes", 120)}),))
                            conn.commit()
                except Exception:
                    pass
            hevy_auth_failed = True
        result = {"synced": 0, "skipped": 0, "failed": 1, "error": str(e)}
    finally:
        _sync_executing.release()

    if hevy_auth_failed:
        return  # Don't reschedule

    _last_sync_time = datetime.now(timezone.utc)
    _record_sync_log(result, trigger="auto")

    # Reschedule
    _schedule_autosync(auto_cfg.get("interval_minutes", 30))


def _schedule_autosync(interval_minutes: int) -> None:
    """Schedule the next auto-sync run."""
    global _autosync_timer
    with _autosync_lock:
        if _autosync_timer is not None:
            _autosync_timer.cancel()
        _autosync_timer = threading.Timer(interval_minutes * 60, _run_autosync)
        _autosync_timer.daemon = True
        _autosync_timer.start()


def _stop_autosync() -> None:
    """Cancel any pending auto-sync timer."""
    global _autosync_timer
    with _autosync_lock:
        if _autosync_timer is not None:
            _autosync_timer.cancel()
            _autosync_timer = None


def _record_sync_log(result: dict, trigger: str = "manual") -> None:
    """Record a sync result to SQLite."""
    db.record_sync_log(
        synced=result.get("synced", 0),
        skipped=result.get("skipped", 0),
        failed=result.get("failed", 0),
        trigger=trigger,
    )


def _get_autosync_status() -> dict[str, Any]:
    """Build auto-sync status dict for templates."""
    config = load_config()
    auto_cfg = config.get("auto_sync", {})
    enabled = auto_cfg.get("enabled", False)
    interval = auto_cfg.get("interval_minutes", 30)

    # On cloud, read persisted state from DB (filesystem config doesn't persist)
    if db.get_database_url():
        try:
            import json as _json
            _db = db.get_db()
            if hasattr(_db, '_get_conn'):
                with _db._get_conn() as conn:
                    with conn.cursor() as cur:
                        cur.execute("SELECT credentials FROM platform_credentials WHERE platform = 'auto_sync' LIMIT 1")
                        row = cur.fetchone()
                        if row and row.get("credentials"):
                            creds = row["credentials"] if isinstance(row["credentials"], dict) else _json.loads(row["credentials"])
                            enabled = creds.get("enabled", False)
                            interval = creds.get("interval_minutes", 120)
        except Exception:
            pass

    status: dict[str, Any] = {
        "enabled": enabled,
        "interval_minutes": interval,
        "last_sync": None,
        "next_sync": None,
    }

    if _last_sync_time:
        elapsed = datetime.now(timezone.utc) - _last_sync_time
        minutes_ago = int(elapsed.total_seconds() / 60)
        if minutes_ago < 1:
            status["last_sync"] = "just now"
        elif minutes_ago < 60:
            status["last_sync"] = f"{minutes_ago} min ago"
        else:
            hours_ago = minutes_ago // 60
            status["last_sync"] = f"{hours_ago}h {minutes_ago % 60}m ago"

        if enabled:
            remaining = interval - minutes_ago
            if remaining <= 0:
                status["next_sync"] = "soon"
            elif remaining < 60:
                status["next_sync"] = f"in {remaining} min"
            else:
                status["next_sync"] = f"in {remaining // 60}h {remaining % 60}m"

    return status


@app.on_event("startup")
async def _startup_autosync() -> None:
    """Start auto-sync timer on server startup if enabled."""
    config = load_config()
    auto_cfg = config.get("auto_sync", {})
    if auto_cfg.get("enabled", False):
        interval = auto_cfg.get("interval_minutes", 30)
        logger.info("Auto-sync enabled on startup: every %d min", interval)
        _schedule_autosync(interval)


_is_configured_cache: bool | None = None

@app.middleware("http")
async def check_setup(request: Request, call_next):
    global _is_configured_cache
    path = request.url.path
    secret = os.environ.get("HEVY2GARMIN_SECRET")

    # Static resources: pass through, no auth, no cookie
    if path == "/favicon.ico" or path.startswith("/static"):
        return await call_next(request)

    # ── Dashboard auth gate ──────────────────────────────────────────────
    # When H2G_PASSWORD is set, all routes except /login and /api/cron/*
    # require a valid session cookie. Without it, redirect to /login.
    if auth_enabled() and path not in ("/login",) and not path.startswith("/api/cron/"):
        session_cookie = request.cookies.get(SESSION_COOKIE)
        if not verify_session(session_cookie):
            if path.startswith("/api/"):
                from starlette.responses import Response
                return Response("Unauthorized", status_code=401)
            return RedirectResponse(f"/login?next={path}")

    # Auth check for POST /api/* endpoints (CSRF protection).
    # Cron has its own Bearer token check. All others require the cookie or X-Api-Key.
    if secret and request.method == "POST" and path.startswith("/api/") and path != "/api/cron/sync":
        token = request.cookies.get("h2g_auth") or request.headers.get("x-api-key")
        if token != secret:
            from starlette.responses import Response
            return Response("Unauthorized", status_code=401)

    # Setup page and sync endpoints: skip the "is configured?" redirect
    if path in ("/login", "/setup", "/api/sync-one", "/api/cron/sync", "/api/setup-actions", "/api/garmin-ticket"):
        response = await call_next(request)
    else:
        # Redirect to setup if not configured
        if _is_configured_cache is None:
            _is_configured_cache = is_configured()
        if not _is_configured_cache:
            _is_configured_cache = is_configured()
            if not _is_configured_cache:
                return RedirectResponse("/setup")
        response = await call_next(request)

    # Auto-set auth cookie on every GET so it survives cookie clears and new devices.
    # SameSite=strict prevents cross-origin POSTs from using it (CSRF protection).
    if secret and request.method == "GET" and not request.cookies.get("h2g_auth"):
        response.set_cookie("h2g_auth", secret, httponly=True, samesite="strict", max_age=365 * 86400)

    return response


# ── Auth pages ───────────────────────────────────────────────────────────────

@app.get("/login", response_class=HTMLResponse)
async def login_page(request: Request):
    """Show login form. Redirects to dashboard if already authenticated or auth disabled."""
    if not auth_enabled() or verify_session(request.cookies.get(SESSION_COOKIE)):
        return RedirectResponse("/")
    error = request.query_params.get("error")
    return HTMLResponse(_jinja_env.get_template("login.html").render(error=error))


@app.post("/login")
async def login_submit(request: Request, password: str = Form(...)):
    """Verify password, set session cookie, redirect to dashboard."""
    next_url = request.query_params.get("next", "/")
    # Prevent open redirect: only allow relative paths
    if not next_url.startswith("/") or next_url.startswith("//"):
        next_url = "/"
    if not check_password(password):
        return HTMLResponse(
            _jinja_env.get_template("login.html").render(error="Wrong password."),
            status_code=401,
        )
    response = RedirectResponse(next_url, status_code=303)
    response.set_cookie(
        SESSION_COOKIE, sign_session(),
        httponly=True, samesite="strict", max_age=30 * 24 * 3600,
    )
    return response


@app.post("/logout")
async def logout():
    """Clear session cookie and redirect to login."""
    response = RedirectResponse("/login", status_code=303)
    response.delete_cookie(SESSION_COOKIE)
    return response


# ── Pages ────────────────────────────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
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
        auto_sync=_get_autosync_status(),
        sync_log=db.get_sync_log(10),
        mapping_count=mapping_count,
        garmin_connected=garmin_connected,
        needs_actions_setup=False,
        garmin_cooldown=garmin_cooldown,
        garmin_cooldown_str=garmin_cooldown_str,
    )



@app.get("/setup", response_class=HTMLResponse)
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
                   garmin_cooldown=garmin_cooldown, garmin_cooldown_str=garmin_cooldown_str)


@app.post("/setup")
async def setup_save(
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
        response.set_cookie("h2g_auth", secret, httponly=True, samesite="strict", max_age=365 * 86400)
    return response


# ── Browser-based Garmin auth (ticket exchange) ───────────────────────────

@app.post("/api/garmin-ticket")
async def garmin_ticket_store(request: Request):
    """Store pre-exchanged Garmin DI OAuth tokens.

    The token exchange happens via Cloudflare Worker (bypasses cloud IP blocks).
    The Worker POSTs the ``ST-...`` ticket to Garmin's DI OAuth endpoint and
    returns ``{di_token, di_refresh_token, di_client_id, ...}``. This endpoint
    just persists that payload to whichever token store is configured so
    ``garmin-auth >= 0.3.0`` can pick it up on the next sync.
    """
    import json as _json
    body = await request.json()
    tokens_data = body.get("tokens")
    if not isinstance(tokens_data, dict) or not all(
        k in tokens_data for k in ("di_token", "di_refresh_token", "di_client_id")
    ):
        return HTMLResponse(
            _json.dumps({"error": "Invalid tokens: expected di_token/di_refresh_token/di_client_id"}),
            status_code=400,
        )

    # Only keep the fields the new token store cares about; the Worker also
    # returns metadata like expires_in that garminconnect recomputes itself.
    payload = {
        "di_token": tokens_data["di_token"],
        "di_refresh_token": tokens_data["di_refresh_token"],
        "di_client_id": tokens_data["di_client_id"],
    }

    try:
        database_url = db.get_database_url()
        if database_url:
            from garmin_auth.storage import DBTokenStore
            store = DBTokenStore(database_url)
            store.save(payload)
        else:
            from garmin_auth.storage import FileTokenStore
            store = FileTokenStore()
            store.save(payload)

        logger.info("Garmin DI tokens stored successfully")
        return HTMLResponse(_json.dumps({"ok": True}))
    except Exception as e:
        logger.warning("Garmin ticket exchange store failed: %s", e)
        return HTMLResponse(
            _json.dumps({"error": str(e)[:200]}),
            status_code=500,
        )


@app.post("/api/garmin-rate-limited")
async def api_garmin_rate_limited(request: Request):
    """Browser reports a Garmin rate_limited response from the worker so we can
    record the cooldown for display. Returns the cooldown length in seconds."""
    import json as _json
    try:
        seconds = record_rate_limit(db.get_db())
        return HTMLResponse(_json.dumps({"cooldown_seconds": seconds}))
    except Exception as e:
        logger.warning("Could not record rate-limit: %s", e)
        return HTMLResponse(_json.dumps({"cooldown_seconds": 0}))


@app.get("/workouts", response_class=HTMLResponse)
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


@app.get("/api/workout/{hevy_id}/hr", response_class=HTMLResponse)
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
        hr_values = daily_hr.get("heartRateValues", []) if isinstance(daily_hr, dict) else []

        hr_samples = []
        for entry in hr_values:
            if isinstance(entry, list) and len(entry) >= 2 and entry[1] is not None:
                ts, bpm = entry[0], entry[1]
                if start_ms - 60000 <= ts <= end_ms + 60000:  # ±1 min buffer
                    secs_from_start = (ts - start_ms) / 1000
                    hr_samples.append({"time": max(0, secs_from_start), "hr": bpm})

        hr_samples.sort(key=lambda x: x["time"])

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


@app.get("/sync")
async def sync_page(request: Request):
    return RedirectResponse("/")


@app.get("/mappings", response_class=HTMLResponse)
async def mappings_page(request: Request):
    from hevy2garmin.mapper import HEVY_TO_GARMIN, _custom_mappings, _ensure_custom_loaded

    _ensure_custom_loaded()

    CAT_NAMES = _get_cat_names()

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


@app.get("/history", response_class=HTMLResponse)
async def history_page(request: Request):
    return _render("history.html", total=db.get_synced_count(), history=db.get_recent_synced(50))


@app.get("/settings", response_class=HTMLResponse)
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
    return _render("settings.html", config=config, unmapped=sorted(unmapped.items(), key=lambda x: -x[1]), merge_extra_types=merge_extra_types)


@app.post("/settings")
async def settings_save(
    hevy_api_key: str = Form(""), garmin_email: str = Form(""), garmin_password: str = Form(""),
    weight_kg: float = Form(80.0), birth_year: int = Form(1990), sex: str = Form("male"), vo2max: float = Form(45.0),
    working_set_seconds: int = Form(40), warmup_set_seconds: int = Form(25),
    rest_between_sets_seconds: int = Form(75), rest_between_exercises_seconds: int = Form(120),
    hr_fusion_enabled: str = Form("off"),
    merge_mode: str = Form("off"),
    description_enabled: str = Form("off"),
    merge_overlap_pct: int = Form(70),
    merge_max_drift_min: int = Form(20),
    merge_extra_types: str = Form(""),
    merge_watch_strategy: str = Form("replace"),
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
    config["user_profile"].update(weight_kg=weight_kg, birth_year=birth_year, sex=sex, vo2max=vo2max)
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
    config["merge_watch_strategy"] = merge_watch_strategy if merge_watch_strategy in ("replace", "merge", "describe") else "replace"
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


# ── API (HTMX) ──────────────────────────────────────────────────────────────


@app.post("/api/mapping", response_class=HTMLResponse)
async def api_save_mapping(request: Request):
    """Save a custom exercise mapping."""
    form = await request.form()
    hevy_name = form.get("hevy_name", "").strip()
    category = int(form.get("category", 65534))
    subcategory = int(form.get("subcategory", 0))

    if not hevy_name:
        return HTMLResponse('<div class="toast toast-error">Exercise name required</div>')

    # Validate category ID exists
    valid_cats = set(_get_cat_names().keys())
    if category not in valid_cats:
        return HTMLResponse(f'<div class="toast toast-error">Invalid category ID {category}</div>')

    # Save to DB on cloud, filesystem locally
    if db.get_database_url():
        _db = db.get_db()
        if hasattr(_db, 'save_custom_mapping'):
            _db.save_custom_mapping(hevy_name, category, subcategory)
    # Always update in-memory cache (+ filesystem fallback).
    # Without this, _custom_mappings stays stale until process restart.
    from hevy2garmin.mapper import save_custom_mapping
    save_custom_mapping(hevy_name, category, subcategory)

    global _unmapped_cache
    _unmapped_cache = None

    # Drop the just-mapped exercise from the cached unmapped list (DB + memory).
    # The cache is only rebuilt during a sync, so without this the exercise kept
    # showing as "Unknown" on the Mappings page even after a reload (#172).
    try:
        _db2 = db.get_db()
        cached = _db2.get_app_config("unmapped_exercises")
        if isinstance(cached, dict) and hevy_name in cached:
            del cached[hevy_name]
            _db2.set_app_config("unmapped_exercises", cached)
    except Exception as e:
        logger.debug("Could not update unmapped cache after mapping: %s", e)

    cat_label = _get_cat_names().get(category, f"Category {category}")
    return HTMLResponse(f'<div class="toast toast-success">Mapped "{hevy_name}" → {cat_label} ({category}:{subcategory}). <a href="/mappings">Reload</a></div>')


@app.post("/api/reload-data", response_class=HTMLResponse)
async def api_reload_data(request: Request):
    """Clear the cached Hevy workout data so the dashboard refetches from Hevy.

    The workouts page serves cached pages (populated during sync), so editing a
    workout in Hevy was not reflected until the next sync. This button drops the
    cached pages and reloads with fresh data (#174).
    """
    if is_demo_mode():
        return HTMLResponse('<div class="toast toast-error">Read-only in demo mode</div>')
    config = load_config()
    try:
        from hevy2garmin.hevy import HevyClient
        _db = db.get_db()
        total = HevyClient(api_key=config.get("hevy_api_key")).get_workout_count()
        _db.set_app_config("hevy_total", {"count": total})
        for pg in range(1, (total // 10) + 2):
            _db.set_app_config(f"hevy_workouts_page_{pg}", {})
        global _unmapped_cache
        _unmapped_cache = None
        # HX-Refresh tells htmx to reload the page, which refetches fresh data.
        return HTMLResponse("", headers={"HX-Refresh": "true"})
    except Exception as e:
        logger.warning("Reload data failed: %s", e)
        return HTMLResponse(f'<div class="toast toast-error">Reload failed: {str(e)[:120]}</div>')


@app.post("/api/mapping/delete", response_class=HTMLResponse)
async def api_delete_mapping(request: Request):
    """Delete a custom exercise mapping."""
    form = await request.form()
    hevy_name = form.get("hevy_name", "").strip()
    if not hevy_name:
        return HTMLResponse('<div class="toast toast-error">Exercise name required</div>')

    from hevy2garmin.mapper import _custom_mappings
    if db.get_database_url():
        _db = db.get_db()
        if hasattr(_db, 'delete_custom_mapping'):
            _db.delete_custom_mapping(hevy_name)
    else:
        import json
        from pathlib import Path
        path = Path("~/.hevy2garmin/custom_mappings.json").expanduser()
        if path.exists():
            try:
                data = json.loads(path.read_text())
                data.pop(hevy_name, None)
                path.write_text(json.dumps(data, indent=2))
            except Exception:
                pass
    _custom_mappings.pop(hevy_name, None)

    global _unmapped_cache
    _unmapped_cache = None

    return HTMLResponse(f'<div class="toast toast-success">Deleted mapping for "{hevy_name}". <a href="/mappings">Reload</a></div>')


@app.get("/api/validate-hevy")
async def api_validate_hevy(request: Request):
    """Test a Hevy API key. Used by setup page."""
    from fastapi.responses import JSONResponse
    key = request.query_params.get("key", "")
    if not key:
        return JSONResponse({"error": "No key provided"}, status_code=400)
    try:
        from hevy2garmin.hevy import HevyClient
        count = HevyClient(api_key=key).get_workout_count()
        return JSONResponse({"valid": True, "workout_count": count})
    except Exception as e:
        return JSONResponse({"valid": False, "error": str(e)}, status_code=400)


@app.get("/api/garmin-categories")
async def api_garmin_categories(request: Request):
    """Return Garmin FIT exercise categories for the mapping UI."""
    from fastapi.responses import JSONResponse
    return JSONResponse({str(k): v for k, v in _get_cat_names().items()})


@app.post("/api/pull-garmin-profile", response_class=HTMLResponse)
async def api_pull_garmin_profile(request: Request):
    """Pull weight, birth date, and gender from Garmin Connect."""
    config = load_config()
    try:
        from hevy2garmin.garmin import get_client
        from garmin_auth import RateLimiter

        garmin_client = get_client(config.get("garmin_email"))
        limiter = RateLimiter(delay=1.0)
        raw = limiter.call(garmin_client.get_user_profile)
        profile = raw.get("userData", {}) if isinstance(raw, dict) else {}

        weight = profile.get("weight")  # grams
        birth = profile.get("birthDate")  # "YYYY-MM-DD"
        gender = profile.get("gender")  # "MALE" / "FEMALE"
        vo2max = profile.get("vo2MaxRunning")

        updates = []
        if weight:
            weight_kg = round(weight / 1000, 1)
            config["user_profile"]["weight_kg"] = weight_kg
            updates.append(f"{weight_kg} kg")
        if birth:
            birth_year = int(birth[:4])
            config["user_profile"]["birth_year"] = birth_year
            updates.append(f"born {birth_year}")
        if gender:
            sex = gender.lower()
            config["user_profile"]["sex"] = sex
            updates.append(sex)
        if vo2max:
            config["user_profile"]["vo2max"] = float(vo2max)
            updates.append(f"VO2max {vo2max}")

        if updates:
            save_config(config)
            msg = "Pulled from Garmin: " + ", ".join(updates)
            return HTMLResponse(f'<div class="toast toast-success" style="margin-bottom: 12px;">{msg}</div><script>setTimeout(()=>location.reload(),1500)</script>')
        return HTMLResponse('<div class="toast toast-error" style="margin-bottom: 12px;">No profile data found on Garmin.</div>')
    except Exception as e:
        return HTMLResponse(f'<div class="toast toast-error" style="margin-bottom: 12px;">Failed: {e}</div>')


@app.post("/api/sync", response_class=HTMLResponse)
async def api_sync(request: Request):
    global _last_sync_time

    if is_demo_mode():
        from fastapi.responses import JSONResponse
        return JSONResponse({"status": "demo", "message": "Sync disabled in demo mode"})

    # If GitHub PAT + repo are set (Vercel deploy), trigger sync via GitHub Actions
    github_pat = os.environ.get("GITHUB_PAT")
    github_repo = os.environ.get("GITHUB_REPO")
    if github_pat and github_repo:
        import requests as req

        resp = req.post(
            f"https://api.github.com/repos/{github_repo}/dispatches",
            headers={
                "Authorization": f"Bearer {github_pat}",
                "Accept": "application/vnd.github+json",
            },
            json={"event_type": "sync-trigger"},
            timeout=10,
        )
        if resp.ok:
            return HTMLResponse(
                '<div class="toast toast-success">Sync triggered via GitHub Actions.'
                " Workouts will appear in a few minutes.</div>"
            )
        return HTMLResponse(
            f'<div class="toast toast-error">Failed to trigger sync: HTTP {resp.status_code}</div>'
        )

    form = await request.form()
    scope = form.get("scope", "recent")

    # Map scope to sync args
    sync_kwargs: dict = {"dry_run": False}
    if scope == "all":
        sync_kwargs["fetch_all"] = True
    elif scope.isdigit():
        sync_kwargs["limit"] = int(scope)
    else:
        # Time-based: compute "since" date
        from datetime import timedelta
        now = datetime.now(timezone.utc)
        deltas = {
            "24h": timedelta(hours=24),
            "7d": timedelta(days=7),
            "30d": timedelta(days=30),
            "6mo": timedelta(days=180),
            "1y": timedelta(days=365),
        }
        delta = deltas.get(scope, timedelta(hours=24))
        since_dt = now - delta
        sync_kwargs["since"] = since_dt.strftime("%Y-%m-%dT%H:%M:%S+00:00")
        sync_kwargs["fetch_all"] = True  # paginate until we hit the date

    if not _acquire_sync_lock():
        return HTMLResponse('<div class="toast toast-error">Another sync is already running. Please wait.</div>')

    try:
        result = sync(**sync_kwargs, record_log=False, respect_grace=False)
    except Exception as e:
        result = {"synced": 0, "skipped": 0, "failed": 1, "unmapped": [], "error": str(e)}
    finally:
        _sync_executing.release()
    _last_sync_time = datetime.now(timezone.utc)
    _record_sync_log(result, trigger=f"manual ({scope})")
    return _render("partials/sync_result.html", result=result)


_SCHEDULES_PAGE_SIZES = (10, 25, 100)
_SCHEDULES_PAGE_SIZE = _SCHEDULES_PAGE_SIZES[0]


def _schedules_context(
    page: int, start_date: str | None = None, title: str | None = None, page_size: int | None = None
) -> dict:
    """Build the paginated 'scheduled workouts' context (local DB only).

    ``start_date`` (default today) filters to entries on/after that date; ``title``
    filters by routine name (case-insensitive substring); ``page_size`` (one of
    ``_SCHEDULES_PAGE_SIZES``, default 10) sets rows per page. All are echoed back so
    the filter form, selector and the pagination/refresh URLs keep the current state.
    """
    _db = db.get_db()
    start = start_date or date.today().isoformat()
    try:
        date.fromisoformat(start)  # guard the query and the value echoed into the form
    except (ValueError, TypeError):
        start = date.today().isoformat()
    title = (title or "").strip()
    size = page_size if page_size in _SCHEDULES_PAGE_SIZES else _SCHEDULES_PAGE_SIZE
    total = _db.count_upcoming_routine_schedules(start, title or None)
    total_pages = max(1, ceil(total / size))
    page = max(1, min(page, total_pages))
    rows = _db.get_upcoming_routine_schedules(
        start, size, (page - 1) * size, title or None
    )
    return {
        "scheduled_workouts": rows,
        "page": page,
        "total_pages": total_pages,
        "sched_total": total,
        "start_date": start,
        "title_query": title,
        "page_size": size,
        "page_sizes": _SCHEDULES_PAGE_SIZES,
    }


@app.get("/routines", response_class=HTMLResponse)
async def routines_page(request: Request):
    """List Hevy routines and their sync status."""
    config = load_config()
    routines: list[dict] = []
    fetch_error = None
    # Local-DB data — load it outside the Hevy fetch so the schedules table still
    # renders even when Hevy is unreachable.
    try:
        schedules = _schedules_context(1)
    except Exception:
        logger.exception("Failed to load scheduled workouts")
        schedules = {"scheduled_workouts": [], "page": 1, "total_pages": 1, "sched_total": 0}
    try:
        from hevy2garmin.hevy import HevyClient
        from hevy2garmin.sync import fetch_all_routines, _cache_routines_total

        _db = db.get_db()
        hevy = HevyClient(api_key=config.get("hevy_api_key"))
        all_routines = fetch_all_routines(hevy)
        _cache_routines_total(_db, len(all_routines))
        for r in all_routines:
            record = _db.get_synced_routine(r.get("id", ""))
            routines.append({
                "id": r.get("id", ""),
                "title": r.get("title") or r.get("name") or "Routine",
                "exercise_count": len(r.get("exercises", [])),
                "synced": record is not None,
                "scheduled_date": (record or {}).get("scheduled_date"),
            })
    except Exception:
        logger.exception("Failed to load Hevy routines")
        fetch_error = "Could not load routines from Hevy. Check your API key and try again."
    return _render(
        "routines.html", request=request, routines=routines, fetch_error=fetch_error, **schedules
    )


@app.get("/api/routines/schedules", response_class=HTMLResponse)
async def api_routines_schedules(
    request: Request, page: int = 1, start: str | None = None, q: str | None = None,
    size: int = _SCHEDULES_PAGE_SIZE,
):
    """Return the paginated 'scheduled workouts' table fragment (HTMX navigation/filter)."""
    try:
        ctx = _schedules_context(page, start, q, size)
    except Exception:
        logger.exception("Failed to load scheduled workouts")
        return HTMLResponse('<div class="toast toast-error">Could not load scheduled workouts.</div>')
    return _render("routine_schedules.html", **ctx)


@app.post("/api/routines/sync", response_class=HTMLResponse)
async def api_routines_sync(request: Request):
    """Create Garmin planned workouts from all Hevy routines."""
    if is_demo_mode():
        return HTMLResponse('<div class="toast toast-success">Sync disabled in demo mode.</div>')

    form = await request.form()
    force = form.get("force") in ("1", "true", "on")

    if not _acquire_sync_lock():
        return HTMLResponse('<div class="toast toast-error">Another sync is already running. Please wait.</div>')

    try:
        result = sync_routines(dry_run=False, force=force)
    except Exception:
        logger.exception("Routine sync failed")
        return HTMLResponse('<div class="toast toast-error">Routine sync failed. Check the logs for details.</div>')
    finally:
        _sync_executing.release()

    msg = (
        f"{result['created']} created, {result['updated']} updated, "
        f"{result['skipped']} skipped, {result['failed']} failed"
        + (f", {result['scheduled']} scheduled" if result.get("scheduled") else "")
    )
    cls = "toast-error" if result["failed"] else "toast-success"
    # Sync's restore path can (re)schedule routines, so refresh the schedules table too.
    return HTMLResponse(
        f'<div class="toast {cls}">Routine sync complete: {msg}</div>',
        headers={"HX-Trigger": "refreshSchedules"},
    )


@app.post("/api/routines/{hevy_routine_id}/sync", response_class=HTMLResponse)
async def api_routine_sync_one(request: Request, hevy_routine_id: str):
    """Sync a single Hevy routine and swap its table row in place."""
    if is_demo_mode():
        return HTMLResponse('<div class="toast toast-success">Sync disabled in demo mode.</div>')

    form = await request.form()
    force = form.get("force") in ("1", "true", "on")

    if not _acquire_sync_lock():
        return HTMLResponse('<div class="toast toast-error">Another sync is already running. Please wait.</div>')

    try:
        result = sync_routine(hevy_routine_id, force=force)
    except Exception:
        logger.exception("Routine %s sync failed", hevy_routine_id)
        return HTMLResponse('<div class="toast toast-error">Routine sync failed. Check the logs for details.</div>')
    finally:
        _sync_executing.release()

    outcome = result["outcome"]
    if outcome == "failed":
        return HTMLResponse(f'<div class="toast toast-error">Could not sync "{result["row"]["title"]}". Check the logs.</div>')
    # Toast into #routines-result plus an out-of-band swap of the updated row, so it flips
    # to "synced" (and gains the Schedule form) without a full page reload. HX-Trigger
    # refreshes the schedules table since the restore path may have re-booked dates.
    row_html = _render("routine_row.html", r=result["row"], oob=True).body.decode()
    toast = f'<div class="toast toast-success">Synced "{result["row"]["title"]}" ({outcome}).</div>'
    return HTMLResponse(toast + row_html, headers={"HX-Trigger": "refreshSchedules"})


@app.post("/api/routines/{hevy_routine_id}/schedule", response_class=HTMLResponse)
async def api_routine_schedule(request: Request, hevy_routine_id: str):
    """Schedule one synced routine on the Garmin calendar (once or recurring weekly)."""
    if is_demo_mode():
        return HTMLResponse('<div class="toast toast-success">Scheduling disabled in demo mode.</div>')

    form = await request.form()
    mode = form.get("mode", "once")
    try:
        dates = routine_schedule_dates(
            mode,
            date=form.get("date"),
            weekday=form.get("weekday"),
            start_date=form.get("start_date"),
            weeks=form.get("weeks"),
        )
    except (ValueError, TypeError) as e:
        return HTMLResponse(f'<div class="toast toast-error">Invalid schedule: {e}</div>')

    if not _acquire_sync_lock():
        return HTMLResponse('<div class="toast toast-error">Another sync is already running. Please wait.</div>')

    try:
        result = schedule_routine(hevy_routine_id, dates)
    except ValueError as e:
        return HTMLResponse(f'<div class="toast toast-error">{e}</div>')
    except Exception:
        logger.exception("Scheduling routine %s failed", hevy_routine_id)
        return HTMLResponse('<div class="toast toast-error">Scheduling failed. Check the logs for details.</div>')
    finally:
        _sync_executing.release()

    n = result["scheduled"]
    span = f" ({result['dates'][0]} → {result['dates'][-1]})" if n > 1 else f" on {result['dates'][0]}"
    # HX-Trigger fires a client event so the "Scheduled workouts" table refreshes itself.
    return HTMLResponse(
        f'<div class="toast toast-success">Scheduled {n} session(s){span}.</div>',
        headers={"HX-Trigger": "refreshSchedules"},
    )


@app.post("/api/routines/{hevy_routine_id}/schedule/{schedule_id}/unschedule", response_class=HTMLResponse)
async def api_routine_unschedule(
    request: Request, hevy_routine_id: str, schedule_id: str,
    page: int = 1, start: str | None = None, q: str | None = None,
    size: int = _SCHEDULES_PAGE_SIZE,
):
    """Remove one scheduled calendar entry, then re-render the schedules table."""
    if is_demo_mode():
        return HTMLResponse('<div class="toast toast-success">Unscheduling disabled in demo mode.</div>')

    if not _acquire_sync_lock():
        return HTMLResponse('<div class="toast toast-error">Another sync is already running. Please wait.</div>')

    try:
        unschedule_routine_entry(hevy_routine_id, schedule_id)
    except Exception:
        logger.exception("Unscheduling routine %s entry %s failed", hevy_routine_id, schedule_id)
        return HTMLResponse('<div class="toast toast-error">Could not remove the scheduled workout. Check the logs.</div>')
    finally:
        _sync_executing.release()

    return _render("routine_schedules.html", **_schedules_context(page, start, q, size))


@app.post("/api/sync/{workout_id}", response_class=HTMLResponse)
async def api_sync_single(request: Request, workout_id: str):
    try:
        from hevy2garmin.hevy import HevyClient
        from hevy2garmin.garmin import get_client
        from hevy2garmin.merge import reset_circuit_breaker
        from hevy2garmin.sync import sync_one_workout

        force_upload = request.query_params.get("force") == "1"

        config = load_config()
        workout = HevyClient(api_key=config.get("hevy_api_key")).get_workout(workout_id)
        if not workout:
            return HTMLResponse('<td colspan="5">Workout not found</td>')

        if config.get("merge_mode", True):
            reset_circuit_breaker()

        garmin_client = get_client(config.get("garmin_email"))
        # Manual single-workout upload from the workouts page — bypass grace.
        sync_one_workout(
            workout,
            cfg=config,
            garmin_client=garmin_client,
            force_upload=force_upload,
            respect_grace=False,
            database=db.get_db(),
        )

        start = (workout.get("start_time") or "")[:16]
        return HTMLResponse(f'<tr><td><span class="badge badge-success">✓ Synced</span></td><td>{start}</td><td><strong>{workout["title"]}</strong></td><td>{len(workout.get("exercises", []))}</td><td></td></tr>')
    except Exception as e:
        return HTMLResponse(f'<td colspan="5" style="color: var(--pico-del-color);">Failed: {e}</td>')


@app.post("/api/unsync/{hevy_id}")
async def api_unsync(request: Request, hevy_id: str):
    """Remove a workout's sync record so it can be re-synced."""
    from fastapi.responses import JSONResponse

    garmin_id = db.get_garmin_id(hevy_id)
    deleted = db.unsync(hevy_id)
    if not deleted:
        return JSONResponse({"ok": False, "error": "Not found"}, status_code=404)

    # Optionally delete the Garmin activity too
    form = await request.form()
    delete_garmin = form.get("delete_garmin") in ("true", "1", True)
    garmin_deleted = False
    if delete_garmin and garmin_id:
        try:
            config = load_config()
            from hevy2garmin.garmin import get_client
            client = get_client(config.get("garmin_email"))
            client.delete_activity(int(garmin_id))
            garmin_deleted = True
            logger.info("Deleted Garmin activity %s for hevy workout %s", garmin_id, hevy_id)
        except Exception as e:
            logger.warning("Failed to delete Garmin activity %s: %s", garmin_id, e)

    # Clear cached workout pages so the workouts page reflects the change
    _db = db.get_db()
    for page in range(1, 11):
        _db.set_app_config(f"hevy_workouts_page_{page}", {})

    logger.info("Unsynced workout %s (garmin_id=%s, garmin_deleted=%s)", hevy_id, garmin_id, garmin_deleted)
    return JSONResponse({"ok": True, "garmin_deleted": garmin_deleted})


def _valid_hevy_id(hevy_id: str) -> bool:
    return bool(hevy_id and len(hevy_id) <= 200 and re.fullmatch(r"[A-Za-z0-9._:-]+", hevy_id))


def _clear_workout_cache(store) -> None:
    for page in range(1, 11):
        store.set_app_config(f"hevy_workouts_page_{page}", {})


@app.post("/api/pending/{hevy_id}/reconcile")
async def api_reconcile_pending(request: Request, hevy_id: str):
    from fastapi.responses import JSONResponse
    if not _valid_hevy_id(hevy_id):
        return JSONResponse({"ok": False, "error": "Invalid workout ID"}, status_code=400)
    store = db.get_db()
    if not store.get_pending(hevy_id):
        return JSONResponse({"ok": False, "error": "No pending operation"}, status_code=404)
    try:
        from hevy2garmin.garmin import get_client
        from hevy2garmin.sync import reconcile_pending
        config = load_config()
        result = reconcile_pending(store, get_client(config.get("garmin_email")), hevy_id)
        return JSONResponse({"ok": True, "status": result.status})
    except Exception as exc:
        return JSONResponse({"ok": False, "error": str(exc)[:1000]}, status_code=502)


@app.post("/api/pending/{hevy_id}/retry")
async def api_retry_pending(request: Request, hevy_id: str):
    from fastapi.responses import JSONResponse
    if not _valid_hevy_id(hevy_id):
        return JSONResponse({"ok": False, "error": "Invalid workout ID"}, status_code=400)
    form = await request.form()
    if form.get("confirm") != hevy_id:
        return JSONResponse({"ok": False, "error": "Explicit confirmation required"}, status_code=400)
    store = db.get_db()
    pending = store.get_pending(hevy_id)
    if not pending or pending.get("phase") != "failed":
        return JSONResponse({"ok": False, "error": "Only definitively rejected uploads can be retried"}, status_code=409)
    try:
        from hevy2garmin.garmin import get_client
        from hevy2garmin.sync import reconcile_pending, sync_one_workout
        config = load_config(); client = get_client(config.get("garmin_email"))
        reconcile_pending(store, client, hevy_id)
        pending = store.get_pending(hevy_id)
        if not pending or pending.get("phase") != "failed":
            return JSONResponse({"ok": False, "error": "Operation is no longer retryable"}, status_code=409)
        workout = (pending.get("payload") or {}).get("workout")
        if not workout:
            return JSONResponse({"ok": False, "error": "Stored workout payload is unavailable"}, status_code=409)
        store.delete_pending(hevy_id)
        result = sync_one_workout(workout, cfg=config, garmin_client=client, force_upload=True, respect_grace=False, database=store)
        return JSONResponse({"ok": True, "status": result.status})
    except Exception as exc:
        return JSONResponse({"ok": False, "error": str(exc)[:1000]}, status_code=502)


@app.post("/api/pending/{hevy_id}/abandon")
async def api_abandon_pending(request: Request, hevy_id: str):
    from fastapi.responses import JSONResponse
    if not _valid_hevy_id(hevy_id):
        return JSONResponse({"ok": False, "error": "Invalid workout ID"}, status_code=400)
    form = await request.form()
    if form.get("confirm") != hevy_id:
        return JSONResponse({"ok": False, "error": "Explicit confirmation required"}, status_code=400)
    if not db.delete_pending(hevy_id):
        return JSONResponse({"ok": False, "error": "No pending operation"}, status_code=404)
    logger.warning("ABANDONED pending Garmin upload for %s from web UI; an orphan may still appear", hevy_id)
    return JSONResponse({"ok": True})


async def _manual_terminal(request: Request, hevy_id: str, status: str):
    from fastapi.responses import JSONResponse
    if not _valid_hevy_id(hevy_id):
        return JSONResponse({"ok": False, "error": "Invalid workout ID"}, status_code=400)
    form = await request.form(); store = db.get_db()
    pending = store.get_pending(hevy_id)
    if pending and form.get("confirm") != hevy_id:
        return JSONResponse({"ok": False, "error": "Pending upload confirmation required"}, status_code=409)
    reason = str(form.get("reason") or "")[:1000]
    garmin_id = None
    if status == "manual" and form.get("garmin_id"):
        raw_id = str(form.get("garmin_id"))
        if not raw_id.isdigit() or int(raw_id) <= 0:
            return JSONResponse({"ok": False, "error": "Garmin ID must be a positive integer"}, status_code=400)
        garmin_id = raw_id
    store.resolve_terminal(hevy_id, status=status, garmin_activity_id=garmin_id, reason=reason, source="web")
    _clear_workout_cache(store)
    return JSONResponse({"ok": True, "status": status})


@app.post("/api/workout/{hevy_id}/mark-synced")
async def api_mark_synced(request: Request, hevy_id: str):
    return await _manual_terminal(request, hevy_id, "manual")


@app.post("/api/workout/{hevy_id}/skip")
async def api_skip_workout(request: Request, hevy_id: str):
    return await _manual_terminal(request, hevy_id, "skipped")


@app.post("/api/unsync-all")
async def api_unsync_all(request: Request):
    """Remove ALL sync records. Does not delete from Garmin."""
    from fastapi.responses import JSONResponse

    if is_demo_mode():
        return JSONResponse({"ok": False, "error": "Read-only in demo mode"}, status_code=403)

    form = await request.form()
    confirm = form.get("confirm", "")
    if confirm != "RESET":
        return JSONResponse({"ok": False, "error": "Send confirm=RESET to proceed"}, status_code=400)

    count = db.unsync_all()

    # Clear cached workout pages
    _db = db.get_db()
    for page in range(1, 11):
        _db.set_app_config(f"hevy_workouts_page_{page}", {})

    logger.info("Unsynced all %d workouts", count)
    return JSONResponse({"ok": True, "count": count})


@app.post("/api/scan-duplicates", response_class=HTMLResponse)
async def api_scan_duplicates(request: Request):
    """On-demand: scan recent workouts for duplicate tool+watch activity pairs
    and show the count. Log-only, no deletion."""
    from hevy2garmin.reconcile import detect_duplicates
    from hevy2garmin.sync import fetch_workouts, _hr_limiter
    from hevy2garmin.hevy import HevyClient
    from hevy2garmin.garmin import get_client
    try:
        cfg = load_config()
        hevy = HevyClient(api_key=cfg.get("hevy_api_key"))
        garmin_client = get_client(cfg.get("garmin_email"))
        workouts = fetch_workouts(hevy, limit=50)
        dups = detect_duplicates(garmin_client, workouts, _hr_limiter)
    except Exception as e:
        logger.warning("Duplicate scan failed: %s", e)
        return HTMLResponse(f'<div class="toast toast-error">Scan failed: {e}</div>')
    return HTMLResponse(f"<div>Found {len(dups)} possible duplicate(s). See server logs for details.</div>")


@app.post("/api/toggle-autosync", response_class=HTMLResponse)
async def api_toggle_autosync(request: Request):
    if is_demo_mode():
        from fastapi.responses import JSONResponse
        return JSONResponse({"status": "demo", "message": "Sync disabled in demo mode"})

    form = await request.form()
    enabled_raw = form.get("enabled", "false")
    enabled = enabled_raw in ("true", "True", "1", True)
    try:
        interval = int(form.get("interval", 120))
    except (ValueError, TypeError):
        interval = 120
    if interval not in (30, 60, 120, 240, 360, 720, 1440):
        interval = 120

    config = load_config()
    config.setdefault("auto_sync", {})
    config["auto_sync"]["enabled"] = enabled
    config["auto_sync"]["interval_minutes"] = interval
    save_config(config)

    # Persist auto-sync state to DB on cloud deployments (filesystem is read-only)
    if db.get_database_url():
        try:
            import json as _json
            _db = db.get_db()
            if hasattr(_db, '_get_conn'):
                with _db._get_conn() as conn:
                    with conn.cursor() as cur:
                        cur.execute("""
                            INSERT INTO platform_credentials (platform, auth_type, credentials, status)
                            VALUES ('auto_sync', 'config', %s, 'active')
                            ON CONFLICT (platform) DO UPDATE SET credentials = EXCLUDED.credentials
                        """, (_json.dumps({"enabled": enabled, "interval_minutes": interval}),))
                    conn.commit()
        except Exception as e:
            logger.warning("Failed to persist auto-sync state: %s", e)

    if enabled:
        if os.environ.get("VERCEL") and os.environ.get("GITHUB_PAT"):
            ok, msg = await _setup_github_actions(interval_minutes=interval)
            if ok:
                logger.info("GitHub Actions auto-sync configured (interval=%dmin)", interval)
            else:
                logger.warning("Failed to set up GitHub Actions: %s", msg)
        else:
            _schedule_autosync(interval)
        logger.info("Auto-sync enabled: every %d min", interval)
    else:
        _stop_autosync()
        # On Vercel: delete the sync workflow to stop the cron
        if os.environ.get("VERCEL") and os.environ.get("GITHUB_PAT"):
            try:
                import requests as req
                pat = os.environ.get("GITHUB_PAT")
                owner = os.environ.get("VERCEL_GIT_REPO_OWNER")
                repo_name = os.environ.get("VERCEL_GIT_REPO_SLUG")
                gh_headers = {"Authorization": f"Bearer {pat}", "Accept": "application/vnd.github+json"}
                wf = req.get(f"https://api.github.com/repos/{owner}/{repo_name}/contents/.github/workflows/sync.yml",
                             headers=gh_headers, timeout=10)
                if wf.status_code == 200:
                    req.delete(f"https://api.github.com/repos/{owner}/{repo_name}/contents/.github/workflows/sync.yml",
                               headers=gh_headers, json={"message": "disable auto-sync", "sha": wf.json()["sha"]}, timeout=10)
                    logger.info("Deleted sync workflow from %s/%s", owner, repo_name)
            except Exception as e:
                logger.warning("Failed to delete sync workflow: %s", e)
        logger.info("Auto-sync disabled")

    auto_sync = _get_autosync_status()
    return _render("partials/autosync_status.html", auto_sync=auto_sync)


# ── Vercel / Cloud endpoints ──────────────────────────────────────────────


def _minutes_to_cron(minutes: int) -> str:
    """Convert an interval in minutes to a GitHub Actions cron expression.

    Supports the discrete values exposed in the dashboard select:
    30, 60, 120, 240, 360, 720, 1440. Falls back to '0 */2 * * *' for
    anything unexpected.
    """
    if minutes == 30:
        return "*/30 * * * *"
    if minutes == 60:
        return "0 * * * *"
    if minutes == 1440:
        return "0 0 * * *"
    if minutes >= 60 and minutes % 60 == 0:
        hours = minutes // 60
        return f"0 */{hours} * * *"
    return "0 */2 * * *"


def _build_sync_workflow_yaml(interval_minutes: int) -> str:
    """Build the sync.yml workflow content with the given cron interval."""
    cron = _minutes_to_cron(interval_minutes)
    return (
        "name: Sync Workouts\n\n"
        "on:\n"
        "  schedule:\n"
        f"    - cron: '{cron}'\n"
        "  workflow_dispatch: {}\n"
        "  repository_dispatch:\n"
        "    types: [sync-trigger]\n\n"
        "concurrency:\n"
        "  group: sync\n"
        "  cancel-in-progress: false\n\n"
        "jobs:\n"
        "  sync:\n"
        "    runs-on: ubuntu-latest\n"
        "    timeout-minutes: 30\n"
        "    steps:\n"
        "      - uses: actions/checkout@v5\n"
        "      - uses: actions/setup-python@v6\n"
        "        with:\n"
        "          python-version: '3.12'\n"
        "      - name: Install\n"
        "        run: pip install \".[cloud]\"\n"
        "      - name: Sync\n"
        "        env:\n"
        "          DATABASE_URL: ${{ secrets.DATABASE_URL }}\n"
        "        run: hevy2garmin sync\n"
    )


def _format_interval_label(minutes: int) -> str:
    """Human-friendly label for interval (e.g., '30 minutes', '1 hour', '2 hours')."""
    if minutes < 60:
        return f"{minutes} minutes"
    if minutes == 60:
        return "1 hour"
    if minutes == 1440:
        return "24 hours"
    if minutes % 60 == 0:
        return f"{minutes // 60} hours"
    return f"{minutes} minutes"


async def _setup_github_actions(interval_minutes: int = 120) -> tuple[bool, str]:
    """Configure GitHub Actions on the user's fork.

    Parallelizes independent GitHub API calls (PATCH repo, PUT actions,
    GET public-key, GET workflow) to keep latency low. Returns (ok, message).
    """
    import asyncio
    from base64 import b64encode

    pat = os.environ.get("GITHUB_PAT")
    owner = os.environ.get("VERCEL_GIT_REPO_OWNER")
    repo = os.environ.get("VERCEL_GIT_REPO_SLUG")
    database_url = db.get_database_url()

    if not pat:
        return False, "GITHUB_PAT not set"
    if not owner or not repo:
        return False, "Not deployed via Vercel (missing repo info)"
    if not database_url:
        return False, "DATABASE_URL not set"

    import requests as req

    headers = {
        "Authorization": f"Bearer {pat}",
        "Accept": "application/vnd.github+json",
    }
    base = f"https://api.github.com/repos/{owner}/{repo}"
    wf_url = f"{base}/contents/.github/workflows/sync.yml"

    # Round 1 (parallel): independent calls
    def _patch_public():
        return req.patch(base, headers=headers, json={"private": False}, timeout=10)

    def _enable_actions():
        return req.put(f"{base}/actions/permissions", headers=headers, json={"enabled": True}, timeout=10)

    def _get_public_key():
        return req.get(f"{base}/actions/secrets/public-key", headers=headers, timeout=10)

    def _get_workflow():
        return req.get(wf_url, headers=headers, timeout=10)

    try:
        _, actions_resp, pk_resp, wf_resp = await asyncio.gather(
            asyncio.to_thread(_patch_public),
            asyncio.to_thread(_enable_actions),
            asyncio.to_thread(_get_public_key),
            asyncio.to_thread(_get_workflow),
        )

        if actions_resp.status_code not in (200, 204):
            return False, f"Failed to enable Actions: HTTP {actions_resp.status_code}"
        if not pk_resp.ok:
            return False, f"Failed to get repo public key: HTTP {pk_resp.status_code}"

        # Encrypt the secret with the public key (CPU-bound, fast)
        from nacl import encoding, public

        pk_data = pk_resp.json()
        pk = public.PublicKey(pk_data["key"].encode("utf-8"), encoding.Base64Encoder())
        sealed = public.SealedBox(pk).encrypt(database_url.encode("utf-8"))
        encrypted_value = b64encode(sealed).decode("utf-8")

        sync_yml = _build_sync_workflow_yaml(interval_minutes)
        wf_payload: dict = {
            "message": f"feat: auto-sync every {_format_interval_label(interval_minutes)}",
            "content": b64encode(sync_yml.encode()).decode(),
        }
        if wf_resp.status_code == 200:
            wf_payload["sha"] = wf_resp.json().get("sha")

        # Round 2 (parallel): writes
        def _put_secret():
            return req.put(
                f"{base}/actions/secrets/DATABASE_URL",
                headers=headers,
                json={"encrypted_value": encrypted_value, "key_id": pk_data["key_id"]},
                timeout=10,
            )

        def _put_workflow():
            return req.put(wf_url, headers=headers, json=wf_payload, timeout=10)

        secret_resp, _ = await asyncio.gather(
            asyncio.to_thread(_put_secret),
            asyncio.to_thread(_put_workflow),
        )

        if secret_resp.status_code not in (200, 201, 204):
            return False, f"Failed to set DATABASE_URL secret: HTTP {secret_resp.status_code}"

        # Fire-and-forget initial sync trigger (don't block on it)
        async def _trigger_initial_sync():
            try:
                await asyncio.to_thread(
                    lambda: req.post(
                        f"{base}/dispatches",
                        headers=headers,
                        json={"event_type": "sync-trigger"},
                        timeout=10,
                    )
                )
            except Exception:
                pass

        asyncio.create_task(_trigger_initial_sync())

        return True, f"Auto-sync enabled! Workouts will sync every {_format_interval_label(interval_minutes)}."
    except Exception as e:
        return False, f"Failed to set up auto-sync: {e}"


@app.post("/api/setup-actions", response_class=HTMLResponse)
async def api_setup_actions(request: Request):
    """Auto-configure GitHub Actions on the user's fork."""
    interval = 120
    try:
        form = await request.form()
        raw_interval = form.get("interval", 120)
        interval = int(raw_interval)
    except (ValueError, TypeError):
        interval = 120
    except Exception:
        pass
    ok, msg = await _setup_github_actions(interval_minutes=interval)
    cls = "toast-success" if ok else "toast-error"
    return HTMLResponse(f'<div class="toast {cls}">{msg}</div>')


@app.post("/api/sync-one")
async def api_sync_one(request: Request):
    """Sync exactly 1 unsynced workout. Returns JSON with status."""
    from fastapi.responses import JSONResponse

    if is_demo_mode():
        return JSONResponse({"status": "demo", "message": "Sync disabled in demo mode"})

    if not _acquire_sync_lock():
        return JSONResponse({"error": "Sync already running", "busy": True})

    try:
        # Manual Sync Now — bypass grace so the user gets an immediate upload.
        return await _do_sync_one(request, respect_grace=False)
    finally:
        _sync_executing.release()


def _scan_for_unsynced(hevy, is_synced, total_count, failed_ids, on_page=None):
    """Find the first unsynced Hevy workout, scanning the whole history.

    When the recent workouts are already synced and the unsynced ones are older
    (deep in the list), the search must page far enough back to reach them, so
    the cap covers the whole history (#165). Breaks as soon as an unsynced
    workout is found or the last Hevy page is reached. Returns
    ``(unsynced_workout_or_None, unmapped_counts)``.
    """
    from hevy2garmin.mapper import lookup_exercise

    unsynced = None
    unmapped: dict[str, int] = {}
    page = 1
    max_pages = (total_count // 10) + 2
    while page <= max_pages:
        data = hevy.get_workouts(page=page, page_size=10)
        workouts = data.get("workouts", [])
        if not workouts:
            break
        if on_page is not None:
            on_page(page, data)
        for w in workouts:
            if not unsynced and not is_synced(w["id"]) and w["id"] not in failed_ids:
                unsynced = w
            for ex in w.get("exercises", []):
                name = ex.get("title") or ex.get("name", "")
                if name and lookup_exercise(name, ex.get("exercise_template_id"))[0] == 65534:
                    unmapped[name] = unmapped.get(name, 0) + 1
        if unsynced:
            break
        if page >= data.get("page_count", page):
            break
        page += 1
    return unsynced, unmapped


async def _do_sync_one(request: Request, *, respect_grace: bool = False):
    """Inner sync logic, called with _sync_executing lock held.

    ``respect_grace`` is True for Vercel cron (wait for watch data) and False
    for manual Sync Now.
    """
    from fastapi.responses import JSONResponse

    config = load_config()
    hevy_api_key = config.get("hevy_api_key")

    if not hevy_api_key:
        return JSONResponse({"error": "Hevy API key not configured"}, status_code=400)

    from hevy2garmin.hevy import HevyClient

    hevy = HevyClient(api_key=hevy_api_key)

    # Find first unsynced workout, paginating through recent history
    total_count = hevy.get_workout_count()
    # Cache total for dashboard
    _db = db.get_db()
    _db.set_app_config("hevy_total", {"count": total_count})
    synced_count = db.get_synced_count()
    remaining = max(0, total_count - synced_count)

    def _cache_page(pg, data):
        _db.set_app_config(
            f"hevy_workouts_page_{pg}",
            {"workouts": data.get("workouts", []), "page_count": data.get("page_count", 1)},
        )

    # Skip ids that are already failed this session, or deferred by grace this
    # invocation (cron continues to the next older unsynced workout).
    pending_rows = _db.list_pending()
    pending_ids = {row["hevy_id"] for row in pending_rows}
    skip_ids = set(_failed_ids) | pending_ids
    deferred_count = 0
    unsynced = None
    unmapped_found: dict[str, int] = {}
    garmin_client = None

    from hevy2garmin.sync import _workout_within_grace, sync_one_workout

    while True:
        unsynced, unmapped_found = _scan_for_unsynced(
            hevy, db.is_synced, total_count, skip_ids, on_page=_cache_page
        )
        if unmapped_found:
            _db.set_app_config("unmapped_exercises", unmapped_found)

        if not unsynced:
            if deferred_count:
                return JSONResponse({
                    "synced": 0,
                    "deferred": deferred_count,
                    "remaining": remaining,
                    "done": remaining <= 0,
                })
            remaining = max(0, total_count - db.get_synced_count())
            return JSONResponse({
                "synced": 0, "processing": len(pending_ids),
                "remaining": remaining, "done": remaining <= len(pending_ids),
            })

        # Defer before Garmin auth when possible (cron cold starts).
        grace_minutes = config.get("sync", {}).get("grace_period_minutes", 120)
        if respect_grace and _workout_within_grace(unsynced, grace_minutes):
            logger.info(
                "Deferring %s — within %d min grace; waiting for watch data",
                unsynced["id"],
                grace_minutes,
            )
            deferred_count += 1
            skip_ids.add(unsynced["id"])
            continue

        try:
            from hevy2garmin.garmin import get_client
            from hevy2garmin.merge import reset_circuit_breaker

            if config.get("merge_mode", True):
                reset_circuit_breaker()

            if garmin_client is None:
                garmin_client = get_client(config.get("garmin_email"))
            one = sync_one_workout(
                unsynced,
                cfg=config,
                garmin_client=garmin_client,
                respect_grace=False,  # already checked above
                database=db.get_db(),
            )

            if one.status != "synced":
                return JSONResponse({
                    "synced": 0,
                    one.status: 1,
                    "title": unsynced["title"],
                    "remaining": max(0, hevy.get_workout_count() - db.get_synced_count()),
                    "done": False,
                })

            remaining = hevy.get_workout_count() - db.get_synced_count()
            payload = {
                "synced": 1,
                "title": unsynced["title"],
                "remaining": max(0, remaining),
                "done": remaining <= 0,
            }
            if deferred_count:
                payload["deferred"] = deferred_count
            if one.no_hr:
                payload["no_hr"] = 1
            return JSONResponse(payload)
        except Exception as e:
            logger.error("Sync failed for %s: %s", unsynced.get("title", "?"), str(e)[:300])
            err = str(e)

            # Hevy API key invalid — hard stop, point to setup
            from hevy2garmin.hevy import HevyAuthError
            if isinstance(e, HevyAuthError):
                return JSONResponse({"synced": 0, "error": "Hevy API key is invalid or expired. Go to Setup to enter a new key.", "remaining": -1, "done": False}, status_code=401)

            # Auth errors are hard stops — user needs to reconnect
            if "Login failed" in err or "OAuth" in err or "token" in err:
                return JSONResponse({"synced": 0, "error": "Garmin connection expired. Go to Setup to reconnect.", "remaining": -1, "done": False}, status_code=500)

            # EU consent error — hard stop with clear instructions
            if "upload consent" in err.lower() or "EU location" in err:
                return JSONResponse({
                    "synced": 0,
                    "error": "Garmin requires upload consent. Open connect.garmin.com/modern/settings, scroll to Data, enable Device Upload, then try again.",
                    "eu_consent": True,
                    "remaining": -1, "done": False
                }, status_code=500)

            # Other upload errors — skip this workout for now, don't mark as synced
            # Track in-memory so we don't retry it in the same sync session
            _failed_ids.add(unsynced["id"])
            remaining = hevy.get_workout_count() - db.get_synced_count() - len(_failed_ids)
            logger.warning("Skipping failed workout %s (will retry next session), %d remaining", unsynced["title"], remaining)
            return JSONResponse({"synced": 0, "skipped_error": True, "title": unsynced["title"], "remaining": max(0, remaining), "done": remaining <= 0})


@app.get("/api/cron/sync")
async def cron_sync(request: Request):
    """Vercel cron endpoint. Syncs 1 workout per invocation."""
    from fastapi.responses import JSONResponse

    # Vercel sets CRON_SECRET to verify cron requests
    cron_secret = os.environ.get("CRON_SECRET")
    if cron_secret:
        auth = request.headers.get("authorization")
        if auth != f"Bearer {cron_secret}":
            return JSONResponse({"error": "Unauthorized"}, status_code=401)

    if is_demo_mode():
        return JSONResponse({"status": "demo", "message": "Sync disabled in demo mode"})

    if not _acquire_sync_lock():
        return JSONResponse({"error": "Sync already running", "busy": True})

    try:
        # Cron/autosync — respect grace so watch activities can land first.
        return await _do_sync_one(request, respect_grace=True)
    finally:
        _sync_executing.release()


def run_server(host: str = "0.0.0.0", port: int = 8000) -> None:
    import uvicorn
    logging.basicConfig(format="%(message)s", level=logging.INFO, force=True)
    logger.info("Starting hevy2garmin dashboard at http://localhost:%d", port)
    uvicorn.run(app, host=host, port=port, log_level="warning")
