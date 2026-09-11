#!/usr/bin/env python3
"""Does the Hevy public API spec expose workout photos yet? (hevy2garmin#237, #524)

Fetches the OpenAPI document and lists every property name that looks like media. Exit 0 and
print "none" when there is nothing; exit 0 and print the names when there is; exit 2 when the
spec cannot be fetched or parsed, so a moved document shows up as a failed run rather than as
silence.

    python3 scripts/hevy_spec_media_check.py                 # live spec
    python3 scripts/hevy_spec_media_check.py path/to.json    # a saved spec, for tests
"""
from __future__ import annotations

import json
import re
import sys
import urllib.request

SPEC_URL = "https://api.hevyapp.com/docs.json"
MEDIA = re.compile(r"^[a-z_]*(image|photo|media|picture|attachment)[a-z_]*$", re.I)


def load(source: str | None) -> dict:
    if source:
        with open(source, encoding="utf-8") as f:
            return json.load(f)
    req = urllib.request.Request(SPEC_URL, headers={"User-Agent": "hevy2garmin-spec-watch/1"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def media_keys(node, path: str = "", found: set[str] | None = None) -> set[str]:
    """Every object key under the document whose name looks like media, with its JSON path."""
    if found is None:
        found = set()
    if isinstance(node, dict):
        for k, v in node.items():
            if MEDIA.match(k):
                found.add(f"{path}/{k}")
            media_keys(v, f"{path}/{k}", found)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            media_keys(v, f"{path}[{i}]", found)
    return found


def main() -> int:
    try:
        spec = load(sys.argv[1] if len(sys.argv) > 1 else None)
    except Exception as e:  # noqa: BLE001 - the whole point is to report any failure
        print(f"spec unavailable: {e}", file=sys.stderr)
        return 2
    keys = sorted(media_keys(spec))
    title = spec.get("info", {}).get("title", "?")
    print(f"spec: {title} {spec.get('openapi', '?')} paths={len(spec.get('paths', {}))}")
    print("none" if not keys else "\n".join(keys))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
