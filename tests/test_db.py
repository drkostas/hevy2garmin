"""Tests for database tracking layer."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from hevy2garmin.db_sqlite import SQLiteDatabase


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
                cur.execute("DELETE FROM sync_log")
                cur.execute("DELETE FROM hr_cache")
            conn.commit()
        return db
    return SQLiteDatabase(tmp_path / "test.db")


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
        import time; time.sleep(1.1)  # ensure different timestamp
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
