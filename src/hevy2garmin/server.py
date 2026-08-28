"""FastAPI web dashboard for hevy2garmin."""

from __future__ import annotations

import asyncio
import hmac
import logging
import os
import re
from contextlib import asynccontextmanager
from datetime import date, datetime, timezone
from html import escape
from math import ceil
from pathlib import Path

from fastapi import FastAPI, Form, Query, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.concurrency import run_in_threadpool
from fastapi.staticfiles import StaticFiles

from hevy2garmin import autosync, db, garmin_login, login_ratelimit, mapper, pages, syncstate
from hevy2garmin.db_interface import NoWritableDatabaseError
from hevy2garmin.auth import (
    auth_enabled, verify_session, sign_session, check_password, SESSION_COOKIE, session_ttl,
)
from hevy2garmin.config import is_configured, load_config, save_config
from hevy2garmin.demo import is_demo_mode
from hevy2garmin.ratelimit import record_rate_limit, cooldown_remaining, format_cooldown
from hevy2garmin.webctx import (
    _apply_prefix,
    _jinja_env,
    _prefix_location,
    _render,
    _url_prefix,
    _validated_prefix,
    client_ip,
    is_https,
    trust_forwarded_prefix,
)
from hevy2garmin.sync import (
    sync,
    sync_routines,
    sync_routine,
    routine_schedule_dates,
    schedule_routine,
    unschedule_routine_entry,
)

logger = logging.getLogger("hevy2garmin")

STATIC_DIR = Path(__file__).parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Start the auto-sync timer if configured, and cancel it on shutdown.

    Scheduling and cancelling both live in :mod:`hevy2garmin.autosync`.
    """
    config = load_config()
    auto_cfg = config.get("auto_sync", {})
    if auto_cfg.get("enabled", False):
        interval = auto_cfg.get("interval_minutes", 30)
        logger.info("Auto-sync enabled on startup: every %d min", interval)
        autosync.schedule(interval)
    try:
        yield
    finally:
        # Without this a pending timer survives reload/shutdown and can fire a
        # sync against a half-torn-down process.
        autosync.stop()


app = FastAPI(title="hevy2garmin", docs_url=None, redoc_url=None, lifespan=lifespan)
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


# The page routes live in ``hevy2garmin.pages``, included here roughly where they
# used to be defined. No page path overlaps one declared below — the closest pair
# is "/api/workout/{id}/hr" against "/api/workout/{id}/mark-synced" — so the
# registration order carries no meaning and moving this line cannot reroute a
# request. Middleware is unaffected either way: it is a separate stack.
app.include_router(pages.router)


@app.exception_handler(NoWritableDatabaseError)
async def _no_database_handler(request: Request, exc: NoWritableDatabaseError) -> HTMLResponse:
    """Render an actionable 'add a database' page instead of a raw 500 (#145, #142)."""
    logger.warning("No writable database on %s: %s", request.url.path, exc)
    return HTMLResponse(_NO_DB_PAGE, status_code=503)


# ── Sync-session caches ─────────────────────────────────────────────────────
# The shared sync lock and the last-sync timestamp live in
# ``hevy2garmin.syncstate``; the auto-sync loop lives in ``hevy2garmin.autosync``
# and the unmapped-exercise cache in ``hevy2garmin.pages``. What is left here is
# the per-session failed-upload set, which only this module's routes touch.

_failed_ids: set[str] = set()  # Workouts that failed upload this session (retried next session)


_epoch_cache = 0


def _session_epoch() -> int:
    """Current 'sign out everywhere' epoch from app_config.

    Best-effort: on a DB error, return the last value we successfully read
    (default 0) so a transient outage never spuriously invalidates sessions.
    """
    global _epoch_cache
    try:
        v = db.get_db().get_app_config("session_epoch")
        _epoch_cache = int(v.get("n", 0)) if isinstance(v, dict) else 0
    except Exception:
        return _epoch_cache
    return _epoch_cache


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
    # When a password is set, all routes except /login and /api/cron/*
    # require a valid session cookie. Without it, redirect to /login.
    if auth_enabled() and path not in ("/login",) and not path.startswith("/api/cron/"):
        session_cookie = request.cookies.get(SESSION_COOKIE)
        if not verify_session(session_cookie, _session_epoch()):
            if path.startswith("/api/"):
                from starlette.responses import Response
                return Response("Unauthorized", status_code=401)
            return RedirectResponse(f"/login?next={path}")

    # Auth check for POST /api/* endpoints (CSRF protection).
    # Cron and the Hevy webhook have their own Bearer token check. All others
    # require the cookie or X-Api-Key.
    if (
        secret
        and request.method == "POST"
        and path.startswith("/api/")
        and path not in ("/api/cron/sync", "/api/cron/webhook")
    ):
        token = request.cookies.get("h2g_auth") or request.headers.get("x-api-key")
        if token != secret:
            from starlette.responses import Response
            return Response("Unauthorized", status_code=401)

    # Setup page and sync endpoints: skip the "is configured?" redirect
    if path in ("/login", "/setup", "/api/sync-one", "/api/cron/sync", "/api/cron/webhook",
                "/api/setup-actions", "/api/garmin-ticket", "/api/garmin-login",
                "/api/garmin-login-mfa"):
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
        response.set_cookie("h2g_auth", secret, httponly=True, samesite="strict",
                            secure=is_https(request), max_age=365 * 86400)

    return response


# Registered after check_setup so it wraps it, which is what lets it fix the
# Location of the redirects check_setup issues itself (the /login and /setup
# gates) — those never reach a route handler.
@app.middleware("http")
async def reverse_proxy_prefix(request: Request, call_next):
    """Serve correctly when a proxy mounts this app below the origin root.

    Reads X-Forwarded-Prefix (e.g. "/apps/hevy2garmin") once per request and
    publishes it for the rest of the request; the trailing slash is trimmed so
    callers concatenate a leading-slash path. Redirect targets are moved onto
    the prefix here, because a proxy sees only a root-relative Location it has
    no way to attribute. Empty header = empty prefix = unchanged behaviour.

    The header is only read when H2G_TRUST_FORWARDED_PREFIX is set, and then only
    if it is a plain absolute path — see trust_forwarded_prefix and
    _validated_prefix. Anything else is treated as no prefix at all.
    """
    prefix = (
        _validated_prefix(request.headers.get("x-forwarded-prefix", ""))
        if trust_forwarded_prefix()
        else ""
    )
    token = _url_prefix.set(prefix)
    try:
        response = await call_next(request)
    finally:
        _url_prefix.reset(token)
    if prefix:
        location = response.headers.get("location")
        if location:
            response.headers["location"] = _prefix_location(location, prefix)
    return response


@app.middleware("http")
async def security_headers(request: Request, call_next):
    """Defense-in-depth response headers. Registered after check_setup so it is
    the outermost middleware and stamps every response — including redirects and
    the lock/DB pages."""
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault("Cross-Origin-Opener-Policy", "same-origin")
    # Pragmatic CSP: only the high-value, no-cost directives. A strict
    # script/style policy is deferred because the templates use inline JS and
    # load scripts from CDNs (would need 'unsafe-inline').
    response.headers.setdefault(
        "Content-Security-Policy",
        "frame-ancestors 'none'; form-action 'self'; base-uri 'self'",
    )
    if is_https(request):
        response.headers.setdefault(
            "Strict-Transport-Security", "max-age=31536000; includeSubDomains"
        )
    return response


# ── Auth pages ───────────────────────────────────────────────────────────────

def _render_login(*, error: str | None, status_code: int = 200) -> HTMLResponse:
    """Render login.html. Not routed through _render: it has no shared context."""
    prefix = _url_prefix.get()
    html = _jinja_env.get_template("login.html").render(error=error, url_prefix=prefix)
    return HTMLResponse(_apply_prefix(html, prefix), status_code=status_code)


@app.get("/login", response_class=HTMLResponse)
async def login_page(request: Request):
    """Show login form. Redirects to dashboard if already authenticated or auth disabled."""
    if not auth_enabled() or verify_session(request.cookies.get(SESSION_COOKIE), _session_epoch()):
        return RedirectResponse("/")
    error = request.query_params.get("error")
    return _render_login(error=error)


@app.post("/login")
async def login_submit(request: Request, password: str = Form(...)):
    """Verify password (rate-limited), set session cookie, redirect to dashboard."""
    next_url = request.query_params.get("next", "/")
    # Prevent open redirect: only allow relative paths
    if not next_url.startswith("/") or next_url.startswith("//"):
        next_url = "/"

    key = client_ip(request)
    try:
        store = db.get_db()
    except Exception:
        store = None  # DB unavailable → skip the limiter (never lock the admin out on an outage)

    def _error(msg: str, status: int) -> HTMLResponse:
        return _render_login(error=msg, status_code=status)

    # Rate limit: check the lockout BEFORE comparing credentials.
    remaining = login_ratelimit.lockout_remaining(store, key) if store else 0
    if remaining > 0:
        return _error(f"Too many attempts. Try again in {format_cooldown(remaining)}.", 429)

    if not check_password(password):
        remaining = 0
        if store:
            login_ratelimit.record_failure(store, key)
            remaining = login_ratelimit.lockout_remaining(store, key)
        if remaining > 0:
            return _error(f"Too many attempts. Try again in {format_cooldown(remaining)}.", 429)
        return _error("Wrong password.", 401)

    if store:
        login_ratelimit.clear_failures(store, key)
    response = RedirectResponse(next_url, status_code=303)
    response.set_cookie(
        SESSION_COOKIE, sign_session(_session_epoch()),
        httponly=True, samesite="strict", secure=is_https(request), max_age=session_ttl(),
    )
    return response


@app.post("/logout")
async def logout():
    """Clear session cookie and redirect to login."""
    response = RedirectResponse("/login", status_code=303)
    response.delete_cookie(SESSION_COOKIE)
    return response


@app.post("/logout-all")
async def logout_all():
    """Sign out everywhere: bump the server-side epoch so every outstanding
    session cookie (on all devices) stops validating."""
    global _epoch_cache
    try:
        store = db.get_db()
        cur = store.get_app_config("session_epoch")
        n = int(cur.get("n", 0)) if isinstance(cur, dict) else 0
        store.set_app_config("session_epoch", {"n": n + 1})
        _epoch_cache = n + 1
    except Exception:
        # Don't pretend success: the epoch never advanced, so other devices are
        # still signed in. Keep this session and surface the error so the admin
        # can retry, instead of redirecting to /login as if it worked.
        logger.warning("could not bump session epoch for /logout-all", exc_info=True)
        return RedirectResponse("/settings?err=logout_all", status_code=303)
    response = RedirectResponse("/login", status_code=303)
    response.delete_cookie(SESSION_COOKIE)
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


@app.post("/api/garmin-login")
async def garmin_login_begin(request: Request):
    """Direct (self-hosted) Garmin login, step 1. The password never leaves the host."""
    from fastapi.responses import JSONResponse

    body = await request.json()
    email = (body.get("email") or "").strip()
    password = body.get("password") or ""
    if not email or not password:
        return JSONResponse({"status": "error", "message": "Email and password required"}, status_code=400)

    # Same limiter the dashboard login uses. Garmin rate-limits the account
    # itself, so hammering this endpoint locks the user out upstream — worth
    # throttling locally first, especially on an open self-host.
    key = f"garmin-login:{client_ip(request)}"
    try:
        store = db.get_db()
    except Exception:
        store = None  # DB unavailable → skip the limiter, never block setup on an outage
    remaining = login_ratelimit.lockout_remaining(store, key) if store else 0
    if remaining > 0:
        return JSONResponse(
            {"status": "error", "message": f"Too many attempts. Try again in {format_cooldown(remaining)}."},
            status_code=429,
        )

    result = await run_in_threadpool(garmin_login.begin, email, password)
    if store:
        if result.get("status") in ("success", "needs_mfa"):
            login_ratelimit.clear_failures(store, key)
        else:
            login_ratelimit.record_failure(store, key)
    return JSONResponse(result)


@app.post("/api/garmin-login-mfa")
async def garmin_login_mfa(request: Request):
    """Direct (self-hosted) Garmin login, step 2 — submit the MFA code."""
    from fastapi.responses import JSONResponse

    body = await request.json()
    session_id = (body.get("session_id") or "").strip()
    code = (body.get("code") or "").strip()
    if not session_id or not code:
        return JSONResponse({"status": "error", "message": "session_id and code required"}, status_code=400)
    result = await run_in_threadpool(garmin_login.complete, session_id, code)
    return JSONResponse(result)




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
    valid_cats = set(mapper._get_cat_names().keys())
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

    pages.invalidate_unmapped_cache()

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

    cat_label = mapper._get_cat_names().get(category, f"Category {category}")
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
        pages.invalidate_unmapped_cache()
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

    pages.invalidate_unmapped_cache()

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
    return JSONResponse({str(k): v for k, v in mapper._get_cat_names().items()})


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

    if not syncstate.acquire_sync_lock():
        return HTMLResponse('<div class="toast toast-error">Another sync is already running. Please wait.</div>')

    try:
        result = sync(**sync_kwargs, record_log=False, respect_grace=False)
    except Exception as e:
        result = {"synced": 0, "skipped": 0, "failed": 1, "unmapped": [], "error": str(e)}
    finally:
        syncstate.release_sync_lock()
    syncstate.mark_synced()
    syncstate.record_sync_log(result, trigger=f"manual ({scope})")
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


# Timestamp cache for the page-load routine reconciliation, kept in the app_config KV
# store (like ratelimit's cooldown) so it survives serverless restarts. The reconcile
# *result* is the synced_routines.status column itself — this only throttles the check.
_ROUTINE_RECONCILE_KEY = "routine_reconcile"
_ROUTINE_RECONCILE_TTL = 300  # seconds


def _reconcile_routines_best_effort(store, config: dict) -> None:
    """Refresh "does the Garmin workout still exist" state, at most every TTL.

    Best-effort by design: any failure (no Garmin auth, rate-limit cooldown, network)
    leaves the DB state untouched and the page renders from it.
    """
    try:
        from hevy2garmin._isotime import parse_iso
        from hevy2garmin.garmin import get_client, list_workouts
        from hevy2garmin.reconcile import reconcile_missing_routine_workouts

        state = store.get_app_config(_ROUTINE_RECONCILE_KEY) or {}
        if state.get("checked_at"):
            age = (datetime.now(timezone.utc) - parse_iso(state["checked_at"])).total_seconds()
            if age < _ROUTINE_RECONCILE_TTL:
                return
        if cooldown_remaining(store) > 0:
            return
        if not any(r.get("garmin_workout_id") for r in store.list_synced_routines()):
            return  # nothing to check — don't even authenticate
        client = get_client(
            config.get("garmin_email"), config.get("garmin_password", ""),
            config.get("garmin_token_dir", "~/.garminconnect"),
        )
        reconcile_missing_routine_workouts(store, list_workouts(client, limit=999))
        store.set_app_config(
            _ROUTINE_RECONCILE_KEY,
            {"checked_at": datetime.now(timezone.utc).isoformat()},
        )
    except Exception:
        logger.debug("routine reconcile on page load skipped", exc_info=True)


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
        from hevy2garmin.sync import fetch_all_routines, _cache_routines_total, routine_payload_hash

        _db = db.get_db()
        _reconcile_routines_best_effort(_db, config)
        hevy = HevyClient(api_key=config.get("hevy_api_key"))
        all_routines = fetch_all_routines(hevy)
        _cache_routines_total(_db, len(all_routines))
        for r in all_routines:
            record = _db.get_synced_routine(r.get("id", ""))
            exercises = [
                {
                    "name": ex.get("title") or ex.get("name") or "Exercise",
                    "sets": len(ex.get("sets") or []),
                }
                for ex in (r.get("exercises") or [])
            ]
            # The routine drifted on Hevy since the last sync when the payload it
            # would produce now no longer hashes to what we synced. Legacy rows with
            # no stored hash count as drifted — a sync would recreate them too.
            needs_update = False
            if record is not None:
                try:
                    needs_update = record.get("content_hash") != routine_payload_hash(r, config)
                except Exception:
                    logger.debug("Could not hash routine %s", r.get("id"), exc_info=True)
            routines.append({
                "id": r.get("id", ""),
                "title": r.get("title") or r.get("name") or "Routine",
                "exercises": exercises,
                "exercise_count": len(exercises),
                "synced": record is not None,
                "needs_update": needs_update,
                "missing": (record or {}).get("status") == "missing_on_garmin",
                "scheduled_date": (record or {}).get("scheduled_date"),
            })
    except Exception:
        logger.exception("Failed to load Hevy routines")
        fetch_error = "Could not load routines from Hevy. Check your API key and try again."

    total = len(routines)
    synced = sum(1 for r in routines if r["synced"])
    stats = {
        "total": total,
        "synced": synced,
        "pending": max(0, total - synced),
        "needs_update": sum(1 for r in routines if r["needs_update"]),
        "scheduled": sum(1 for r in routines if r["scheduled_date"]),
        "pct": round(synced / total * 100) if total else 0,
    }
    return _render(
        "routines.html", request=request, routines=routines, stats=stats,
        fetch_error=fetch_error, **schedules
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

    if not syncstate.acquire_sync_lock():
        return HTMLResponse('<div class="toast toast-error">Another sync is already running. Please wait.</div>')

    try:
        result = sync_routines(dry_run=False, force=force)
    except Exception:
        logger.exception("Routine sync failed")
        return HTMLResponse('<div class="toast toast-error">Routine sync failed. Check the logs for details.</div>')
    finally:
        syncstate.release_sync_lock()

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

    if not syncstate.acquire_sync_lock():
        return HTMLResponse('<div class="toast toast-error">Another sync is already running. Please wait.</div>')

    try:
        result = sync_routine(hevy_routine_id, force=force)
    except Exception:
        logger.exception("Routine %s sync failed", hevy_routine_id)
        return HTMLResponse('<div class="toast toast-error">Routine sync failed. Check the logs for details.</div>')
    finally:
        syncstate.release_sync_lock()

    outcome = result["outcome"]
    # The routine title is user-controlled (Hevy account data), so escape it before
    # interpolating into the toast HTML — these f-strings bypass Jinja's autoescape.
    title = escape(result["row"]["title"])
    if outcome == "failed":
        return HTMLResponse(f'<div class="toast toast-error">Could not sync "{title}". Check the logs.</div>')
    # Toast into #routines-result plus an out-of-band swap of the updated row, so it flips
    # to "synced" (and gains the Schedule form) without a full page reload. HX-Trigger
    # refreshes the schedules table since the restore path may have re-booked dates.
    row_html = _render("routine_row.html", r=result["row"], oob=True).body.decode()
    toast = f'<div class="toast toast-success">Synced "{title}" ({outcome}).</div>'
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

    if not syncstate.acquire_sync_lock():
        return HTMLResponse('<div class="toast toast-error">Another sync is already running. Please wait.</div>')

    try:
        result = schedule_routine(hevy_routine_id, dates)
    except ValueError as e:
        return HTMLResponse(f'<div class="toast toast-error">{e}</div>')
    except Exception:
        logger.exception("Scheduling routine %s failed", hevy_routine_id)
        return HTMLResponse('<div class="toast toast-error">Scheduling failed. Check the logs for details.</div>')
    finally:
        syncstate.release_sync_lock()

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

    if not syncstate.acquire_sync_lock():
        return HTMLResponse('<div class="toast toast-error">Another sync is already running. Please wait.</div>')

    try:
        unschedule_routine_entry(hevy_routine_id, schedule_id)
    except Exception:
        logger.exception("Unscheduling routine %s entry %s failed", hevy_routine_id, schedule_id)
        return HTMLResponse('<div class="toast toast-error">Could not remove the scheduled workout. Check the logs.</div>')
    finally:
        syncstate.release_sync_lock()

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
        one = sync_one_workout(
            workout,
            cfg=config,
            garmin_client=garmin_client,
            force_upload=force_upload,
            respect_grace=False,
            database=db.get_db(),
        )
        syncstate.record_sync_log(
            {"synced": 1 if one.status == "synced" else 0,
             "failed": 1 if one.status == "failed" else 0},
            trigger="manual (single)",
        )

        start = (workout.get("start_time") or "")[:16]
        return HTMLResponse(f'<tr><td><span class="badge badge-success">✓ Synced</span></td><td>{start}</td><td><strong>{workout["title"]}</strong></td><td>{len(workout.get("exercises", []))}</td><td></td></tr>')
    except Exception as e:
        syncstate.record_sync_log({"failed": 1}, trigger="manual (single)")
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
            autosync.schedule(interval)
        logger.info("Auto-sync enabled: every %d min", interval)
    else:
        autosync.stop()
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

    auto_sync = autosync.status()
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
async def api_sync_one(request: Request, merge_only: bool = Query(False)):
    """Sync exactly 1 unsynced workout. Returns JSON with status."""
    # Manual Sync Now — bypass grace so the user gets an immediate upload.
    return await _sync_one_recorded(
        respect_grace=False, merge_only=merge_only, trigger="manual (one)"
    )


async def _sync_one_recorded(
    *,
    respect_grace: bool = False,
    merge_only: bool = False,
    trigger: str = "manual (one)",
):
    """Take the sync lock, sync one workout, and record it in the sync log.

    Shared by every single-workout trigger so each one shows up on /history.
    Dashboard and cron syncs previously left no trace, which made "what ran
    this sync?" unanswerable when diagnosing a sync that stopped happening.
    """
    import json as _json

    from fastapi.responses import JSONResponse

    logger.info("Sync request started (trigger=%s)", trigger)

    # Failed ids are only a per-run quarantine. A later manual click is a new
    # attempt and must be allowed to retry the workout; keeping this process
    # global forever can turn one transient upload error into a permanent
    # remaining=1 / no-candidate state.
    if trigger.startswith("manual") and _failed_ids:
        logger.info("Clearing %d previously failed workout quarantine(s)", len(_failed_ids))
        _failed_ids.clear()

    if is_demo_mode():
        return JSONResponse({"status": "demo", "message": "Sync disabled in demo mode"})

    if not syncstate.acquire_sync_lock():
        logger.info("Sync request rejected: another sync is already running")
        return JSONResponse({"error": "Sync already running", "busy": True})

    try:
        resp = await _do_sync_one(respect_grace=respect_grace, merge_only=merge_only)
    except Exception:
        # Record before re-raising, so a crash mid-sync is not the one failure
        # mode that leaves /history looking healthy. The per-row and auto paths
        # both record on exception; this makes cron and Sync Now agree.
        syncstate.record_sync_log({"failed": 1}, trigger=trigger)
        raise
    finally:
        syncstate.release_sync_lock()

    try:
        data = _json.loads(bytes(resp.body))
        # `failed` is what _do_sync_one reports for a non-synced outcome
        # ({"synced": 0, one.status: 1}); without it a rejected upload lands as
        # 0 synced / 0 failed, indistinguishable from "nothing to sync" — the
        # exact ambiguity this is meant to remove. error/skipped_error are the
        # hard-stop shapes. needs_review/processing stay 0/0: still in flight.
        failed = 1 if (data.get("error") or data.get("skipped_error") or data.get("failed")) else 0
        syncstate.record_sync_log({"synced": data.get("synced", 0), "failed": failed}, trigger=trigger)
    except Exception:
        logger.debug("sync_log record failed", exc_info=True)
    return resp


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


async def _do_sync_one(*, respect_grace: bool = False, merge_only: bool = False):
    """Inner sync logic, called with the shared sync lock held.

    ``respect_grace`` is True for Vercel cron (wait for watch data) and False
    for manual Sync Now.
    """
    from fastapi.responses import JSONResponse

    config = load_config()
    hevy_api_key = config.get("hevy_api_key")

    if not hevy_api_key:
        logger.error("Sync stopped: Hevy API key is not configured")
        return JSONResponse({"error": "Hevy API key not configured"}, status_code=400)

    from hevy2garmin.hevy import HevyClient

    logger.info("Connecting to Hevy API")
    hevy = HevyClient(api_key=hevy_api_key)

    # Find first unsynced workout, paginating through recent history
    total_count = hevy.get_workout_count()
    logger.info("Connected to Hevy API: %d workouts reported", total_count)
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

    logger.info(
        "Sync state: %d Hevy workouts, %d synced in database, %d pending uploads",
        total_count,
        synced_count,
        len(pending_rows),
    )

    from hevy2garmin.sync import _workout_within_grace, reconcile_pending, sync_one_workout

    # A previous upload may have reached Garmin after the request that created
    # it returned. Reconcile that durable checkpoint before selecting a fresh
    # workout; this path never uploads, it only resolves/finalizes evidence that
    # is already recorded in pending_uploads.
    if pending_rows:
        try:
            from hevy2garmin.garmin import get_client

            garmin_client = get_client(config.get("garmin_email"))
            pending = pending_rows[0]
            one = reconcile_pending(_db, garmin_client, pending["hevy_id"])
            if one.status == "synced":
                remaining = max(0, hevy.get_workout_count() - db.get_synced_count())
                return JSONResponse({
                    "synced": 1,
                    "title": (pending.get("payload") or {}).get("title", "Workout"),
                    "remaining": remaining,
                    "done": remaining <= 0,
                    "reconciled": True,
                })
            return JSONResponse({
                "synced": 0,
                one.status: 1,
                "remaining": max(0, hevy.get_workout_count() - db.get_synced_count()),
                "done": False,
                "reconciled": True,
            })
        except Exception as e:
            logger.error("Reconciliation failed for pending upload: %s", str(e)[:300])
            return JSONResponse(
                {"synced": 0, "processing": 1, "reconciled": True, "error": str(e)[:300]},
                status_code=500,
            )

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
            if remaining > 0 and not pending_ids:
                logger.error(
                    "Sync stopped: Hevy reports %d workouts but no unsynced workout was found "
                    "after scanning; database has %d synced records",
                    total_count,
                    db.get_synced_count(),
                )
                return JSONResponse(
                    {
                        "synced": 0,
                        "processing": 0,
                        "remaining": remaining,
                        "done": False,
                        "state_mismatch": True,
                        "error": (
                            "Hevy reports an unsynced workout, but it was not returned by the "
                            "workout list. Open Workouts, click Reload Data, and try again."
                        ),
                    },
                    status_code=409,
                )
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
                logger.info("Connecting to Garmin Connect")
                garmin_client = get_client(config.get("garmin_email"))
                logger.info("Connected to Garmin Connect")
            logger.info("Syncing Hevy workout: %s (%s)", unsynced.get("title", "?"), unsynced.get("id", "?"))
            one = sync_one_workout(
                unsynced,
                cfg=config,
                garmin_client=garmin_client,
                respect_grace=False,  # already checked above
                merge_only=merge_only,
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


def _bearer_ok(request: Request, secret: str) -> bool:
    """Constant-time check of `Authorization: Bearer <secret>`.

    compare_digest rather than `!=` so the comparison cannot leak the shared
    secret a byte at a time to a caller who can time the response.
    """
    auth = request.headers.get("authorization") or ""
    return hmac.compare_digest(auth, f"Bearer {secret}")


@app.get("/api/cron/sync")
async def cron_sync(request: Request, merge_only: bool = Query(False)):
    """Vercel cron endpoint. Syncs 1 workout per invocation."""
    from fastapi.responses import JSONResponse

    # This route is internet-facing and bypasses dashboard-cookie auth. Fail
    # closed when it has no bearer secret, just like the webhook endpoint.
    cron_secret = os.environ.get("CRON_SECRET")
    if not cron_secret:
        return JSONResponse(
            {"error": "Cron not configured: CRON_SECRET is unset"}, status_code=503
        )
    if not _bearer_ok(request, cron_secret):
        return JSONResponse({"error": "Unauthorized"}, status_code=401)

    # Cron/autosync — respect grace so watch activities can land first.
    return await _sync_one_recorded(respect_grace=True, merge_only=merge_only, trigger="cron")


# ── Hevy webhook receiver ────────────────────────────────────────────────────
# Hevy fires this when a workout is saved. The paired watch activity usually
# reaches Garmin Connect a few minutes later, so the sync is staged: wait,
# then try merge-only, and only the final attempt falls back to a plain FIT
# upload — so a workout is never left unsynced. Retry state is in-memory
# only; a restart drops it and auto-sync is the safety net.
WEBHOOK_DELAY_SECONDS = int(os.environ.get("WEBHOOK_DELAY_SECONDS", "300"))
WEBHOOK_RETRY_INTERVAL_SECONDS = int(os.environ.get("WEBHOOK_RETRY_INTERVAL_SECONDS", "600"))
WEBHOOK_MAX_ATTEMPTS = int(os.environ.get("WEBHOOK_MAX_ATTEMPTS", "3"))
# Ceiling on concurrently staged syncs; a burst past this is declined, not queued.
WEBHOOK_MAX_INFLIGHT = int(os.environ.get("WEBHOOK_MAX_INFLIGHT", "4"))

_webhook_tasks: set = set()  # strong refs — bare asyncio tasks get garbage collected


def _can_run_background_work() -> bool:
    """Whether work scheduled now will still run after the response is sent.

    False on serverless, where the function is frozen or torn down as soon as
    it responds: an asyncio task created here would simply never be resumed.
    Python on Vercel has no `waitUntil` equivalent to hand the work to.
    """
    return not os.environ.get("VERCEL")


async def _webhook_sync() -> None:
    """Background worker behind /api/cron/webhook."""
    import asyncio
    import json

    await asyncio.sleep(WEBHOOK_DELAY_SECONDS)
    for attempt in range(1, WEBHOOK_MAX_ATTEMPTS + 1):
        is_last = attempt == WEBHOOK_MAX_ATTEMPTS
        try:
            resp = await _sync_one_recorded(merge_only=not is_last, trigger="webhook")
            data = json.loads(bytes(resp.body))
        except Exception as e:
            logger.error("Webhook sync attempt %d/%d failed: %s",
                         attempt, WEBHOOK_MAX_ATTEMPTS, str(e)[:300])
            return
        # A lock collision with auto-sync is not an answer — retry, don't give up.
        retry = bool(data.get("busy")) or bool(data.get("merge_pending"))
        if not retry:
            logger.info(
                "Webhook sync attempt %d/%d: %s",
                attempt,
                WEBHOOK_MAX_ATTEMPTS,
                f"synced '{data.get('title', '?')}'" if data.get("synced") else "nothing pending",
            )
            return
        if not is_last:
            await asyncio.sleep(WEBHOOK_RETRY_INTERVAL_SECONDS)
    logger.warning(
        "Webhook sync: workout still pending after %d attempts — auto-sync will retry",
        WEBHOOK_MAX_ATTEMPTS,
    )


async def _webhook_sync_serverless():
    """Handle the webhook without background work, for serverless deployments.

    There is no "later" here: the process stops at the response, so the staged
    retry cannot run. What is safe to do instead depends on the watch merge:

    - Merge on (the default): the watch activity has almost certainly not
      reached Garmin Connect yet. Uploading now produces exactly the duplicate
      the merge exists to prevent, and there is no second attempt to wait for,
      so hand the workout to the platform cron and only say so.
    - Merge off: nothing is being waited for, so sync immediately — which is
      the whole point of a webhook, and a large win over a daily cron.
    """
    from fastapi.responses import JSONResponse

    if load_config().get("merge_mode", True):
        logger.info(
            "Hevy webhook received on a serverless deployment with the watch merge on — "
            "leaving it to the scheduled sync so the watch activity can land first"
        )
        return JSONResponse({"status": "deferred", "reason": "no background work; cron will sync"})

    logger.info("Hevy webhook received — syncing now (watch merge off, nothing to wait for)")
    return await _sync_one_recorded(respect_grace=False, trigger="webhook")


@app.post("/api/cron/webhook")
async def cron_webhook(request: Request):
    """Hevy webhook endpoint, fired when a workout is saved.

    Hevy expects a 200 within a few seconds, so on a long-running deployment
    this only checks the Bearer token and schedules the staged sync in the
    background. Serverless has no background to schedule into — see
    _webhook_sync_serverless.
    """
    import asyncio

    from fastapi.responses import JSONResponse

    # Fail CLOSED. This endpoint is internet-facing by design and is exempt from
    # the dashboard cookie/CSRF middleware, so treating "no secret set" as "no
    # auth needed" leaves an anonymous sync trigger exposed on any instance
    # whose owner set a dashboard password but read CRON_SECRET as a Vercel-only
    # concern. Unconfigured means unavailable, not open.
    cron_secret = os.environ.get("CRON_SECRET")
    if not cron_secret:
        logger.warning(
            "Hevy webhook refused: CRON_SECRET is not set, so there is no way to authenticate "
            "Hevy. Set CRON_SECRET to enable the endpoint."
        )
        return JSONResponse(
            {"error": "Webhook not configured: CRON_SECRET is unset"}, status_code=503
        )
    if not _bearer_ok(request, cron_secret):
        logger.warning("Hevy webhook rejected: bad or missing Authorization header")
        return JSONResponse({"error": "Unauthorized"}, status_code=401)

    if not _can_run_background_work():
        return await _webhook_sync_serverless()

    # Each accepted request owns a task for up to WEBHOOK_DELAY +
    # (MAX_ATTEMPTS - 1) * RETRY_INTERVAL seconds (~25 min by default), so
    # unbounded spawning lets a burst pile up tasks that only queue on the sync
    # lock and hammer Garmin. Past the cap, decline to add another: those
    # already staged plus auto-sync cover the work, and Hevy still gets a 200 so
    # it does not retry into the same wall.
    if len(_webhook_tasks) >= WEBHOOK_MAX_INFLIGHT:
        logger.warning(
            "Hevy webhook throttled: %d staged syncs already in flight — they and "
            "auto-sync will pick this workout up",
            len(_webhook_tasks),
        )
        return JSONResponse({"status": "throttled", "in_flight": len(_webhook_tasks)})

    logger.info(
        "Hevy webhook received — staged sync in %ds (up to %d attempts)",
        WEBHOOK_DELAY_SECONDS,
        WEBHOOK_MAX_ATTEMPTS,
    )
    task = asyncio.create_task(_webhook_sync())
    _webhook_tasks.add(task)
    task.add_done_callback(_webhook_tasks.discard)
    return JSONResponse({"status": "accepted"})


def run_server(host: str = "0.0.0.0", port: int = 8000) -> None:
    import uvicorn
    logging.basicConfig(
        format="%(asctime)s %(message)s", datefmt="%Y-%m-%d %H:%M:%S",
        level=logging.INFO, force=True,
    )
    logger.info("Starting hevy2garmin dashboard at http://localhost:%d", port)
    uvicorn.run(app, host=host, port=port, log_level="warning")
