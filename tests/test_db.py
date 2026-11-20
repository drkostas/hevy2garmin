"""Tests for database tracking layer."""

from __future__ import annotations

import os
from pathlib import Path
from unittest.mock import patch

import pytest

from hevy2garmin.db_sqlite import SQLiteDatabase


class TestSQLiteReadOnlyFilesystem:
    """SQLite must surface an actionable error on read-only/serverless FS (#145).

    Previously the mkdir raised a cryptic FileNotFoundError/OSError that users
    saw as a blank dashboard / 500 on Vercel deploy (u/mache_pachela).
    """

    def test_readonly_mkdir_raises_actionable_error(self, tmp_path: Path) -> None:
        db = SQLiteDatabase(tmp_path / "nope" / "sync.db")
        with (
            patch.object(Path, "mkdir", side_effect=OSError("read-only file system")),
            pytest.raises(RuntimeError, match="read-only filesystem"),
        ):
            db._get_conn()


def _make_db(tmp_path):
    """Create a DB instance appropriate for the current environment."""
    database_url = os.environ.get("DATABASE_URL")
    if database_url:
        from hevy2garmin.db_postgres import PostgresDatabase

        db = PostgresDatabase(database_url)
        # Clean tables for test isolation
        with db._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM synced_workouts")
                cur.execute("DELETE FROM pending_uploads")
                cur.execute("DELETE FROM sync_log")
                cur.execute("DELETE FROM hr_cache")
                cur.execute("DELETE FROM synced_routines")
                cur.execute("DELETE FROM routine_schedules")
            conn.commit()
        return db
    return SQLiteDatabase(tmp_path / "test.db")


class TestRoutineTracking:
    def test_not_synced_initially(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        assert db.is_routine_synced("r-unknown") is False
        assert db.get_synced_routine("r-unknown") is None

    def test_mark_then_check(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        db.mark_routine_synced(
            "r1", garmin_workout_id="w9", title="Push", hevy_updated_at="2026-01-01T00:00:00Z"
        )
        assert db.is_routine_synced("r1") is True
        record = db.get_synced_routine("r1")
        assert record["garmin_workout_id"] == "w9"
        assert record["title"] == "Push"

    def test_stale_when_edited_since(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        db.mark_routine_synced("r1", hevy_updated_at="2026-01-01T00:00:00Z")
        # Edited later on Hevy → treated as not synced (will be recreated).
        assert db.is_routine_synced("r1", "2026-02-01T00:00:00Z") is False
        # Unchanged timestamp → still synced.
        assert db.is_routine_synced("r1", "2026-01-01T00:00:00Z") is True

    def test_upsert_updates_record(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        db.mark_routine_synced("r1", garmin_workout_id="w1", title="Old")
        db.mark_routine_synced("r1", garmin_workout_id="w2", title="New")
        assert db.get_synced_routine("r1")["garmin_workout_id"] == "w2"

    def test_delete(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        db.mark_routine_synced("r1", garmin_workout_id="w1")
        assert db.delete_synced_routine("r1") is True
        assert db.is_routine_synced("r1") is False
        assert db.delete_synced_routine("r1") is False

    def test_set_routine_status_only_touches_status(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        db.mark_routine_synced("r1", garmin_workout_id="w1", title="Push", content_hash="h1")
        db.set_routine_status("r1", "missing_on_garmin")
        record = db.get_synced_routine("r1")
        assert record["status"] == "missing_on_garmin"
        assert record["garmin_workout_id"] == "w1"
        assert record["content_hash"] == "h1"
        # Unknown id is a silent no-op.
        db.set_routine_status("r-unknown", "missing_on_garmin")
        assert db.get_synced_routine("r-unknown") is None

    def test_list_synced_routines(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        assert db.list_synced_routines() == []
        db.mark_routine_synced("r1", garmin_workout_id="w1", title="Push")
        db.mark_routine_synced(
            "r2", garmin_workout_id="w2", title="Pull", status="schedule_pending"
        )
        rows = {r["hevy_routine_id"]: r for r in db.list_synced_routines()}
        assert set(rows) == {"r1", "r2"}
        assert rows["r1"]["garmin_workout_id"] == "w1"
        assert rows["r1"]["status"] == "success"
        assert rows["r2"]["status"] == "schedule_pending"

    def test_routine_schedule_round_trip(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        db.add_routine_schedule("r1", "111", "2026-07-20")
        db.add_routine_schedule("r1", "222", "2026-07-27")
        assert set(db.get_routine_schedule_ids("r1")) == {"111", "222"}
        # Re-adding the same id is a no-op (idempotent), not a duplicate/error.
        db.add_routine_schedule("r1", "111", "2026-07-20")
        assert set(db.get_routine_schedule_ids("r1")) == {"111", "222"}
        db.clear_routine_schedules("r1")
        assert db.get_routine_schedule_ids("r1") == []

    def test_delete_synced_routine_clears_schedules(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        db.mark_routine_synced("r1", garmin_workout_id="w1")
        db.add_routine_schedule("r1", "111", "2026-07-20")
        assert db.delete_synced_routine("r1") is True
        # Removing the routine also drops its tracked calendar entries.
        assert db.get_routine_schedule_ids("r1") == []

    def test_upcoming_schedules_filters_orders_and_paginates(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        db.mark_routine_synced("r1", garmin_workout_id="w1", title="Push")
        db.mark_routine_synced("r2", garmin_workout_id="w2", title="Pull")
        db.add_routine_schedule("r1", "s-past", "2026-06-01")  # past → excluded
        db.add_routine_schedule("r1", "s-b", "2026-07-27")
        db.add_routine_schedule("r2", "s-a", "2026-07-20")
        today = "2026-07-15"
        # Only future entries are counted, and the title comes from the join.
        assert db.count_upcoming_routine_schedules(today) == 2
        page1 = db.get_upcoming_routine_schedules(today, 1, 0)
        assert [(r["scheduled_date"], r["title"]) for r in page1] == [("2026-07-20", "Pull")]
        page2 = db.get_upcoming_routine_schedules(today, 1, 1)
        assert [(r["scheduled_date"], r["title"]) for r in page2] == [("2026-07-27", "Push")]
        assert page2[0]["schedule_id"] == "s-b" and page2[0]["hevy_routine_id"] == "r1"

    def test_upcoming_schedules_title_filter(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        db.mark_routine_synced("r1", garmin_workout_id="w1", title="Push Day")
        db.mark_routine_synced("r2", garmin_workout_id="w2", title="Leg Day")
        db.add_routine_schedule("r1", "s1", "2999-01-05")
        db.add_routine_schedule("r2", "s2", "2999-01-06")
        today = "2026-07-15"
        # Case-insensitive substring match on the routine title.
        assert db.count_upcoming_routine_schedules(today, "push") == 1
        rows = db.get_upcoming_routine_schedules(today, 10, 0, "PUSH")
        assert [r["title"] for r in rows] == ["Push Day"]
        # A non-matching query returns nothing; no query returns everything.
        assert db.count_upcoming_routine_schedules(today, "cardio") == 0
        assert db.count_upcoming_routine_schedules(today) == 2

    def test_get_routine_scheduled_dates(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        db.add_routine_schedule("r1", "s2", "2026-08-10")
        db.add_routine_schedule("r1", "s1", "2026-08-03")
        db.add_routine_schedule("r1", "s3", "2026-08-03")  # duplicate date
        db.add_routine_schedule("r2", "s9", "2026-09-01")  # other routine
        # Distinct dates for the routine, ascending.
        assert db.get_routine_scheduled_dates("r1") == ["2026-08-03", "2026-08-10"]
        assert db.get_routine_scheduled_dates("r2") == ["2026-09-01"]
        assert db.get_routine_scheduled_dates("nope") == []

    def test_delete_routine_schedule_one_entry(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        db.add_routine_schedule("r1", "111", "2026-07-20")
        db.add_routine_schedule("r1", "222", "2026-07-27")
        assert db.delete_routine_schedule("r1", "111") is True
        assert db.get_routine_schedule_ids("r1") == ["222"]
        # Deleting a non-existent entry reports no removal.
        assert db.delete_routine_schedule("r1", "999") is False

    def test_content_hash_round_trip(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        db.mark_routine_synced("r1", garmin_workout_id="w1", content_hash="abc123")
        assert db.get_synced_routine("r1")["content_hash"] == "abc123"
        # Upsert updates the hash.
        db.mark_routine_synced("r1", garmin_workout_id="w1", content_hash="def456")
        assert db.get_synced_routine("r1")["content_hash"] == "def456"

    def test_routine_stats_empty(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        assert db.get_routine_stats() == {"synced": 0, "scheduled": 0}

    def test_routine_stats_counts_synced_and_scheduled(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        db.mark_routine_synced("r1", garmin_workout_id="w1", title="Push")
        db.mark_routine_synced(
            "r2", garmin_workout_id="w2", title="Pull", scheduled_date="2026-07-20"
        )
        db.mark_routine_synced(
            "r3", garmin_workout_id="w3", title="Legs", scheduled_date="2026-07-21"
        )
        assert db.get_routine_stats() == {"synced": 3, "scheduled": 2}

    def test_recent_synced_routines_fields_and_limit(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        for i in range(7):
            db.mark_routine_synced(f"r{i}", garmin_workout_id=f"w{i}", title=f"Routine {i}")
        recent = db.get_recent_synced_routines(5)
        assert len(recent) == 5
        sample = recent[0]
        assert set(sample) >= {
            "hevy_routine_id",
            "title",
            "scheduled_date",
            "garmin_workout_id",
            "synced_at",
        }

    def test_recent_synced_routines_empty(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        assert db.get_recent_synced_routines(5) == []


class TestSyncTracking:
    def test_not_synced_initially(self, tmp_path: Path) -> None:
        db = SQLiteDatabase(tmp_path / "test.db")
        assert db.is_synced("unknown-id") is False

    def test_mark_then_check(self, tmp_path: Path) -> None:
        db = SQLiteDatabase(tmp_path / "test.db")
        db.mark_synced("w1", garmin_activity_id="123", title="Push")
        assert db.is_synced("w1") is True

    def test_count(self, tmp_path: Path) -> None:
        db = SQLiteDatabase(tmp_path / "test.db")
        assert db.get_synced_count() == 0
        db.mark_synced("w1", title="Push")
        db.mark_synced("w2", title="Pull")
        assert db.get_synced_count() == 2

    def test_recent_ordering(self, tmp_path: Path) -> None:
        db = SQLiteDatabase(tmp_path / "test.db")
        db.mark_synced("w1", title="First")
        import time

        time.sleep(1.1)  # ensure different timestamp
        db.mark_synced("w2", title="Second")
        recent = db.get_recent_synced(limit=2)
        assert len(recent) == 2
        assert recent[0]["title"] == "Second"  # most recent first

    def test_idempotent_mark(self, tmp_path: Path) -> None:
        db = SQLiteDatabase(tmp_path / "test.db")
        db.mark_synced("w1", garmin_activity_id="100", title="Push")
        db.mark_synced("w1", garmin_activity_id="200", title="Push Updated")
        assert db.get_synced_count() == 1
        recent = db.get_recent_synced(limit=1)
        assert recent[0]["garmin_activity_id"] == "200"

    def test_db_auto_creates(self, tmp_path: Path) -> None:
        db_path = tmp_path / "nested" / "dir" / "sync.db"
        db = SQLiteDatabase(db_path)
        db.mark_synced("w1", title="Test")
        assert db_path.exists()

    def test_stores_calories_and_hr(self, tmp_path: Path) -> None:
        db = SQLiteDatabase(tmp_path / "test.db")
        db.mark_synced("w1", title="Push", calories=250, avg_hr=95)
        recent = db.get_recent_synced(limit=1)
        assert recent[0]["calories"] == 250
        assert recent[0]["avg_hr"] == 95

    def test_unsync_single(self, tmp_path: Path) -> None:
        db = SQLiteDatabase(tmp_path / "test.db")
        db.mark_synced("w1", garmin_activity_id="100", title="Push")
        db.mark_synced("w2", garmin_activity_id="200", title="Pull")
        assert db.get_synced_count() == 2
        assert db.unsync("w1") is True
        assert db.get_synced_count() == 1
        assert db.is_synced("w1") is False
        assert db.is_synced("w2") is True

    def test_unsync_nonexistent(self, tmp_path: Path) -> None:
        db = SQLiteDatabase(tmp_path / "test.db")
        assert db.unsync("nonexistent") is False

    def test_unsync_all(self, tmp_path: Path) -> None:
        db = SQLiteDatabase(tmp_path / "test.db")
        db.mark_synced("w1", title="Push")
        db.mark_synced("w2", title="Pull")
        db.mark_synced("w3", title="Legs")
        count = db.unsync_all()
        assert count == 3
        assert db.get_synced_count() == 0

    def test_app_config_roundtrip(self, tmp_path: Path) -> None:
        db = SQLiteDatabase(tmp_path / "test.db")
        assert db.get_app_config("missing") is None
        db.set_app_config("settings", {"theme": "dark", "n": 42})
        assert db.get_app_config("settings") == {"theme": "dark", "n": 42}
        # Overwrite
        db.set_app_config("settings", {"theme": "light"})
        assert db.get_app_config("settings") == {"theme": "light"}

    def test_app_config_caches_workout_pages(self, tmp_path: Path) -> None:
        """The workouts-page cache key pattern used by the server."""
        db = SQLiteDatabase(tmp_path / "test.db")
        page_data = {"workouts": [{"id": "a"}, {"id": "b"}], "page_count": 3}
        db.set_app_config("hevy_workouts_page_1", page_data)
        got = db.get_app_config("hevy_workouts_page_1")
        assert got["page_count"] == 3
        assert len(got["workouts"]) == 2
        assert got["workouts"][0]["id"] == "a"


@pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set")
class TestPostgresBackend:
    """Same tests as TestSyncTracking but against Postgres."""

    def test_not_synced_initially(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        assert db.is_synced("pg-unknown") is False

    def test_mark_then_check(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        db.mark_synced("pg-w1", garmin_activity_id="123", title="Push")
        assert db.is_synced("pg-w1") is True

    def test_count(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        assert db.get_synced_count() == 0
        db.mark_synced("pg-w1", title="Push")
        db.mark_synced("pg-w2", title="Pull")
        assert db.get_synced_count() == 2

    def test_idempotent_mark(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        db.mark_synced("pg-w1", garmin_activity_id="100", title="Push")
        db.mark_synced("pg-w1", garmin_activity_id="200", title="Push Updated")
        assert db.get_synced_count() == 1

    def test_stores_calories_and_hr(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        db.mark_synced("pg-w1", title="Push", calories=250, avg_hr=95)
        recent = db.get_recent_synced(limit=1)
        assert recent[0]["calories"] == 250
        assert recent[0]["avg_hr"] == 95

    def test_sync_log(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        db.record_sync_log(synced=5, skipped=2, failed=0, trigger="test")
        log = db.get_sync_log(limit=1)
        assert len(log) == 1
        assert log[0]["synced"] == 5

    def test_hr_cache(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        data = {"hr_samples": [{"time": 0, "hr": 85}]}
        db.cache_hr("pg-w1", data)
        cached = db.get_cached_hr("pg-w1")
        assert cached["hr_samples"][0]["hr"] == 85


class TestDispatcher:
    def test_default_is_sqlite(self, monkeypatch, tmp_path: Path) -> None:
        """Without DATABASE_URL, get_db() returns SQLiteDatabase."""
        monkeypatch.delenv("DATABASE_URL", raising=False)
        from hevy2garmin import db

        db.reset()
        instance = db.get_db()
        assert isinstance(instance, SQLiteDatabase)
        db.reset()

    def test_reset_clears_singleton(self, monkeypatch) -> None:
        """reset() forces a fresh instance on next get_db()."""
        monkeypatch.delenv("DATABASE_URL", raising=False)
        from hevy2garmin import db

        db.reset()
        first = db.get_db()
        db.reset()
        second = db.get_db()
        assert first is not second
        db.reset()

    def test_module_wrappers_accept_db_path_kwarg(self, monkeypatch, tmp_path: Path) -> None:
        """Module-level functions silently accept db_path= for backwards compat."""
        monkeypatch.delenv("DATABASE_URL", raising=False)
        from hevy2garmin import db

        db.reset()
        # Patch the singleton to use tmp_path
        db._instance = SQLiteDatabase(tmp_path / "test.db")
        # These should not raise even with db_path= passed
        db.mark_synced("w1", title="Compat", db_path=tmp_path / "ignored.db")
        assert db.is_synced("w1", db_path=tmp_path / "ignored.db") is True
        assert db.get_synced_count(db_path=tmp_path / "ignored.db") == 1
        db.reset()


class TestKnownGarminActivityIds:
    """Ledger lookup that stops back-to-back workouts from colliding (#796)."""

    def test_returns_every_synced_activity_id(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        db.mark_synced("A", garmin_activity_id="111")
        db.mark_synced("B", garmin_activity_id="222")
        assert db.known_garmin_activity_ids() == {"111", "222"}

    def test_excludes_the_given_hevy_id(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        db.mark_synced("A", garmin_activity_id="111")
        db.mark_synced("B", garmin_activity_id="222")
        # Syncing B must see A's activity but never its own.
        assert db.known_garmin_activity_ids(exclude_hevy_id="B") == {"111"}

    def test_ignores_rows_without_an_activity_id(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        db.mark_synced("A", garmin_activity_id="111")
        db.mark_synced("C", title="no id yet")  # merged/failed row, no garmin id
        assert db.known_garmin_activity_ids() == {"111"}

    def test_includes_in_flight_pending_uploads(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        db.claim_pending("A", {"title": "Fusion 15"})
        db.update_pending("A", garmin_activity_id="333")
        assert "333" in db.known_garmin_activity_ids()
        assert db.known_garmin_activity_ids(exclude_hevy_id="A") == set()

    def test_empty_when_nothing_synced(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        assert db.known_garmin_activity_ids() == set()
