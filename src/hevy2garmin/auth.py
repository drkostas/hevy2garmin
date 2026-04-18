"""Simple shared-password auth for the hevy2garmin dashboard.

When H2G_PASSWORD is set, all page/API routes require a valid session cookie.
When unset, auth is disabled (backward-compatible with existing deployments).
"""

import hashlib
import hmac
import os
import time

SESSION_COOKIE = "h2g_session"
SESSION_TTL = 30 * 24 * 3600  # 30 days


def get_password() -> str | None:
    """Return the shared password, or None if auth is disabled."""
    return os.environ.get("H2G_PASSWORD") or None


def auth_enabled() -> bool:
    """True when H2G_PASSWORD is set (non-empty)."""
    return bool(get_password())


def _secret() -> bytes:
    """Derive a signing key from the password itself (no separate secret needed)."""
    pw = get_password()
    if not pw:
        raise RuntimeError("H2G_PASSWORD not set")
    return hashlib.sha256(f"h2g-session-{pw}".encode()).digest()


def sign_session() -> str:
    """Create a signed session cookie value: 'v1.<timestamp>.<hmac>'."""
    ts = str(int(time.time()))
    sig = hmac.new(_secret(), f"v1.{ts}".encode(), hashlib.sha256).hexdigest()[:32]
    return f"v1.{ts}.{sig}"


def verify_session(cookie: str | None) -> bool:
    """Verify a session cookie is valid and not expired."""
    if not cookie or not auth_enabled():
        return not auth_enabled()
    try:
        parts = cookie.split(".")
        if len(parts) != 3 or parts[0] != "v1":
            return False
        ts = int(parts[1])
        if time.time() - ts > SESSION_TTL:
            return False
        expected = hmac.new(_secret(), f"v1.{parts[1]}".encode(), hashlib.sha256).hexdigest()[:32]
        return hmac.compare_digest(parts[2], expected)
    except (ValueError, TypeError):
        return False


def check_password(candidate: str) -> bool:
    """Constant-time comparison of candidate against H2G_PASSWORD."""
    pw = get_password()
    if not pw:
        return False
    return hmac.compare_digest(candidate.encode(), pw.encode())
