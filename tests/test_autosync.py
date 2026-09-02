"""Tests for the auto-sync loop and the shared sync lock.

The loop lives in ``hevy2garmin.autosync`` and the lock in
``hevy2garmin.syncstate``; the workflow-YAML helpers are still in
``hevy2garmin.server``. State is always reached through the module
(``syncstate.acquire_sync_lock()``, never a bare imported name) so patches in
one place are visible everywhere.
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pytest

from hevy2garmin import autosync, server, syncstate
from hevy2garmin.server import (
    _build_sync_workflow_yaml,
    _format_interval_label,
    _minutes_to_cron,
)


class TestMinutesToCron:
    @pytest.mark.parametrize(
        "minutes,expected",
        [
            (30, "*/30 * * * *"),
            (60, "0 * * * *"),
            (120, "0 */2 * * *"),
            (240, "0 */4 * * *"),
            (360, "0 */6 * * *"),
            (720, "0 */12 * * *"),
            (1440, "0 0 * * *"),
        ],
    )
    def test_supported_intervals(self, minutes: int, expected: str) -> None:
        assert _minutes_to_cron(minutes) == expected

    def test_fallback_for_unexpected_value(self) -> None:
        # Anything not on the supported list falls back to every-2-hours
        assert _minutes_to_cron(45) == "0 */2 * * *"
        assert _minutes_to_cron(0) == "0 */2 * * *"


class TestFormatIntervalLabel:
    @pytest.mark.parametrize(
        "minutes,expected",
        [
            (30, "30 minutes"),
            (60, "1 hour"),
            (120, "2 hours"),
            (240, "4 hours"),
            (1440, "24 hours"),
        ],
    )
    def test_label(self, minutes: int, expected: str) -> None:
        assert _format_interval_label(minutes) == expected


class TestBuildSyncWorkflowYaml:
    def test_cron_reflects_interval(self) -> None:
        yml = _build_sync_workflow_yaml(30)
        assert "cron: '*/30 * * * *'" in yml

    def test_default_2h(self) -> None:
        yml = _build_sync_workflow_yaml(120)
        assert "cron: '0 */2 * * *'" in yml

    def test_24h(self) -> None:
        yml = _build_sync_workflow_yaml(1440)
        assert "cron: '0 0 * * *'" in yml

class TestSyncLock:
    def test_acquire_and_release(self) -> None:
        """Lock can be acquired and released without crashing (verifies time module is imported)."""
        assert syncstate.acquire_sync_lock() is True
        syncstate.release_sync_lock()

    def test_acquire_blocks_second(self) -> None:
        """Second acquire returns False when lock is held."""
        assert syncstate.acquire_sync_lock() is True
        assert syncstate.acquire_sync_lock() is False  # Already held
        syncstate.release_sync_lock()


class TestCronGraceDeferral:
    def test_all_fresh_workouts_are_deferred_without_calling_sync_helper(self) -> None:
        """Cron returns a useful response when every candidate is in grace."""
        workout = {"id": "fresh-1", "title": "Fresh", "exercises": []}
        hevy = MagicMock()
        hevy.get_workout_count.return_value = 1
        database = MagicMock()

        with (
            patch.object(
                server,
                "load_config",
                return_value={
                    "hevy_api_key": "test-key",
                    "sync": {"grace_period_minutes": 120},
                },
            ),
            patch("hevy2garmin.hevy.HevyClient", return_value=hevy),
            patch.object(server.db, "get_db", return_value=database),
            patch.object(server.db, "get_synced_count", return_value=0),
            patch.object(
                server,
                "_scan_for_unsynced",
                side_effect=[(workout, {}), (None, {})],
            ),
            patch("hevy2garmin.sync._workout_within_grace", return_value=True),
            patch("hevy2garmin.sync.sync_one_workout") as sync_one,
        ):
            response = asyncio.run(server._do_sync_one(respect_grace=True))

        assert json.loads(response.body) == {
            "synced": 0,
            "deferred": 1,
            "remaining": 1,
            "done": False,
        }
        sync_one.assert_not_called()


class TestBuildSyncWorkflowYaml:
    def test_workflow_structure_intact(self) -> None:
        """Make sure essential workflow pieces survive any cron change."""
        yml = _build_sync_workflow_yaml(60)
        assert "name: Sync Workouts" in yml
        assert "workflow_dispatch:" in yml
        assert "repository_dispatch:" in yml
        assert "DATABASE_URL: ${{ secrets.DATABASE_URL }}" in yml
        assert "hevy2garmin sync" in yml

    def test_actions_run_on_node_24(self) -> None:
        """Pin the generated workflow to Node-24 action majors so it doesn't
        regress to the deprecated Node-20 versions (checkout@v4, setup-python@v5)."""
        yml = _build_sync_workflow_yaml(120)
        assert "actions/checkout@v5" in yml
        assert "actions/setup-python@v6" in yml
        assert "actions/checkout@v4" not in yml
        assert "actions/setup-python@v5" not in yml


class TestLifespanAutosync:
    """The startup/shutdown hook lives in the app's lifespan (FastAPI dropped
    on_event), so it only fires when TestClient is used as a context manager."""

    def _run(self, config: dict) -> tuple[list[int], list[int]]:
        from fastapi.testclient import TestClient

        scheduled: list[int] = []
        stopped: list[int] = []
        with patch.object(server, "load_config", lambda: config), \
             patch.object(autosync, "schedule", scheduled.append), \
             patch.object(autosync, "stop", lambda: stopped.append(1)):
            with TestClient(server.app):
                pass
        return scheduled, stopped

    def test_enabled_schedules_configured_interval(self) -> None:
        scheduled, _ = self._run({"auto_sync": {"enabled": True, "interval_minutes": 45}})
        assert scheduled == [45]

    def test_enabled_without_interval_defaults_to_30(self) -> None:
        scheduled, _ = self._run({"auto_sync": {"enabled": True}})
        assert scheduled == [30]

    def test_disabled_schedules_nothing(self) -> None:
        scheduled, _ = self._run({"auto_sync": {"enabled": False}})
        assert scheduled == []

    def test_missing_config_schedules_nothing(self) -> None:
        scheduled, _ = self._run({})
        assert scheduled == []

    def test_shutdown_cancels_timer(self) -> None:
        """A surviving timer could fire a sync against a torn-down process."""
        _, stopped = self._run({"auto_sync": {"enabled": True, "interval_minutes": 60}})
        assert stopped == [1]

    def test_shutdown_cancels_even_when_autosync_disabled(self) -> None:
        _, stopped = self._run({"auto_sync": {"enabled": False}})
        assert stopped == [1]


class TestAutosyncLoop:
    """The loop is an asyncio task (it used to be a chain of threading.Timers),
    so sleeping, rescheduling and stopping are all driven from the event loop."""

    @staticmethod
    def _run_loop(returns: list[int | None], sleeps: list[float]) -> None:
        """Drive autosync._loop with instant sleeps and canned sync results."""
        pending = list(returns)

        async def fake_sleep(seconds):
            sleeps.append(seconds)

        async def fake_threadpool(fn):
            return pending.pop(0)

        with patch.object(autosync.asyncio, "sleep", fake_sleep), \
             patch.object(autosync, "run_in_threadpool", fake_threadpool):
            asyncio.run(autosync._loop(30))

    def test_sleeps_the_interval_before_first_sync(self) -> None:
        sleeps: list[float] = []
        self._run_loop([None], sleeps)
        assert sleeps == [30 * 60]

    def test_stops_when_sync_returns_none(self) -> None:
        """None means auto-sync was disabled or the Hevy key is invalid."""
        sleeps: list[float] = []
        self._run_loop([None], sleeps)
        assert len(sleeps) == 1  # did not loop again

    def test_keeps_looping_while_sync_returns_an_interval(self) -> None:
        sleeps: list[float] = []
        self._run_loop([30, 30, None], sleeps)
        assert sleeps == [1800, 1800, 1800]

    def test_picks_up_a_changed_interval(self) -> None:
        """A new interval from the config applies to the next sleep."""
        sleeps: list[float] = []
        self._run_loop([120, None], sleeps)
        assert sleeps == [30 * 60, 120 * 60]

    def test_cancellation_stops_the_loop(self) -> None:
        async def scenario():
            task = asyncio.create_task(autosync._loop(60))
            await asyncio.sleep(0)  # let it reach the first await
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task

        asyncio.run(scenario())


def _really_acquire() -> bool:
    """Stand in for syncstate.acquire_sync_lock but take the real lock, so the
    ``finally: release()`` under test has something to release."""
    return syncstate._sync_executing.acquire(blocking=False)


class TestRunAutosyncOnce:
    """autosync.run_once returns the next interval, or None to stop the loop."""

    def test_returns_none_when_disabled(self) -> None:
        with patch.object(autosync, "load_config", lambda: {"auto_sync": {"enabled": False}}):
            assert autosync.run_once() is None

    def test_returns_none_when_config_missing(self) -> None:
        with patch.object(autosync, "load_config", lambda: {}):
            assert autosync.run_once() is None

    def test_returns_interval_without_syncing_when_lock_held(self) -> None:
        """A sync already in flight must not be joined, but the loop continues."""
        cfg = {"auto_sync": {"enabled": True, "interval_minutes": 45}}
        called = []
        with patch.object(autosync, "load_config", lambda: cfg), \
             patch.object(syncstate, "acquire_sync_lock", lambda: False), \
             patch.object(autosync, "sync", lambda **kw: called.append(kw)):
            assert autosync.run_once() == 45
        assert called == []

    def test_returns_interval_after_a_successful_sync(self) -> None:
        cfg = {"auto_sync": {"enabled": True, "interval_minutes": 90}}
        result = {"synced": 2, "skipped": 0, "failed": 0}
        with patch.object(autosync, "load_config", lambda: cfg), \
             patch.object(syncstate, "acquire_sync_lock", _really_acquire), \
             patch.object(autosync, "sync", lambda **kw: result), \
             patch.object(syncstate, "record_sync_log", lambda *a, **k: None):
            assert autosync.run_once() == 90
        # the lock must be free again for the next run
        assert syncstate._sync_executing.acquire(blocking=False)
        syncstate.release_sync_lock()

    def test_releases_lock_when_sync_raises(self) -> None:
        cfg = {"auto_sync": {"enabled": True, "interval_minutes": 30}}

        def boom(**kw):
            raise RuntimeError("hevy down")

        with patch.object(autosync, "load_config", lambda: cfg), \
             patch.object(syncstate, "acquire_sync_lock", _really_acquire), \
             patch.object(autosync, "sync", boom), \
             patch.object(syncstate, "record_sync_log", lambda *a, **k: None):
            assert autosync.run_once() == 30
        assert syncstate._sync_executing.acquire(blocking=False)
        syncstate.release_sync_lock()

    def test_stops_loop_when_hevy_key_is_invalid(self) -> None:
        """A bad key would fail every cycle, so the loop must stop, not spin."""
        from hevy2garmin.hevy import HevyAuthError

        cfg = {"auto_sync": {"enabled": True, "interval_minutes": 30}}
        saved: list[dict] = []

        def boom(**kw):
            raise HevyAuthError("401")

        with patch.object(autosync, "load_config", lambda: cfg), \
             patch.object(syncstate, "acquire_sync_lock", _really_acquire), \
             patch.object(autosync, "sync", boom), \
             patch.object(autosync, "save_config", saved.append), \
             patch.object(autosync.db, "get_database_url", lambda: None), \
             patch.object(syncstate, "record_sync_log", lambda *a, **k: None):
            assert autosync.run_once() is None
        assert saved and saved[0]["auto_sync"]["enabled"] is False


class TestScheduleAndStop:
    """schedule()/stop() own the task handle.

    Covered because the lifespan tests patch both out, and the loop test
    cancels its own task — so nothing here exercised the real cancel path.
    """

    def test_stop_cancels_the_running_task(self) -> None:
        async def scenario():
            autosync.schedule(60)
            task = autosync._autosync_task
            assert task is not None
            await asyncio.sleep(0)  # let it reach the first await

            autosync.stop()
            assert autosync._autosync_task is None
            # Checked via task.cancelled() rather than `await task`: a stop()
            # that fails to cancel would leave the await blocked on the loop's
            # hour-long sleep, so the test would hang instead of failing.
            await asyncio.sleep(0)
            assert task.cancelled()

        asyncio.run(scenario())

    def test_stop_is_a_no_op_without_a_task(self) -> None:
        autosync.stop()  # must not raise
        autosync.stop()
        assert autosync._autosync_task is None

    def test_schedule_replaces_the_previous_task(self) -> None:
        """A second schedule() must not leave two loops syncing in parallel."""

        async def scenario():
            autosync.schedule(60)
            first = autosync._autosync_task
            await asyncio.sleep(0)

            autosync.schedule(30)
            second = autosync._autosync_task
            assert second is not first
            await asyncio.sleep(0)
            assert first.cancelled()

            autosync.stop()
            await asyncio.sleep(0)
            assert second.cancelled()

        asyncio.run(scenario())


class TestLastSyncTime:
    """mark_synced()/get_last_sync_time() replaced a bare module global."""

    def test_mark_synced_is_readable_back(self) -> None:
        # Patched so the stamp is restored afterwards: _last_sync_time is
        # process-wide, and leaking a value here makes every later dashboard
        # render in the session report "just now".
        with patch.object(syncstate, "_last_sync_time", None):
            before = datetime.now(timezone.utc)
            syncstate.mark_synced()
            stamped = syncstate.get_last_sync_time()
            assert stamped is not None
            assert before <= stamped <= datetime.now(timezone.utc)

    def test_starts_empty(self) -> None:
        with patch.object(syncstate, "_last_sync_time", None):
            assert syncstate.get_last_sync_time() is None


class TestAutosyncStatus:
    """status() renders the last/next sync labels the dashboard shows."""

    @staticmethod
    def _status(last_sync, *, enabled=True, interval=30) -> dict:
        cfg = {"auto_sync": {"enabled": enabled, "interval_minutes": interval}}
        with patch.object(autosync, "load_config", lambda: cfg), \
             patch.object(autosync.db, "get_database_url", lambda: None), \
             patch.object(syncstate, "_last_sync_time", last_sync):
            return autosync.status()

    def test_no_sync_yet_reports_no_times(self) -> None:
        st = self._status(None)
        assert st["last_sync"] is None
        assert st["next_sync"] is None
        assert st["enabled"] is True
        assert st["interval_minutes"] == 30

    def test_a_sync_seconds_ago_reads_just_now(self) -> None:
        st = self._status(datetime.now(timezone.utc))
        assert st["last_sync"] == "just now"

    def test_minutes_are_reported_in_minutes(self) -> None:
        st = self._status(datetime.now(timezone.utc) - timedelta(minutes=5))
        assert st["last_sync"] == "5 min ago"
        assert st["next_sync"] == "in 25 min"

    def test_over_an_hour_is_reported_in_hours_and_minutes(self) -> None:
        st = self._status(datetime.now(timezone.utc) - timedelta(minutes=90), interval=240)
        assert st["last_sync"] == "1h 30m ago"
        assert st["next_sync"] == "in 2h 30m"

    def test_an_overdue_sync_is_soon(self) -> None:
        st = self._status(datetime.now(timezone.utc) - timedelta(minutes=90), interval=30)
        assert st["next_sync"] == "soon"

    def test_next_sync_is_blank_while_disabled(self) -> None:
        st = self._status(datetime.now(timezone.utc) - timedelta(minutes=5), enabled=False)
        assert st["last_sync"] == "5 min ago"
        assert st["next_sync"] is None
