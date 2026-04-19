"""Configuration management — load/save settings from ~/.hevy2garmin/config.json."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

logger = logging.getLogger("hevy2garmin")

CONFIG_DIR = Path("~/.hevy2garmin").expanduser()
CONFIG_FILE = CONFIG_DIR / "config.json"

DEFAULT_CONFIG: dict[str, Any] = {
    "hevy_api_key": "",
    "garmin_email": "",
    "garmin_token_dir": "~/.garminconnect",
    "user_profile": {
        "weight_kg": 80.0,
        "birth_year": 1990,
        "sex": "male",
        "vo2max": 45.0,
    },
    "sync": {
        "default_limit": 10,
        "skip_existing": True,
    },
    "auto_sync": {
        "enabled": False,
        "interval_minutes": 120,
    },
    "timing": {
        "working_set_seconds": 40,
        "warmup_set_seconds": 25,
        "rest_between_sets_seconds": 75,
        "rest_between_exercises_seconds": 120,
    },
    "hr_fusion": {
        "enabled": True,
    },
}


def load_config() -> dict[str, Any]:
    """Load config from file, then overlay environment variables.

    Env vars take precedence over config file values:
      HEVY_API_KEY, GARMIN_EMAIL, GARMIN_PASSWORD
    """
    import os

    config = json.loads(json.dumps(DEFAULT_CONFIG))  # deep copy defaults
    if CONFIG_FILE.exists():
        try:
            saved = json.loads(CONFIG_FILE.read_text())
            _deep_merge(config, saved)
        except (json.JSONDecodeError, OSError) as e:
            logger.warning("Could not load config: %s", e)

    # Load credentials + settings from DB in one connection (cloud deployments)
    from hevy2garmin.db import get_database_url
    database_url = get_database_url()
    if database_url:
        try:
            from hevy2garmin.db import get_db
            _db = get_db()
            if hasattr(_db, '_get_conn'):
                with _db._get_conn() as conn:
                    with conn.cursor() as cur:
                        # Credentials
                        cur.execute("SELECT platform, credentials FROM platform_credentials WHERE platform IN ('hevy', 'garmin')")
                        for row in cur.fetchall():
                            creds = row["credentials"] if isinstance(row["credentials"], dict) else json.loads(row["credentials"])
                            if row["platform"] == "hevy" and creds.get("api_key"):
                                config["hevy_api_key"] = creds["api_key"]
                            elif row["platform"] == "garmin":
                                if creds.get("email"):
                                    config["garmin_email"] = creds["email"]
                                if creds.get("password"):
                                    config["garmin_password"] = creds["password"]
                        # App settings
                        cur.execute("SELECT key, value FROM app_cache WHERE key IN ('user_profile', 'timing', 'hr_fusion', 'merge_settings')")
                        for row in cur.fetchall():
                            val = row["value"] if isinstance(row["value"], dict) else json.loads(row["value"])
                            if row["key"] == "merge_settings":
                                # Unpack merge_settings into top-level keys
                                for mk, mv in val.items():
                                    config[mk] = mv
                            elif row["key"] in config and isinstance(config[row["key"]], dict):
                                config[row["key"]].update(val)
                            else:
                                config[row["key"]] = val
        except Exception:
            pass

    # Environment variables fill gaps (DB credentials take precedence since user may
    # have changed them via the setup/settings UI after initial deploy)
    if not config.get("hevy_api_key") and os.environ.get("HEVY_API_KEY"):
        config["hevy_api_key"] = os.environ["HEVY_API_KEY"]
    if not config.get("garmin_email") and os.environ.get("GARMIN_EMAIL"):
        config["garmin_email"] = os.environ["GARMIN_EMAIL"]
    if not config.get("garmin_password") and os.environ.get("GARMIN_PASSWORD"):
        config["garmin_password"] = os.environ["GARMIN_PASSWORD"]

    return config


def save_config(config: dict[str, Any]) -> None:
    """Save config to file. Silently skips on read-only filesystems (Vercel)."""
    try:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        CONFIG_FILE.write_text(json.dumps(config, indent=2))
    except OSError:
        logger.debug("Skipping config file write (read-only filesystem)")


def get(key: str, default: Any = None) -> Any:
    """Get a top-level config value."""
    return load_config().get(key, default)


def is_configured() -> bool:
    """Check if initial setup has been done.

    On Vercel (DATABASE_URL set): requires both API key AND Garmin tokens in DB.
    Locally: just checks for API key (tokens are file-based).
    """
    import os
    config = load_config()
    if not config.get("hevy_api_key"):
        return False
    # On cloud deployments, check that Garmin setup started (either credentials
    # saved from setup form, or tokens from browser-based auth, or hevy key in DB)
    from hevy2garmin.db import get_database_url
    if get_database_url():
        try:
            from hevy2garmin.db import get_db
            _db = get_db()
            if not hasattr(_db, '_get_conn'):
                return True  # SQLite fallback
            with _db._get_conn() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT 1 FROM platform_credentials WHERE platform IN ('garmin', 'garmin_tokens', 'hevy') LIMIT 1"
                    )
                    if cur.fetchone() is None:
                        return False
        except Exception:
            pass
    return True


def _deep_merge(base: dict, override: dict) -> None:
    """Merge override into base recursively (mutates base)."""
    for key, value in override.items():
        if key in base and isinstance(base[key], dict) and isinstance(value, dict):
            _deep_merge(base[key], value)
        else:
            base[key] = value
