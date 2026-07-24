"""Shared-password auth for the hevy2garmin dashboard.

When ``H2G_PASSWORD`` (or a pre-hashed ``H2G_PASSWORD_HASH``) is set, all
page/API routes require a valid session cookie. When neither is set, auth is
disabled (backward-compatible with existing local deployments).

Sessions are stateless, signed HMAC cookies (``v2.<ts>.<epoch>.<sig>``). The
``epoch`` is folded into the signature so bumping a server-side counter
("sign out everywhere") invalidates every outstanding cookie without needing a
session store. Legacy ``v1.<ts>.<sig>`` cookies are still accepted until they
expire, so an upgrade never force-logs-out the admin.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import time

SESSION_COOKIE = "h2g_session"
DEFAULT_SESSION_TTL_DAYS = 30


def session_ttl() -> int:
    """Session lifetime in seconds (absolute, measured from login).

    Configurable via ``H2G_SESSION_TTL_DAYS`` (integer days; default 30). An
    invalid or non-positive value falls back to the default.
    """
    raw = os.environ.get("H2G_SESSION_TTL_DAYS")
    if raw:
        try:
            days = int(raw)
            if days > 0:
                return days * 24 * 3600
        except ValueError:
            pass
    return DEFAULT_SESSION_TTL_DAYS * 24 * 3600


def get_password() -> str | None:
    """Return the plaintext shared password, or None if not set."""
    return os.environ.get("H2G_PASSWORD") or None


def _password_hash() -> str | None:
    """Return the pre-hashed (argon2) password, or None if not set."""
    return os.environ.get("H2G_PASSWORD_HASH") or None


def auth_enabled() -> bool:
    """True when a password (plaintext or hashed) is configured."""
    return bool(get_password() or _password_hash())


def _secret() -> bytes:
    """Derive the cookie-signing key.

    Prefers a dedicated ``H2G_SECRET`` (decouples signing from the password, so
    rotating the password no longer invalidates sessions). Falls back to the
    password, then the password hash, so existing deployments keep working and
    their current cookies stay valid.
    """
    seed = os.environ.get("H2G_SECRET") or get_password() or _password_hash()
    if not seed:
        raise RuntimeError("no signing seed: set H2G_PASSWORD, H2G_PASSWORD_HASH, or H2G_SECRET")
    return hashlib.sha256(("h2g-session-" + seed).encode()).digest()


def sign_session(epoch: int = 0) -> str:
    """Create a signed session cookie value: ``v2.<timestamp>.<epoch>.<hmac>``."""
    ts = str(int(time.time()))
    payload = f"v2.{ts}.{int(epoch)}"
    sig = hmac.new(_secret(), payload.encode(), hashlib.sha256).hexdigest()[:32]
    return f"{payload}.{sig}"


def verify_session(cookie: str | None, current_epoch: int = 0) -> bool:
    """Verify a session cookie: valid signature, not expired, current epoch.

    Accepts both ``v2`` (with epoch) and legacy ``v1`` cookies. ``v1`` cookies
    carry no epoch, so they are treated as epoch 0: accepted before any
    "sign out everywhere" bump and revoked by it (same as ``v2``). Returns True
    when auth is disabled (backward-compatible).
    """
    if not auth_enabled():
        return True
    if not cookie:
        return False
    try:
        parts = cookie.split(".")
        if parts[0] == "v2" and len(parts) == 4:
            if int(parts[2]) != int(current_epoch):
                return False
            ts = int(parts[1])
            payload = f"v2.{parts[1]}.{parts[2]}"
            sig = parts[3]
        elif parts[0] == "v1" and len(parts) == 3:
            if int(current_epoch) != 0:  # v1 has an implicit epoch of 0 → any bump revokes it
                return False
            ts = int(parts[1])
            payload = f"v1.{parts[1]}"
            sig = parts[2]
        else:
            return False
        if time.time() - ts > session_ttl():
            return False
        expected = hmac.new(_secret(), payload.encode(), hashlib.sha256).hexdigest()[:32]
        return hmac.compare_digest(sig, expected)
    except (ValueError, TypeError):
        return False


def check_password(candidate: str) -> bool:
    """Verify a candidate against ``H2G_PASSWORD_HASH`` (argon2) or the plaintext
    ``H2G_PASSWORD``. Constant-time in both paths."""
    h = _password_hash()
    if h:
        try:
            import nacl.exceptions
            import nacl.pwhash
        except Exception:  # pragma: no cover - pynacl is a hard dependency
            return False
        try:
            return nacl.pwhash.verify(h.encode(), candidate.encode())
        except nacl.exceptions.InvalidkeyError:
            return False
        except Exception:
            return False
    pw = get_password()
    if not pw:
        return False
    return hmac.compare_digest(candidate.encode(), pw.encode())
