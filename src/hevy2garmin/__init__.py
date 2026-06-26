"""Sync Hevy gym workouts to Garmin Connect."""

import re
from pathlib import Path


def _detect_version() -> str:
    """Resolve the running version.

    Read pyproject.toml from the source tree first. On source deploys (Vercel
    fork + sync) the build can cache the installed package metadata, so
    importlib.metadata returns a stale version (e.g. 0.4.0) even though the code
    is current, which made the footer show the wrong version (#189). pyproject
    always matches the deployed code. Fall back to the installed metadata for
    pip installs, where pyproject is not next to the package.
    """
    pyproject = Path(__file__).resolve().parent.parent.parent / "pyproject.toml"
    try:
        if pyproject.exists():
            match = re.search(r'^version\s*=\s*"([^"]+)"', pyproject.read_text(), re.M)
            if match:
                return match.group(1)
    except Exception:
        pass
    try:
        from importlib.metadata import version
        return version("hevy2garmin")
    except Exception:
        return "0.0.0-dev"


__version__ = _detect_version()
