"""Demo mode helpers for hevy2garmin."""

import os


def is_demo_mode() -> bool:
    """Return True if the instance is running in demo mode."""
    return os.environ.get("DEMO_MODE", "").lower() in ("1", "true", "yes")
