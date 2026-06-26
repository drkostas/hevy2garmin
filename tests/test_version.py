"""The reported version must match the source, not stale installed metadata (#189)."""
from __future__ import annotations
import re
from pathlib import Path
import hevy2garmin


def test_version_matches_pyproject():
    pyproject = Path(hevy2garmin.__file__).resolve().parent.parent.parent / "pyproject.toml"
    expected = re.search(r'^version\s*=\s*"([^"]+)"', pyproject.read_text(), re.M).group(1)
    assert hevy2garmin.__version__ == expected
    assert hevy2garmin.__version__ != "0.0.0-dev"
