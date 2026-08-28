"""Per-request web context: what the client sees, and how HTML is rendered back.

Everything here answers a question about talking to a browser that may be several
hops away: who the client really is, whether the original request was secure,
where the app is mounted, and how to render a template so every URL it emits
still resolves. The route modules and the middleware in :mod:`hevy2garmin.server`
all need these answers, which is why they live in their own module rather than in
any one of them.
"""

from __future__ import annotations

import contextvars
import os
import re
from datetime import date
from html import escape
from pathlib import Path
from typing import Any

from fastapi import Request
from fastapi.responses import HTMLResponse
from jinja2 import Environment, FileSystemLoader

from hevy2garmin import __version__
from hevy2garmin.auth import auth_enabled
from hevy2garmin.demo import is_demo_mode

TEMPLATES_DIR = Path(__file__).parent / "templates"

# Sub-path this app is served under when it sits behind a reverse proxy that
# mounts it below the origin root (X-Forwarded-Prefix, e.g. "/apps/hevy2garmin").
# Empty for a normal root install; set per request by the middleware.
#
# Every URL this app emits is root-absolute ("/workouts", "/api/sync-one"), which
# is correct at the root and wrong one level down, so all three kinds are moved
# onto the prefix: HTML attributes and redirect Locations server-side (below),
# and the URLs the page's JavaScript builds at runtime via `window.APP_PREFIX`
# (base.html). A proxy cannot fix the third kind, so the app has to own all of it.
_url_prefix: contextvars.ContextVar[str] = contextvars.ContextVar("url_prefix", default="")

# Root-absolute URL in an attribute that navigates or fetches. Deliberately not
# every attribute: only these carry a URL the browser resolves against the origin.
_ROOT_ABSOLUTE_ATTR = re.compile(
    r'(\s(?:href|src|action|hx-get|hx-post|hx-put|hx-patch|hx-delete)=")/(?!/)'
)

# A prefix is a single-origin absolute path and nothing else. The character class
# excludes ":" (no scheme), quotes and angle brackets (no breaking out of an
# attribute or a script tag), and the explicit "//" rejection blocks a
# protocol-relative value, which would silently re-point every URL on the page at
# another host.
_SAFE_PREFIX = re.compile(r"^/[A-Za-z0-9._~/-]+$")


def trust_forwarded_prefix() -> bool:
    """Whether X-Forwarded-Prefix may be believed.

    Off by default, and that default is the security boundary: any client can
    send the header, so on a directly-exposed instance — or one behind a proxy
    that forwards client headers untouched — trusting it hands an attacker
    control of every URL the page emits, including the login form's action and
    the Garmin token POST. Only the operator knows a proxy is setting it.
    """
    return os.environ.get("H2G_TRUST_FORWARDED_PREFIX", "").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )


def _validated_prefix(raw: str) -> str:
    """Normalize a claimed sub-path, or return "" if it is not one.

    Rejecting outright rather than sanitizing: a prefix that needed cleaning was
    not sent by the proxy this feature exists for, and serving the page at the
    origin root is the safe fallback in every case.
    """
    candidate = (raw or "").strip().rstrip("/")
    if not candidate or candidate.startswith("//") or not _SAFE_PREFIX.match(candidate):
        return ""
    return candidate


def _apply_prefix(html: str, prefix: str) -> str:
    """Move root-absolute URL attributes in ``html`` onto ``prefix``.

    A no-op without a prefix, so a root install renders byte-identical HTML.
    Rewriting the rendered output rather than the templates keeps the prefix out
    of ~50 template call sites, where a single missed one is an unreachable page.
    Already-prefixed URLs are left alone, so this stays safe to apply twice (a
    proxy that does its own HTML rewriting may have got there first).
    """
    if not prefix:
        return html

    # Escaped even though _validated_prefix already excludes every character
    # that matters here: this is the sink, and a sink that cannot be broken
    # regardless of what reaches it does not depend on validation staying correct.
    safe = escape(prefix, quote=True)

    def _sub(m: re.Match[str]) -> str:
        rest = html[m.end() - 1 :]
        if rest == safe or rest.startswith((safe + "/", safe + '"', safe + "?")):
            return m.group(0)
        return f"{m.group(1)}{safe}/"

    return _ROOT_ABSOLUTE_ATTR.sub(_sub, html)


def _prefix_location(location: str, prefix: str) -> str:
    """Move a root-relative redirect target onto ``prefix``; idempotent.

    Both sides are checked for a protocol-relative form: a "//evil.example.com"
    prefix would otherwise turn any internal redirect into an off-site one.
    """
    if not prefix or prefix.startswith("//"):
        return location
    if not location.startswith("/") or location.startswith("//"):
        return location
    if location == prefix or location.startswith((prefix + "/", prefix + "?")):
        return location
    return prefix + location


def client_ip(request: Request) -> str:
    """Best-effort real client IP.

    Behind Vercel/Cloudflare the edge populates ``X-Forwarded-For`` and the
    leftmost entry is the original client (proxies append their hops on the
    right). Falls back to ``X-Real-IP``, then the socket peer, and finally the
    literal ``"unknown"`` bucket for header-less clients (so a missing header
    can't create unbounded rate-limit buckets).
    """
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    xrip = request.headers.get("x-real-ip")
    if xrip:
        return xrip.strip()
    return request.client.host if request.client else "unknown"


def is_https(request: Request) -> bool:
    """True when the original request was HTTPS.

    On Vercel, TLS terminates at the edge and the app sees ``http`` plus an
    ``X-Forwarded-Proto: https`` header, so we check both.
    """
    if request.url.scheme == "https":
        return True
    return request.headers.get("x-forwarded-proto", "").split(",")[0].strip() == "https"


_jinja_env = Environment(loader=FileSystemLoader(str(TEMPLATES_DIR)), autoescape=True)


# Weekday / short-date helpers for the routines "Upcoming schedule" timeline.
_SCHED_WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
_SCHED_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def _sched_parts(iso: Any) -> dict[str, str]:
    """Format an ISO date (YYYY-MM-DD) into {'short': 'Jul 24', 'weekday': 'Friday'}."""
    try:
        d = date.fromisoformat(str(iso)[:10])
        return {"short": f"{_SCHED_MONTHS[d.month - 1]} {d.day}", "weekday": _SCHED_WEEKDAYS[d.weekday()]}
    except (ValueError, TypeError):
        return {"short": str(iso or ""), "weekday": ""}


_jinja_env.globals["sched_parts"] = _sched_parts


def _render(template_name: str, **ctx) -> HTMLResponse:
    t = _jinja_env.get_template(template_name)
    ctx.setdefault("auth_enabled", auth_enabled())
    ctx.setdefault("demo_mode", is_demo_mode())
    ctx.setdefault("version", __version__)
    prefix = _url_prefix.get()
    ctx.setdefault("url_prefix", prefix)
    return HTMLResponse(_apply_prefix(t.render(**ctx), prefix))
