"""The backfill scan must reach old unsynced workouts deep in the history (#165)."""

from __future__ import annotations

from unittest.mock import MagicMock

from hevy2garmin.server import _scan_for_unsynced


def _fake_hevy(num_pages: int, page_size: int = 10):
    """A Hevy client returning num_pages pages of page_size workouts (w0, w1, ...)."""
    def get_workouts(page: int, page_size: int = 10):
        start = (page - 1) * page_size
        workouts = [{"id": f"w{start + i}", "exercises": []} for i in range(page_size)]
        return {"workouts": workouts, "page_count": num_pages}

    client = MagicMock()
    client.get_workouts.side_effect = get_workouts
    return client, num_pages * page_size


def test_finds_unsynced_deep_in_history():
    # 7 pages (70 workouts), only the one on page 6 is unsynced
    client, total = _fake_hevy(7)
    target = "w55"  # page 6
    unsynced, _ = _scan_for_unsynced(client, lambda wid: wid != target, total, set())
    assert unsynced is not None
    assert unsynced["id"] == target


def test_none_when_all_synced():
    client, total = _fake_hevy(7)
    unsynced, _ = _scan_for_unsynced(client, lambda wid: True, total, set())
    assert unsynced is None


def test_breaks_early_on_first_page():
    client, total = _fake_hevy(7)
    unsynced, _ = _scan_for_unsynced(client, lambda wid: wid != "w0", total, set())
    assert unsynced["id"] == "w0"
    assert client.get_workouts.call_count == 1  # did not page past the match


def test_skips_failed_ids():
    client, total = _fake_hevy(2)
    # w5 is unsynced but quarantined; the next unsynced is w8
    is_synced = lambda wid: wid not in ("w5", "w8")
    unsynced, _ = _scan_for_unsynced(client, is_synced, total, {"w5"})
    assert unsynced["id"] == "w8"


def test_does_not_page_past_last_page():
    client, total = _fake_hevy(3)
    # nothing unsynced; should stop at page_count (3), not loop forever
    _scan_for_unsynced(client, lambda wid: True, total, set())
    assert client.get_workouts.call_count == 3
