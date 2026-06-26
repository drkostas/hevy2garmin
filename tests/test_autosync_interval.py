"""The auto-sync interval dropdown must send the real selected value (#177)."""
from __future__ import annotations
from pathlib import Path

DASH = Path(__file__).resolve().parent.parent / "src" / "hevy2garmin" / "templates" / "dashboard.html"


def _interval_select_block() -> str:
    html = DASH.read_text()
    i = html.index('id="autosync-interval"')
    return html[i:i + 600]


def test_interval_dropdown_uses_explicit_value_not_this():
    block = _interval_select_block()
    # this.value did not resolve in htmx hx-vals, so the POST always sent the
    # default (120). The dropdown must read the element value explicitly.
    assert 'document.getElementById("autosync-interval").value' in block
    assert '"interval": this.value' not in block
