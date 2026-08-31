"""Tests for sync orchestrator."""

from __future__ import annotations

from datetime import datetime, timezone, timedelta
from unittest.mock import MagicMock, patch

import pytest

from hevy2garmin.merge import MergeResult
from hevy2garmin.sync import fetch_workouts, sync, sync_one_workout


def _iso(dt):
    return dt.isoformat()


@patch("hevy2garmin.sync.db")
@patch("hevy2garmin.sync.get_client")
@patch("hevy2garmin.sync.HevyClient")
@patch("hevy2garmin.sync.attempt_merge")
def test_grace_defers_too_new_workout(mock_merge, mock_hevy_cls, mock_gclient, mock_db):
    now = datetime.now(timezone.utc)
    fresh = {
        "id": "w1", "title": "Push",
        "start_time": _iso(now - timedelta(minutes=30)),
        "end_time": _iso(now - timedelta(minutes=10)),
        "updated_at": _iso(now), "exercises": [],
    }
    h = MagicMock()
    h.get_workout_count.return_value = 1
    h.get_workouts.return_value = {"workouts": [fresh], "page_count": 1}
    mock_hevy_cls.return_value = h
    mock_gclient.return_value = MagicMock()
    mock_db.is_synced.return_value = False
    stats = sync(config={"hevy_api_key": "t", "merge_mode": True,
                         "sync": {"grace_period_minutes": 120}}, limit=1)
    assert stats["deferred"] == 1
    assert stats["synced"] == 0
    mock_merge.assert_not_called()
    mock_db.mark_synced.assert_not_called()


@patch("hevy2garmin.sync.db")
@patch("hevy2garmin.sync.get_client")
@patch("hevy2garmin.sync.HevyClient")
@patch("hevy2garmin.sync.attempt_merge")
def test_grace_processes_old_enough_workout(mock_merge, mock_hevy_cls, mock_gclient, mock_db):
    now = datetime.now(timezone.utc)
    old = {"id": "w1", "title": "Push",
           "start_time": _iso(now - timedelta(hours=5)),
           "end_time": _iso(now - timedelta(hours=4)),
           "updated_at": _iso(now), "exercises": []}
    h = MagicMock(); h.get_workout_count.return_value = 1
    h.get_workouts.return_value = {"workouts": [old], "page_count": 1}
    mock_hevy_cls.return_value = h; mock_gclient.return_value = MagicMock()
    mock_db.is_synced.return_value = False
    mock_merge.return_value = MergeResult(merged=True, activity_id=99)
    with patch("hevy2garmin.sync._estimate_fit_stats", return_value={"calories": 100, "avg_hr": 90}):
        stats = sync(config={"hevy_api_key": "t", "merge_mode": True,
                             "sync": {"grace_period_minutes": 120}}, limit=1)
    assert stats["deferred"] == 0
    assert stats["synced"] == 1


@patch("hevy2garmin.sync.db")
@patch("hevy2garmin.sync.get_client")
@patch("hevy2garmin.sync.HevyClient")
@patch("hevy2garmin.sync.attempt_merge")
def test_manual_run_bypasses_grace(mock_merge, mock_hevy_cls, mock_gclient, mock_db):
    now = datetime.now(timezone.utc)
    fresh = {"id": "w1", "title": "Push",
             "start_time": _iso(now - timedelta(minutes=20)),
             "end_time": _iso(now - timedelta(minutes=5)),
             "updated_at": _iso(now), "exercises": []}
    h = MagicMock(); h.get_workout_count.return_value = 1
    h.get_workouts.return_value = {"workouts": [fresh], "page_count": 1}
    mock_hevy_cls.return_value = h; mock_gclient.return_value = MagicMock()
    mock_db.is_synced.return_value = False
    mock_merge.return_value = MergeResult(merged=True, activity_id=99)
    with patch("hevy2garmin.sync._estimate_fit_stats", return_value={"calories": 100, "avg_hr": 90}):
        stats = sync(config={"hevy_api_key": "t", "merge_mode": True,
                             "sync": {"grace_period_minutes": 120}},
                     limit=1, respect_grace=False)
    assert stats["deferred"] == 0
    assert stats["synced"] == 1


class TestFetchWorkouts:
    def test_with_limit(self) -> None:
        hevy = MagicMock()
        hevy.get_workouts.return_value = {
            "workouts": [{"id": f"w{i}"} for i in range(5)],
            "page_count": 1,
        }
        result = fetch_workouts(hevy, limit=3)
        assert len(result) == 3

    def test_with_since_date(self) -> None:
        hevy = MagicMock()
        hevy.get_workouts.return_value = {
            "workouts": [
                {"id": "w1", "start_time": "2026-04-01T20:00:00+00:00"},
                {"id": "w2", "start_time": "2026-03-15T20:00:00+00:00"},
                {"id": "w3", "start_time": "2026-03-01T20:00:00+00:00"},
            ],
            "page_count": 1,
        }
        result = fetch_workouts(hevy, since="2026-03-10")
        assert len(result) == 2  # w1 and w2, w3 is before since

    def test_pagination(self) -> None:
        hevy = MagicMock()
        hevy.get_workouts.side_effect = [
            {"workouts": [{"id": "w1", "start_time": "2026-04-01"}], "page_count": 2},
            {"workouts": [{"id": "w2", "start_time": "2026-03-31"}], "page_count": 2},
        ]
        result = fetch_workouts(hevy, fetch_all=True)
        assert len(result) == 2

    def test_empty_response(self) -> None:
        hevy = MagicMock()
        hevy.get_workouts.return_value = {"workouts": [], "page_count": 0}
        result = fetch_workouts(hevy, fetch_all=True)
        assert result == []


class TestSync:
    def test_dry_run_no_garmin_calls(self, sample_workout: dict) -> None:
        with patch("hevy2garmin.sync.HevyClient") as MockHevy, \
             patch("hevy2garmin.sync.get_client") as mock_garmin, \
             patch("hevy2garmin.sync.db") as mock_db:
            mock_hevy = MockHevy.return_value
            mock_hevy.get_workout_count.return_value = 1
            mock_hevy.get_workouts.return_value = {"workouts": [sample_workout], "page_count": 1}
            mock_db.is_synced.return_value = False

            result = sync(dry_run=True, limit=1, hevy_api_key="test", respect_grace=False)

            mock_garmin.assert_not_called()
            mock_db.list_pending.assert_not_called()
            assert result["synced"] == 1

    def test_skips_already_synced(self, sample_workout: dict) -> None:
        with patch("hevy2garmin.sync.HevyClient") as MockHevy, \
             patch("hevy2garmin.sync.db") as mock_db, \
             patch("hevy2garmin.sync.get_client"):
            mock_hevy = MockHevy.return_value
            mock_hevy.get_workout_count.return_value = 1
            mock_hevy.get_workouts.return_value = {"workouts": [sample_workout], "page_count": 1}
            mock_db.is_synced.return_value = True

            result = sync(dry_run=True, limit=1, hevy_api_key="test", respect_grace=False)
            assert result["skipped"] == 1
            assert result["synced"] == 0

    @pytest.mark.parametrize(
        ("phase", "bucket"),
        [
            ("processing", "processing"),
            ("needs_review", "needs_review"),
            ("failed", "failed"),
        ],
    )
    def test_reconciles_parked_workout_with_phase_stats(
        self, sample_workout: dict, phase: str, bucket: str,
    ) -> None:
        with patch("hevy2garmin.sync.HevyClient") as MockHevy, \
             patch("hevy2garmin.sync.db") as mock_db, \
             patch("hevy2garmin.sync.get_client") as mock_gclient, \
             patch("hevy2garmin.sync.sync_one_workout") as mock_one, \
             patch("hevy2garmin.sync.reconcile_pending") as mock_reconcile, \
             patch("hevy2garmin.reconcile.detect_duplicates", return_value=[]):
            mock_hevy = MockHevy.return_value
            mock_hevy.get_workout_count.return_value = 1
            mock_hevy.get_workouts.return_value = {"workouts": [sample_workout], "page_count": 1}
            mock_db.is_synced.return_value = False
            mock_db.list_pending.return_value = [{"hevy_id": sample_workout["id"], "phase": phase}]
            mock_reconcile.return_value = MagicMock(status=phase)

            result = sync(
                config={"hevy_api_key": "test", "merge_mode": False},
                limit=1,
                respect_grace=False,
                record_log=False,
            )

            mock_one.assert_not_called()
            mock_reconcile.assert_called_once_with(mock_db, mock_gclient.return_value, sample_workout["id"])
            assert result[bucket] == 1
            assert result["synced"] == 0

    def test_terminal_state_precedes_parked_state(self, sample_workout: dict) -> None:
        with patch("hevy2garmin.sync.HevyClient") as MockHevy, \
             patch("hevy2garmin.sync.db") as mock_db, \
             patch("hevy2garmin.sync.get_client"), \
             patch("hevy2garmin.sync.sync_one_workout") as mock_one, \
             patch("hevy2garmin.reconcile.detect_duplicates", return_value=[]):
            mock_hevy = MockHevy.return_value
            mock_hevy.get_workout_count.return_value = 1
            mock_hevy.get_workouts.return_value = {"workouts": [sample_workout], "page_count": 1}
            mock_db.is_synced.return_value = True
            mock_db.list_pending.return_value = [
                {"hevy_id": sample_workout["id"], "phase": "processing"}
            ]

            result = sync(
                config={"hevy_api_key": "test", "merge_mode": False},
                limit=1,
                respect_grace=False,
                record_log=False,
            )

            mock_one.assert_not_called()
            assert result["skipped"] == 1
            assert result["processing"] == 0

    def test_reports_unmapped_exercises(self, sample_workout_unmapped: dict) -> None:
        with patch("hevy2garmin.sync.HevyClient") as MockHevy, \
             patch("hevy2garmin.sync.db") as mock_db, \
             patch("hevy2garmin.sync.get_client"):
            mock_hevy = MockHevy.return_value
            mock_hevy.get_workout_count.return_value = 1
            mock_hevy.get_workouts.return_value = {"workouts": [sample_workout_unmapped], "page_count": 1}
            mock_db.is_synced.return_value = False

            result = sync(dry_run=True, limit=1, hevy_api_key="test", respect_grace=False)
            assert "Invented Exercise 99" in result["unmapped"]

    def test_handles_fit_generation_failure(self) -> None:
        bad_workout = {
            "id": "bad",
            "title": "Bad",
            "start_time": "invalid",
            "end_time": "also-invalid",
            "exercises": [],
        }
        with patch("hevy2garmin.sync.HevyClient") as MockHevy, \
             patch("hevy2garmin.sync.db") as mock_db, \
             patch("hevy2garmin.sync.get_client"):
            mock_hevy = MockHevy.return_value
            mock_hevy.get_workout_count.return_value = 1
            mock_hevy.get_workouts.return_value = {"workouts": [bad_workout], "page_count": 1}
            mock_db.is_synced.return_value = False

            result = sync(dry_run=True, limit=1, hevy_api_key="test", respect_grace=False)
            assert result["failed"] == 1

    def test_records_to_db_after_success(self, sample_workout: dict) -> None:
        with patch("hevy2garmin.sync.HevyClient") as MockHevy, \
             patch("hevy2garmin.sync.db") as mock_db, \
             patch("hevy2garmin.sync.get_client") as mock_garmin_client, \
             patch("hevy2garmin.sync.upload_fit") as mock_upload, \
             patch("hevy2garmin.sync.rename_activity"), \
             patch("hevy2garmin.sync.set_description"), \
             patch("hevy2garmin.hr.hr_for_sync", return_value=None):
            mock_hevy = MockHevy.return_value
            mock_hevy.get_workout_count.return_value = 1
            mock_hevy.get_workouts.return_value = {"workouts": [sample_workout], "page_count": 1}
            mock_db.is_synced.return_value = False
            mock_upload.return_value = {"upload_id": "123", "activity_id": 456}

            result = sync(
                limit=1,
                hevy_api_key="test",
                garmin_email="e",
                garmin_password="p",
                respect_grace=False,
            )
            mock_db.mark_synced.assert_called_once()
            assert result["synced"] == 1

    def test_record_log_disabled(self, sample_workout: dict) -> None:
        with patch("hevy2garmin.sync.HevyClient") as MockHevy, \
             patch("hevy2garmin.sync.db") as mock_db, \
             patch("hevy2garmin.sync.get_client"), \
             patch("hevy2garmin.sync.sync_one_workout") as mock_one:
            mock_hevy = MockHevy.return_value
            mock_hevy.get_workout_count.return_value = 1
            mock_hevy.get_workouts.return_value = {"workouts": [sample_workout], "page_count": 1}
            mock_db.is_synced.return_value = False
            from hevy2garmin.sync import SyncOneResult
            mock_one.return_value = SyncOneResult(status="synced")

            sync(limit=1, hevy_api_key="test", record_log=False)

            mock_db.record_sync_log.assert_not_called()

    def test_record_log_enabled(self, sample_workout: dict) -> None:
        with patch("hevy2garmin.sync.HevyClient") as MockHevy, \
             patch("hevy2garmin.sync.db") as mock_db, \
             patch("hevy2garmin.sync.get_client"), \
             patch("hevy2garmin.sync.sync_one_workout") as mock_one:
            mock_hevy = MockHevy.return_value
            mock_hevy.get_workout_count.return_value = 1
            mock_hevy.get_workouts.return_value = {"workouts": [sample_workout], "page_count": 1}
            mock_db.is_synced.return_value = False
            from hevy2garmin.sync import SyncOneResult
            mock_one.return_value = SyncOneResult(status="synced")

            sync(limit=1, hevy_api_key="test", log_trigger="manual")

            mock_db.record_sync_log.assert_called_once_with(
                synced=1, skipped=0, failed=0, trigger="manual",
            )


class TestSyncOneWorkout:
    def test_parked_workout_blocks_all_remote_and_terminal_work(self, sample_workout: dict) -> None:
        store = MagicMock()
        store.get_pending.return_value = {"hevy_id": sample_workout["id"], "phase": "finalizing"}
        with patch("hevy2garmin.sync.attempt_merge") as merge, \
             patch("hevy2garmin.sync.generate_fit") as generate, \
             patch("hevy2garmin.sync.find_activity_by_start_time") as find_existing, \
             patch("hevy2garmin.sync.rename_activity") as rename:
            result = sync_one_workout(
                sample_workout,
                cfg={"merge_mode": True},
                garmin_client=MagicMock(),
                database=store,
            )

        assert result.status == "processing"
        merge.assert_not_called()
        generate.assert_not_called()
        find_existing.assert_not_called()
        rename.assert_not_called()
        store.mark_synced.assert_not_called()

    def test_merge_success_stores_calories(self, sample_workout: dict) -> None:
        with patch("hevy2garmin.sync.db") as mock_db, \
             patch("hevy2garmin.sync.attempt_merge") as mock_merge, \
             patch("hevy2garmin.sync._estimate_fit_stats", return_value={"calories": 250, "avg_hr": 120}):
            mock_merge.return_value = MergeResult(merged=True, activity_id=999)
            garmin = MagicMock()

            result = sync_one_workout(
                sample_workout,
                cfg={"merge_mode": True},
                garmin_client=garmin,
            )

            assert result.merged is True
            assert result.calories == 250
            mock_db.mark_synced.assert_called_once_with(
                hevy_id=sample_workout["id"],
                garmin_activity_id="999",
                title=sample_workout["title"],
                calories=250,
                avg_hr=120,
                hevy_updated_at=sample_workout.get("updated_at"),
                sync_method="merge",
            )

    def test_watch_replacement_falls_back_to_merge_when_hr_unextractable(
        self, sample_workout: dict
    ) -> None:
        # Regression #244: when Replace cannot preserve the watch's hi-res HR, it
        # must NOT hard-abort and must NOT delete the watch activity. It falls
        # back to merging the sets into the watch in place (keeps the watch and
        # its HR), so the sync still succeeds and no HR is lost.
        mock_db = MagicMock()
        with patch("hevy2garmin.sync.attempt_merge") as mock_merge, \
             patch("hevy2garmin.hr.backup_activity_hr", return_value=[]) as backup, \
             patch("hevy2garmin.sync._estimate_fit_stats", return_value={"calories": 100, "avg_hr": 90}), \
             patch("hevy2garmin.sync.generate_fit") as generate_fit, \
             patch("hevy2garmin.sync.upload_fit") as upload_fit:
            mock_merge.side_effect = [
                MergeResult(
                    merged=False,
                    force_fresh_upload=True,
                    delete_after_upload=444,
                    fallback_reason="watch replacement",
                ),
                MergeResult(merged=True, activity_id=444),
            ]

            result = sync_one_workout(
                sample_workout,
                cfg={
                    "merge_mode": True,
                    "merge_watch_strategy": "replace",
                    "hr_fusion": {"enabled": False},
                },
                garmin_client=MagicMock(),
                database=mock_db,
            )

        # HR backup was attempted (data-safety intent preserved) ...
        backup.assert_called_once()
        # ... but no hard abort, no fresh upload, and no watch deletion.
        generate_fit.assert_not_called()
        upload_fit.assert_not_called()
        # Fell back to an in-place merge (second attempt_merge, watch_strategy=merge).
        assert mock_merge.call_count == 2
        assert mock_merge.call_args_list[1].kwargs["watch_strategy"] == "merge"
        assert result.status == "synced"
        assert result.sync_method == "merge"
        assert result.merged is True
        assert result.activity_id == 444
        mock_db.mark_synced.assert_called_once()

    def test_description_disabled_skips_set_description(self, sample_workout: dict) -> None:
        with patch("hevy2garmin.sync.db") as mock_db, \
             patch("hevy2garmin.sync.attempt_merge", return_value=MergeResult(merged=False, fallback_reason="No match")), \
             patch("hevy2garmin.hr.hr_for_sync", return_value=None), \
             patch("hevy2garmin.sync.generate_fit", return_value={"exercises": 2, "total_sets": 5, "calories": 100, "avg_hr": 90}), \
             patch("hevy2garmin.sync.find_activity_by_start_time", return_value=None), \
             patch("hevy2garmin.sync.upload_fit", return_value={"activity_id": 456}), \
             patch("hevy2garmin.sync.rename_activity"), \
             patch("hevy2garmin.sync.set_description") as mock_set_desc, \
             patch("hevy2garmin.sync.generate_description", return_value="desc"):
            garmin = MagicMock()
            cfg = {"merge_mode": False, "description_enabled": False}

            sync_one_workout(sample_workout, cfg=cfg, garmin_client=garmin)

            mock_set_desc.assert_not_called()
            mock_db.mark_synced.assert_called_once()

    def test_single_upload_attempts_merge(self, sample_workout: dict) -> None:
        with patch("hevy2garmin.sync.db"), \
             patch("hevy2garmin.sync.attempt_merge") as mock_merge, \
             patch("hevy2garmin.sync._estimate_fit_stats", return_value={"calories": 100, "avg_hr": 90}):
            mock_merge.return_value = MergeResult(merged=True, activity_id=777)
            garmin = MagicMock()

            result = sync_one_workout(
                sample_workout,
                cfg={"merge_mode": True},
                garmin_client=garmin,
            )

            mock_merge.assert_called_once()
            assert result.merged is True

    def test_respect_grace_defers_fresh_workout(self, sample_workout: dict) -> None:
        now = datetime.now(timezone.utc)
        fresh = {
            **sample_workout,
            "start_time": (now - timedelta(minutes=30)).isoformat(),
            "end_time": (now - timedelta(minutes=10)).isoformat(),
        }
        with patch("hevy2garmin.sync.attempt_merge") as mock_merge:
            result = sync_one_workout(
                fresh,
                cfg={"merge_mode": True, "sync": {"grace_period_minutes": 120}},
                garmin_client=MagicMock(),
                respect_grace=True,
            )
            assert result.status == "deferred"
            mock_merge.assert_not_called()

    def test_respect_grace_false_bypasses(self, sample_workout: dict) -> None:
        now = datetime.now(timezone.utc)
        fresh = {
            **sample_workout,
            "start_time": (now - timedelta(minutes=20)).isoformat(),
            "end_time": (now - timedelta(minutes=5)).isoformat(),
        }
        with patch("hevy2garmin.sync.db"), \
             patch("hevy2garmin.sync.attempt_merge") as mock_merge, \
             patch("hevy2garmin.sync._estimate_fit_stats", return_value={"calories": 100, "avg_hr": 90}):
            mock_merge.return_value = MergeResult(merged=True, activity_id=777)
            result = sync_one_workout(
                fresh,
                cfg={"merge_mode": True, "sync": {"grace_period_minutes": 120}},
                garmin_client=MagicMock(),
                respect_grace=False,
            )
            assert result.status == "synced"
            assert result.merged is True


@patch("hevy2garmin.sync.db")
@patch("hevy2garmin.sync.get_client")
@patch("hevy2garmin.sync.HevyClient")
@patch("hevy2garmin.sync.attempt_merge")
@patch("hevy2garmin.sync.generate_fit", return_value={"exercises": 1, "total_sets": 1, "calories": 100, "avg_hr": None})
@patch("hevy2garmin.sync.upload_fit", return_value={"activity_id": 222})
@patch("hevy2garmin.sync.find_activity_by_start_time", return_value=None)
@patch("hevy2garmin.sync.rename_activity")
@patch("hevy2garmin.sync.set_description")
@patch("hevy2garmin.sync.generate_description", return_value="d")
@patch("hevy2garmin.hr.hr_for_sync")
def test_hr_empty_retries_once_then_counts_no_hr(mock_hr, *rest):
    (mock_desc, mock_setdesc, mock_rename, mock_find, mock_upload,
     mock_fit, mock_merge, mock_hevy_cls, mock_gclient, mock_db) = rest
    mock_hr.return_value = None
    now = datetime.now(timezone.utc)
    w = {"id": "w1", "title": "Push",
         "start_time": (now - timedelta(hours=4)).isoformat(),
         "end_time": (now - timedelta(hours=3)).isoformat(),
         "updated_at": now.isoformat(), "exercises": [{"title": "Bench Press (Barbell)", "sets": [{"type": "normal", "weight_kg": 60, "reps": 8}]}]}
    h = MagicMock(); h.get_workout_count.return_value = 1
    h.get_workouts.return_value = {"workouts": [w], "page_count": 1}
    mock_hevy_cls.return_value = h; mock_gclient.return_value = MagicMock()
    mock_db.is_synced.return_value = False
    mock_merge.return_value = MergeResult(
        merged=False,
        force_fresh_upload=True,
        fallback_reason="fresh upload",
    )
    stats = sync(config={"hevy_api_key": "t", "merge_mode": True,
                         "sync": {"grace_period_minutes": 120},
                         "hr_fusion": {"enabled": True}}, limit=1)
    assert mock_hr.call_count == 2
    assert stats["no_hr"] == 1


@patch("hevy2garmin.sync.db")
@patch("hevy2garmin.sync.get_client")
@patch("hevy2garmin.sync.HevyClient")
@patch("hevy2garmin.sync.attempt_merge")
@patch("hevy2garmin.sync.generate_fit", return_value={"exercises": 1, "total_sets": 1, "calories": 100, "avg_hr": None})
@patch("hevy2garmin.sync.upload_fit", return_value={"activity_id": 222})
@patch("hevy2garmin.sync.find_activity_by_start_time", return_value=None)
@patch("hevy2garmin.sync.rename_activity")
@patch("hevy2garmin.sync.set_description")
@patch("hevy2garmin.sync.generate_description", return_value="d")
@patch("hevy2garmin.hr.hr_for_sync")
def test_hr_fusion_disabled_no_retry_no_count(mock_hr, *rest):
    (mock_desc, mock_setdesc, mock_rename, mock_find, mock_upload,
     mock_fit, mock_merge, mock_hevy_cls, mock_gclient, mock_db) = rest
    now = datetime.now(timezone.utc)
    w = {"id": "w1", "title": "Push",
         "start_time": (now - timedelta(hours=4)).isoformat(),
         "end_time": (now - timedelta(hours=3)).isoformat(),
         "updated_at": now.isoformat(), "exercises": [{"title": "Bench Press (Barbell)", "sets": [{"type": "normal", "weight_kg": 60, "reps": 8}]}]}
    h = MagicMock(); h.get_workout_count.return_value = 1
    h.get_workouts.return_value = {"workouts": [w], "page_count": 1}
    mock_hevy_cls.return_value = h; mock_gclient.return_value = MagicMock()
    mock_db.is_synced.return_value = False
    mock_merge.return_value = MergeResult(merged=False, force_fresh_upload=True, fallback_reason="no match")
    stats = sync(config={"hevy_api_key": "t", "merge_mode": True,
                         "sync": {"grace_period_minutes": 120},
                         "hr_fusion": {"enabled": False}}, limit=1)
    assert mock_hr.call_count == 0
    assert stats["no_hr"] == 0


@patch("hevy2garmin.sync.db")
@patch("hevy2garmin.sync.get_client")
@patch("hevy2garmin.sync.HevyClient")
@patch("hevy2garmin.sync.attempt_merge")
@patch("hevy2garmin.sync.generate_fit", return_value={"exercises": 1, "total_sets": 1, "calories": 100, "avg_hr": None})
@patch("hevy2garmin.sync.upload_fit")
@patch("hevy2garmin.sync.find_activity_by_start_time", return_value=555)
@patch("hevy2garmin.sync.rename_activity")
@patch("hevy2garmin.sync.set_description")
@patch("hevy2garmin.sync.generate_description", return_value="d")
@patch("hevy2garmin.hr.hr_for_sync")
def test_no_hr_not_counted_on_dedup_path(mock_hr, *rest):
    """When the activity already exists on Garmin (dedup, no upload), no_hr must
    NOT fire — nothing was uploaded, and the existing activity may have its own HR."""
    (mock_desc, mock_setdesc, mock_rename, mock_find, mock_upload,
     mock_fit, mock_merge, mock_hevy_cls, mock_gclient, mock_db) = rest
    mock_hr.return_value = None
    now = datetime.now(timezone.utc)
    w = {"id": "w1", "title": "Push",
         "start_time": (now - timedelta(hours=4)).isoformat(),
         "end_time": (now - timedelta(hours=3)).isoformat(),
         "updated_at": now.isoformat(), "exercises": [{"title": "Bench Press (Barbell)", "sets": [{"type": "normal", "weight_kg": 60, "reps": 8}]}]}
    h = MagicMock(); h.get_workout_count.return_value = 1
    h.get_workouts.return_value = {"workouts": [w], "page_count": 1}
    mock_hevy_cls.return_value = h; mock_gclient.return_value = MagicMock()
    mock_db.is_synced.return_value = False
    mock_merge.return_value = MergeResult(merged=False, force_fresh_upload=False, fallback_reason="no match")
    stats = sync(config={"hevy_api_key": "t", "merge_mode": True,
                         "sync": {"grace_period_minutes": 120},
                         "hr_fusion": {"enabled": True}}, limit=1)
    mock_upload.assert_not_called()   # dedup: nothing uploaded
    assert stats["no_hr"] == 0        # so no_hr must not fire
    assert stats["synced"] == 1


@patch("hevy2garmin.sync.db")
@patch("hevy2garmin.sync.get_client")
@patch("hevy2garmin.sync.HevyClient")
@patch("hevy2garmin.sync.attempt_merge")
@patch("hevy2garmin.reconcile.detect_duplicates")
def test_sync_runs_duplicate_scan(mock_detect, mock_merge, mock_hevy_cls, mock_gclient, mock_db):
    now = datetime.now(timezone.utc)
    w = {"id": "w1", "title": "Push",
         "start_time": (now - timedelta(hours=4)).isoformat(),
         "end_time": (now - timedelta(hours=3)).isoformat(),
         "updated_at": now.isoformat(), "exercises": []}
    h = MagicMock(); h.get_workout_count.return_value = 1
    h.get_workouts.return_value = {"workouts": [w], "page_count": 1}
    mock_hevy_cls.return_value = h; mock_gclient.return_value = MagicMock()
    mock_db.is_synced.return_value = False
    mock_merge.return_value = MergeResult(merged=True, activity_id=99)
    mock_detect.return_value = [{"workout_id": "w1", "tool_activity_id": 1, "watch_activity_id": 2}]
    with patch("hevy2garmin.sync._estimate_fit_stats", return_value={"calories": 100, "avg_hr": 90}):
        stats = sync(config={"hevy_api_key": "t", "merge_mode": True,
                             "sync": {"grace_period_minutes": 120}}, limit=1)
    assert stats["duplicates"] == 1
    mock_detect.assert_called_once()
