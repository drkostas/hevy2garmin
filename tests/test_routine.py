"""Tests for Hevy routine → Garmin planned-workout conversion and ops."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from fastapi.testclient import TestClient

import hevy2garmin.server as srv
from hevy2garmin import sync as sync_module
from hevy2garmin.sync import routine_schedule_dates
from hevy2garmin.db_sqlite import SQLiteDatabase
from hevy2garmin.garmin import (
    create_workout,
    delete_workout,
    schedule_workout,
    unschedule_workout,
)
from hevy2garmin.mapper import fit_exercise_strings
from hevy2garmin.routine import (
    ROUTINE_DESC_MARKER,
    routine_to_garmin_workout,
    workout_content_hash,
)


class TestFitExerciseStrings:
    def test_known_category_and_exercise(self) -> None:
        # Bench Press (Barbell) maps to FIT (0, 1).
        assert fit_exercise_strings(0, 1) == ("BENCH_PRESS", "BARBELL_BENCH_PRESS")

    def test_unknown_category_is_none(self) -> None:
        assert fit_exercise_strings(65534, 0) == (None, None)

    def test_bad_subcategory_keeps_category(self) -> None:
        cat, name = fit_exercise_strings(0, 99999)
        assert cat == "BENCH_PRESS"
        assert name is None


class TestRoutineToGarminWorkout:
    def _routine(self) -> dict:
        return {
            "id": "r1",
            "title": "Push Day",
            "notes": "chest/shoulders",
            "exercises": [
                {
                    "title": "Bench Press (Barbell)",
                    "sets": [
                        {"type": "warmup", "reps": 10, "weight_kg": 40},
                        {"type": "normal", "reps": 8, "weight_kg": 60},
                    ],
                },
                {
                    "title": "Totally Made Up Exercise",
                    "sets": [{"type": "normal", "reps": 12, "weight_kg": None}],
                },
            ],
        }

    def test_top_level_shape(self) -> None:
        payload = routine_to_garmin_workout(self._routine())
        assert payload["workoutName"] == "Push Day"
        # The routine notes lead the description, with the provenance marker appended so
        # reconciliation can tell our workouts apart from the user's hand-built ones.
        assert payload["description"].startswith("chest/shoulders")
        assert ROUTINE_DESC_MARKER in payload["description"]
        assert payload["sportType"]["sportTypeKey"] == "strength_training"
        assert len(payload["workoutSegments"]) == 1

    def test_description_marker_survives_long_notes(self) -> None:
        # Notes near the 1024 cap must not truncate the marker off the end — detection
        # relies on it being present intact.
        routine = {"id": "r1", "title": "Push", "notes": "x" * 2000, "exercises": []}
        payload = routine_to_garmin_workout(routine)
        assert len(payload["description"]) <= 1024
        assert payload["description"].endswith(ROUTINE_DESC_MARKER)

    def test_steps_and_order(self) -> None:
        steps = routine_to_garmin_workout(self._routine())["workoutSegments"][0]["workoutSteps"]
        assert [s["stepOrder"] for s in steps] == [1, 2, 3]

    def test_warmup_vs_working_step_type(self) -> None:
        steps = routine_to_garmin_workout(self._routine())["workoutSegments"][0]["workoutSteps"]
        assert steps[0]["stepType"]["stepTypeKey"] == "warmup"
        assert steps[1]["stepType"]["stepTypeKey"] == "interval"

    def test_reps_and_weight_encoding(self) -> None:
        steps = routine_to_garmin_workout(self._routine())["workoutSegments"][0]["workoutSteps"]
        assert steps[1]["endCondition"]["conditionTypeKey"] == "reps"
        assert steps[1]["endConditionValue"] == 8.0
        assert steps[1]["weightValue"] == 60.0
        assert steps[1]["weightUnit"]["unitKey"] == "kilogram"

    def test_mapped_exercise_carries_garmin_strings(self) -> None:
        steps = routine_to_garmin_workout(self._routine())["workoutSegments"][0]["workoutSteps"]
        assert steps[0]["category"] == "BENCH_PRESS"
        assert steps[0]["exerciseName"] == "BARBELL_BENCH_PRESS"

    def test_unmapped_exercise_falls_back_to_named_step(self) -> None:
        steps = routine_to_garmin_workout(self._routine())["workoutSegments"][0]["workoutSteps"]
        unknown = steps[2]
        assert "category" not in unknown
        assert "exerciseName" not in unknown
        assert unknown["stepName"] == "Totally Made Up Exercise"

    def test_no_weight_omits_weight_fields(self) -> None:
        steps = routine_to_garmin_workout(self._routine())["workoutSegments"][0]["workoutSteps"]
        assert "weightValue" not in steps[2]

    def test_pound_conversion(self) -> None:
        payload = routine_to_garmin_workout(self._routine(), weight_unit="pound")
        step = payload["workoutSegments"][0]["workoutSteps"][1]  # 60 kg working set
        assert step["weightUnit"]["unitKey"] == "pound"
        assert step["weightValue"] == round(60 * 2.2046226218, 2)

    def test_duration_based_step(self) -> None:
        routine = {"title": "Core", "exercises": [
            {"title": "Plank", "sets": [{"type": "normal", "duration_seconds": 60}]},
        ]}
        step = routine_to_garmin_workout(routine)["workoutSegments"][0]["workoutSteps"][0]
        assert step["endCondition"]["conditionTypeKey"] == "time"
        assert step["endConditionValue"] == 60.0

    def test_empty_routine(self) -> None:
        payload = routine_to_garmin_workout({"title": "Empty", "exercises": []})
        assert payload["workoutSegments"][0]["workoutSteps"] == []

    def test_no_rest_by_default(self) -> None:
        # _routine() has no rest_seconds and no default → no rest steps.
        steps = routine_to_garmin_workout(self._routine())["workoutSegments"][0]["workoutSteps"]
        assert all(s["stepType"]["stepTypeKey"] != "rest" for s in steps)


class TestRestSteps:
    def _routine(self, rest=None) -> dict:
        ex: dict = {"title": "Bench Press (Barbell)", "sets": [
            {"type": "normal", "reps": 8, "weight_kg": 60},
            {"type": "normal", "reps": 8, "weight_kg": 60},
            {"type": "normal", "reps": 8, "weight_kg": 60},
        ]}
        if rest is not None:
            ex["rest_seconds"] = rest
        return {"title": "Push", "exercises": [ex]}

    def test_rest_between_sets_from_hevy(self) -> None:
        steps = routine_to_garmin_workout(self._routine(rest=90))["workoutSegments"][0]["workoutSteps"]
        # 3 sets + 2 rests between them.
        assert [s["stepType"]["stepTypeKey"] for s in steps] == [
            "interval", "rest", "interval", "rest", "interval"]
        assert [s["stepOrder"] for s in steps] == [1, 2, 3, 4, 5]

    def test_rest_step_shape(self) -> None:
        steps = routine_to_garmin_workout(self._routine(rest=90))["workoutSegments"][0]["workoutSteps"]
        rest = steps[1]
        assert rest["stepType"] == {"stepTypeId": 5, "stepTypeKey": "rest"}
        assert rest["endCondition"]["conditionTypeKey"] == "time"
        assert rest["endConditionValue"] == 90.0
        assert "category" not in rest and "weightValue" not in rest

    def test_no_rest_after_last_set(self) -> None:
        steps = routine_to_garmin_workout(self._routine(rest=90))["workoutSegments"][0]["workoutSteps"]
        assert steps[-1]["stepType"]["stepTypeKey"] == "interval"

    def test_hevy_rest_overrides_default(self) -> None:
        steps = routine_to_garmin_workout(
            self._routine(rest=30), default_rest_seconds=120
        )["workoutSegments"][0]["workoutSteps"]
        assert steps[1]["endConditionValue"] == 30.0

    def test_default_used_when_hevy_omits(self) -> None:
        steps = routine_to_garmin_workout(
            self._routine(), default_rest_seconds=75
        )["workoutSegments"][0]["workoutSteps"]
        rests = [s for s in steps if s["stepType"]["stepTypeKey"] == "rest"]
        assert len(rests) == 2
        assert all(s["endConditionValue"] == 75.0 for s in rests)

    def test_zero_rest_adds_no_steps(self) -> None:
        steps = routine_to_garmin_workout(self._routine(rest=0))["workoutSegments"][0]["workoutSteps"]
        assert all(s["stepType"]["stepTypeKey"] != "rest" for s in steps)

    def test_rest_not_added_across_exercises(self) -> None:
        routine = {"title": "Full", "exercises": [
            {"title": "Bench Press (Barbell)", "rest_seconds": 60,
             "sets": [{"type": "normal", "reps": 5, "weight_kg": 60}]},
            {"title": "Bench Press (Barbell)", "rest_seconds": 60,
             "sets": [{"type": "normal", "reps": 5, "weight_kg": 60}]},
        ]}
        steps = routine_to_garmin_workout(routine)["workoutSegments"][0]["workoutSteps"]
        # One set each, so no intra-exercise rest and none between exercises.
        assert [s["stepType"]["stepTypeKey"] for s in steps] == ["interval", "interval"]


class TestGarminWorkoutOps:
    def test_create_workout_posts_and_returns_id(self) -> None:
        client = MagicMock()
        client.client.request.return_value.json.return_value = {"workoutId": 999}
        wid = create_workout(client, {"workoutName": "Push"})
        assert wid == 999
        method, service, path = client.client.request.call_args[0][:3]
        assert method == "POST"
        assert path == "/workout-service/workout"
        assert client.client.request.call_args[1]["json"] == {"workoutName": "Push"}

    def test_create_workout_missing_id_returns_none(self) -> None:
        client = MagicMock()
        client.client.request.return_value.json.return_value = {}
        assert create_workout(client, {"workoutName": "Push"}) is None

    def test_delete_workout_hits_delete_endpoint(self) -> None:
        client = MagicMock()
        delete_workout(client, 42)
        method, service, path = client.client.request.call_args[0][:3]
        assert method == "DELETE"
        assert path == "/workout-service/workout/42"

    def test_schedule_workout_posts_date(self) -> None:
        client = MagicMock()
        client.client.request.return_value.json.return_value = {"workoutScheduleId": 99}
        schedule_id = schedule_workout(client, 42, "2026-08-01")
        method, service, path = client.client.request.call_args[0][:3]
        assert method == "POST"
        assert path == "/workout-service/schedule/42"
        assert client.client.request.call_args[1]["json"] == {"date": "2026-08-01"}
        # The returned scheduleId is what the caller tracks to unschedule later.
        assert schedule_id == 99

    def test_schedule_workout_returns_none_on_unparseable_body(self) -> None:
        client = MagicMock()
        client.client.request.return_value.json.side_effect = ValueError("no body")
        # A missing/garbled id must not fail the schedule — it just isn't tracked.
        assert schedule_workout(client, 42, "2026-08-01") is None

    def test_unschedule_workout_deletes_entry(self) -> None:
        client = MagicMock()
        unschedule_workout(client, 99)
        method, service, path = client.client.request.call_args[0][:3]
        assert method == "DELETE"
        assert path == "/workout-service/schedule/99"


class TestSyncRoutines:
    def _patched(self, tmp_path: Path, routines: list[dict]):
        """Patch sync_routines' collaborators; return (db, create_mock, schedule_mock)."""
        store = SQLiteDatabase(tmp_path / "routines.db")
        hevy = MagicMock()
        hevy.get_routines.return_value = {"routines": routines, "page_count": 1}
        create_mock = MagicMock(return_value=777)
        schedule_mock = MagicMock()
        # patches[7] stubs list_workouts (the pre-create library reconciliation). It
        # returns an empty library by default — no orphans — so it's a no-op for tests
        # that don't exercise reconciliation, and it keeps the real list_workouts (with
        # its 1s rate-limit sleep) out of every sync test. Tests that need orphans swap
        # in their own list mock, the same way delete_workout (patches[5]) is overridden.
        patches = [
            patch.object(sync_module, "load_config", return_value={
                "hevy_api_key": "k", "garmin_email": "e", "garmin_password": "p"}),
            patch.object(sync_module.db, "get_db", return_value=store),
            patch.object(sync_module, "HevyClient", return_value=hevy),
            patch.object(sync_module, "get_client", return_value=MagicMock()),
            patch.object(sync_module, "create_workout", create_mock),
            patch.object(sync_module, "delete_workout", MagicMock()),
            patch.object(sync_module, "schedule_workout", schedule_mock),
            patch.object(sync_module, "list_workouts", MagicMock(return_value=[])),
        ]
        return store, create_mock, schedule_mock, patches

    def test_creates_and_tracks(self, tmp_path: Path) -> None:
        routines = [{"id": "r1", "title": "Push", "updated_at": "2026-01-01T00:00:00Z",
                     "exercises": [{"title": "Bench Press (Barbell)",
                                    "sets": [{"type": "normal", "reps": 5, "weight_kg": 60}]}]}]
        store, create_mock, _, patches = self._patched(tmp_path, routines)
        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], patches[6], patches[7]:
            result = sync_module.sync_routines()
        assert result == {"created": 1, "updated": 0, "skipped": 0, "failed": 0,
                          "scheduled": 0, "total": 1}
        create_mock.assert_called_once()
        assert store.get_synced_routine("r1")["garmin_workout_id"] == "777"

    def test_sync_single_routine_creates_and_returns_row(self, tmp_path: Path) -> None:
        routines = [{"id": "r1", "title": "Push", "updated_at": "2026-01-01T00:00:00Z",
                     "exercises": [{"title": "Bench Press (Barbell)",
                                    "sets": [{"type": "normal", "reps": 5, "weight_kg": 60}]}]}]
        store, create_mock, _, patches = self._patched(tmp_path, routines)
        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], patches[6], patches[7]:
            result = sync_module.sync_routine("r1")
        assert result["outcome"] == "created"
        assert result["row"] == {
            "id": "r1", "title": "Push",
            "exercises": [{"name": "Bench Press (Barbell)", "sets": 1}],
            "exercise_count": 1, "synced": True, "scheduled_date": None}
        create_mock.assert_called_once()
        assert store.get_synced_routine("r1")["garmin_workout_id"] == "777"

    def test_sync_single_routine_not_found_raises(self, tmp_path: Path) -> None:
        routines = [{"id": "r1", "title": "Push", "exercises": []}]
        store, _, _, patches = self._patched(tmp_path, routines)
        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], patches[6], patches[7]:
            with pytest.raises(ValueError, match="not found"):
                sync_module.sync_routine("missing")

    def _hash_for(self, routine: dict) -> str:
        # Mirror how sync_routines builds the payload (no timing config → 75s default).
        payload = routine_to_garmin_workout(routine, weight_unit="kilogram", default_rest_seconds=75)
        return workout_content_hash(payload)

    def test_skips_when_hash_unchanged(self, tmp_path: Path) -> None:
        routines = [{"id": "r1", "title": "Push", "updated_at": "2026-01-01T00:00:00Z", "exercises": []}]
        store, create_mock, _, patches = self._patched(tmp_path, routines)
        store.mark_routine_synced("r1", garmin_workout_id="777",
                                  content_hash=self._hash_for(routines[0]))
        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], patches[6], patches[7]:
            result = sync_module.sync_routines()
        assert result["skipped"] == 1
        assert result["created"] == 0
        create_mock.assert_not_called()

    def test_resyncs_when_hash_changed(self, tmp_path: Path) -> None:
        routines = [{"id": "r1", "title": "Push", "updated_at": "2026-01-01T00:00:00Z", "exercises": []}]
        store, create_mock, _, patches = self._patched(tmp_path, routines)
        delete_mock = MagicMock()
        # Stored under a stale hash → payload differs → recreate.
        store.mark_routine_synced("r1", garmin_workout_id="555", content_hash="stale-hash")
        with patches[0], patches[1], patches[2], patches[3], patches[4], \
                patch.object(sync_module, "delete_workout", delete_mock), patches[6], patches[7]:
            result = sync_module.sync_routines()
        assert result["updated"] == 1
        assert result["created"] == 0
        assert result["skipped"] == 0
        create_mock.assert_called_once()
        delete_mock.assert_called_once_with(delete_mock.call_args[0][0], "555")
        assert store.get_synced_routine("r1")["content_hash"] == self._hash_for(routines[0])

    def test_schedule_when_date_given(self, tmp_path: Path) -> None:
        routines = [{"id": "r1", "title": "Push", "updated_at": "2026-01-01T00:00:00Z", "exercises": []}]
        store, _, schedule_mock, patches = self._patched(tmp_path, routines)
        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], patches[6], patches[7]:
            result = sync_module.sync_routines(schedule_date="2026-08-01")
        assert result["scheduled"] == 1
        assert schedule_mock.call_count == 1
        assert schedule_mock.call_args[0][1:] == (777, "2026-08-01")
        assert store.get_synced_routine("r1")["scheduled_date"] == "2026-08-01"

    def test_force_recreates_already_synced(self, tmp_path: Path) -> None:
        routines = [{"id": "r1", "title": "Push", "updated_at": "2026-01-01T00:00:00Z",
                     "exercises": [{"title": "Bench Press (Barbell)",
                                    "sets": [{"type": "normal", "reps": 5, "weight_kg": 60}]}]}]
        store, create_mock, _, patches = self._patched(tmp_path, routines)
        store.mark_routine_synced("r1", garmin_workout_id="555",
                                  hevy_updated_at="2026-01-01T00:00:00Z")
        delete_mock = MagicMock()
        with patches[0], patches[1], patches[2], patches[3], patches[4], \
                patch.object(sync_module, "delete_workout", delete_mock), patches[6], patches[7]:
            result = sync_module.sync_routines(force=True)
        # Forcing a routine that was already synced counts as an update.
        assert result["updated"] == 1
        assert result["created"] == 0
        assert result["skipped"] == 0
        create_mock.assert_called_once()
        delete_mock.assert_called_once_with(delete_mock.call_args[0][0], "555")
        assert store.get_synced_routine("r1")["garmin_workout_id"] == "777"

    def test_dry_run_does_not_call_garmin(self, tmp_path: Path) -> None:
        routines = [{"id": "r1", "title": "Push", "updated_at": "2026-01-01T00:00:00Z", "exercises": []}]
        store, create_mock, _, patches = self._patched(tmp_path, routines)
        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], patches[6], patches[7]:
            result = sync_module.sync_routines(dry_run=True)
        assert result["created"] == 1
        create_mock.assert_not_called()
        assert store.get_synced_routine("r1") is None

    def test_resync_preserves_prior_schedule(self, tmp_path: Path) -> None:
        # A routine synced AND scheduled, then re-synced because its content changed:
        # recreating the Garmin workout drops its calendar entry, so the stored date
        # must be re-applied to the new workout (a restore, not a new booking).
        routines = [{"id": "r1", "title": "Push", "updated_at": "2026-01-01T00:00:00Z", "exercises": []}]
        store, create_mock, schedule_mock, patches = self._patched(tmp_path, routines)
        store.mark_routine_synced("r1", garmin_workout_id="555",
                                  scheduled_date="2026-08-01", content_hash="stale-hash")
        delete_mock = MagicMock()
        with patches[0], patches[1], patches[2], patches[3], patches[4], \
                patch.object(sync_module, "delete_workout", delete_mock), patches[6], patches[7]:
            result = sync_module.sync_routines()
        assert result["updated"] == 1
        # Restoring the old date is not counted as a new schedule.
        assert result["scheduled"] == 0
        # The new workout (777) is re-scheduled on the stored date...
        schedule_mock.assert_called_once()
        assert schedule_mock.call_args[0][1:] == (777, "2026-08-01")
        # ...and the date is kept on the record instead of being wiped to None.
        assert store.get_synced_routine("r1")["scheduled_date"] == "2026-08-01"

    def test_resync_restores_all_recurring_dates(self, tmp_path: Path) -> None:
        # A recurring routine booked on 3 dates, then edited: the content-change re-sync
        # must re-book ALL 3 dates on the recreated workout, not collapse to one.
        routines = [{"id": "r1", "title": "Push", "updated_at": "2026-01-01T00:00:00Z", "exercises": []}]
        store, create_mock, schedule_mock, patches = self._patched(tmp_path, routines)
        store.mark_routine_synced("r1", garmin_workout_id="555",
                                  scheduled_date="2026-08-03", content_hash="stale-hash")
        for d in ("2026-08-03", "2026-08-10", "2026-08-17"):
            store.add_routine_schedule("r1", f"old-{d}", d)
        schedule_mock.side_effect = lambda _client, _wid, day: f"new-{day}"
        with patches[0], patches[1], patches[2], patches[3], patches[4], \
                patch.object(sync_module, "delete_workout", MagicMock()), patches[6], patches[7]:
            result = sync_module.sync_routines()
        assert result["updated"] == 1
        # All three dates re-booked on the new workout, and tracked with fresh ids.
        assert sorted(c.args[2] for c in schedule_mock.call_args_list) == [
            "2026-08-03", "2026-08-10", "2026-08-17"]
        assert set(store.get_routine_schedule_ids("r1")) == {
            "new-2026-08-03", "new-2026-08-10", "new-2026-08-17"}
        assert store.get_synced_routine("r1")["scheduled_date"] == "2026-08-03"

    def test_schedule_records_calendar_entry(self, tmp_path: Path) -> None:
        # A first sync with an explicit date books the Garmin calendar and records the
        # returned scheduleId, so a later reschedule can unschedule it instead of stacking.
        routines = [{"id": "r1", "title": "Push", "updated_at": "2026-01-01T00:00:00Z", "exercises": []}]
        store, _, schedule_mock, patches = self._patched(tmp_path, routines)
        schedule_mock.return_value = 2001
        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], patches[6], patches[7]:
            result = sync_module.sync_routines(schedule_date="2026-08-01")
        assert result["scheduled"] == 1
        assert store.get_routine_schedule_ids("r1") == ["2001"]

    def test_schedule_failure_persists_workout_then_recovers(self, tmp_path: Path) -> None:
        # #2 regression: create_workout succeeds, then schedule_workout errors. The
        # created workout must be recorded (as schedule_pending) so the next sync
        # recovers it instead of orphaning it and creating a duplicate.
        routines = [{"id": "r1", "title": "Push", "updated_at": "2026-01-01T00:00:00Z", "exercises": []}]
        store, create_mock, schedule_mock, patches = self._patched(tmp_path, routines)
        schedule_mock.side_effect = RuntimeError("Garmin 429")

        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], patches[6], patches[7]:
            first = sync_module.sync_routines(schedule_date="2026-08-01")

        # The schedule failed, but the created workout is tracked (not orphaned).
        assert first["failed"] == 1
        assert first["created"] == 0
        record = store.get_synced_routine("r1")
        assert record is not None
        assert record["garmin_workout_id"] == "777"
        assert record["status"] == "schedule_pending"

        # Next sync: scheduling recovers. The pending workout is deleted and recreated
        # (no second, untracked copy) and the schedule is retried on the stored date.
        schedule_mock.side_effect = None
        delete_mock = MagicMock()
        with patches[0], patches[1], patches[2], patches[3], patches[4], \
                patch.object(sync_module, "delete_workout", delete_mock), patches[6], patches[7]:
            second = sync_module.sync_routines()

        assert second["updated"] == 1
        assert second["failed"] == 0
        # The previously-created workout (777) is deleted before recreating — orphan recovered.
        delete_mock.assert_called_once_with(delete_mock.call_args[0][0], "777")
        final = store.get_synced_routine("r1")
        assert final["status"] == "success"
        assert final["scheduled_date"] == "2026-08-01"

    def test_reconciles_marked_orphan_from_garmin_library(self, tmp_path: Path) -> None:
        # #3: the DB has no record (it was reset while the Garmin workout survived, or a
        # prior run crashed after create but before persisting), yet a same-named workout
        # *carrying our provenance marker* still lives in the Garmin library. Reconciliation
        # must recognise it as ours, delete it before recreating, and not duplicate it.
        routines = [{"id": "r1", "title": "Push", "updated_at": "2026-01-01T00:00:00Z", "exercises": []}]
        store, create_mock, _, patches = self._patched(tmp_path, routines)
        list_mock = MagicMock(return_value=[
            {"workoutId": 777, "workoutName": "Push", "description": f"notes\n{ROUTINE_DESC_MARKER}"}])
        delete_mock = MagicMock()
        with patches[0], patches[1], patches[2], patches[3], patches[4], \
                patch.object(sync_module, "delete_workout", delete_mock), patches[6], \
                patch.object(sync_module, "list_workouts", list_mock):
            result = sync_module.sync_routines()
        # No DB record → counted as a create, but the orphan is deleted first, not duplicated.
        assert result["created"] == 1
        assert result["failed"] == 0
        delete_mock.assert_called_once_with(delete_mock.call_args[0][0], "777")
        create_mock.assert_called_once()
        assert store.get_synced_routine("r1")["garmin_workout_id"] == "777"

    def test_does_not_delete_unmarked_same_named_workout(self, tmp_path: Path) -> None:
        # Core safety guarantee (review item #2): a same-named workout WITHOUT our marker is
        # one the user hand-built in Garmin. With no DB record for it, reconciliation must
        # NOT delete it — it creates a fresh copy instead (a possible duplicate is acceptable;
        # destroying the user's workout is not).
        routines = [{"id": "r1", "title": "Push", "updated_at": "2026-01-01T00:00:00Z", "exercises": []}]
        store, create_mock, _, patches = self._patched(tmp_path, routines)
        list_mock = MagicMock(return_value=[
            {"workoutId": 777, "workoutName": "Push", "description": "my own leg day"}])
        delete_mock = MagicMock()
        with patches[0], patches[1], patches[2], patches[3], patches[4], \
                patch.object(sync_module, "delete_workout", delete_mock), patches[6], \
                patch.object(sync_module, "list_workouts", list_mock):
            result = sync_module.sync_routines()
        assert result["created"] == 1
        delete_mock.assert_not_called()
        create_mock.assert_called_once()

    def test_reconciliation_is_best_effort_when_listing_fails(self, tmp_path: Path) -> None:
        # If listing the Garmin library errors, sync must still proceed on DB-only dedup
        # rather than aborting the whole run.
        routines = [{"id": "r1", "title": "Push", "updated_at": "2026-01-01T00:00:00Z", "exercises": []}]
        store, create_mock, _, patches = self._patched(tmp_path, routines)
        list_mock = MagicMock(side_effect=RuntimeError("Garmin 500"))
        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], patches[6], \
                patch.object(sync_module, "list_workouts", list_mock):
            result = sync_module.sync_routines()
        assert result["created"] == 1
        assert result["failed"] == 0
        create_mock.assert_called_once()
        assert store.get_synced_routine("r1")["garmin_workout_id"] == "777"

    def test_tracked_id_in_library_is_not_deleted_twice(self, tmp_path: Path) -> None:
        # The routine is already tracked (stale hash → recreate) and its id is also the
        # one Garmin returns. The tracked-id delete and the by-name orphan delete refer to
        # the same workout, so it must be deleted exactly once (set-deduped).
        routines = [{"id": "r1", "title": "Push", "updated_at": "2026-01-01T00:00:00Z", "exercises": []}]
        store, create_mock, _, patches = self._patched(tmp_path, routines)
        store.mark_routine_synced("r1", garmin_workout_id="555", content_hash="stale-hash")
        list_mock = MagicMock(return_value=[
            {"workoutId": 555, "workoutName": "Push", "description": f"x\n{ROUTINE_DESC_MARKER}"}])
        delete_mock = MagicMock()
        with patches[0], patches[1], patches[2], patches[3], patches[4], \
                patch.object(sync_module, "delete_workout", delete_mock), patches[6], \
                patch.object(sync_module, "list_workouts", list_mock):
            result = sync_module.sync_routines()
        assert result["updated"] == 1
        delete_mock.assert_called_once_with(delete_mock.call_args[0][0], "555")

    def test_does_not_touch_differently_named_workout(self, tmp_path: Path) -> None:
        # A library workout whose name doesn't match the routine title is unrelated and
        # must never be deleted by reconciliation.
        routines = [{"id": "r1", "title": "Push", "updated_at": "2026-01-01T00:00:00Z", "exercises": []}]
        store, create_mock, _, patches = self._patched(tmp_path, routines)
        list_mock = MagicMock(return_value=[{"workoutId": 999, "workoutName": "Legs"}])
        delete_mock = MagicMock()
        with patches[0], patches[1], patches[2], patches[3], patches[4], \
                patch.object(sync_module, "delete_workout", delete_mock), patches[6], \
                patch.object(sync_module, "list_workouts", list_mock):
            result = sync_module.sync_routines()
        assert result["created"] == 1
        delete_mock.assert_not_called()


class TestRoutineScheduleDates:
    def test_once_returns_single_date(self) -> None:
        assert routine_schedule_dates("once", date="2026-07-20") == ["2026-07-20"]

    def test_once_requires_date(self) -> None:
        with pytest.raises(ValueError):
            routine_schedule_dates("once")

    def test_once_rejects_bad_date(self) -> None:
        with pytest.raises(ValueError):
            routine_schedule_dates("once", date="not-a-date")

    def test_recurring_weekly(self) -> None:
        # 2026-07-15 is a Wednesday; first Monday on/after is 2026-07-20.
        dates = routine_schedule_dates("recurring", weekday=0, start_date="2026-07-15", weeks=5)
        assert dates == ["2026-07-20", "2026-07-27", "2026-08-03", "2026-08-10", "2026-08-17"]

    def test_recurring_start_on_weekday_includes_start(self) -> None:
        # 2026-07-20 is a Monday → the start date itself is the first occurrence.
        dates = routine_schedule_dates("recurring", weekday=0, start_date="2026-07-20", weeks=2)
        assert dates == ["2026-07-20", "2026-07-27"]

    def test_recurring_accepts_string_inputs(self) -> None:
        dates = routine_schedule_dates("recurring", weekday="2", start_date="2026-07-15", weeks="1")
        assert dates == ["2026-07-15"]  # 2026-07-15 is a Wednesday (weekday 2)

    def test_recurring_requires_all_fields(self) -> None:
        with pytest.raises(ValueError):
            routine_schedule_dates("recurring", weekday=0, weeks=3)

    def test_recurring_rejects_bad_weekday(self) -> None:
        with pytest.raises(ValueError):
            routine_schedule_dates("recurring", weekday=9, start_date="2026-07-15", weeks=2)

    def test_recurring_capped(self) -> None:
        dates = routine_schedule_dates("recurring", weekday=0, start_date="2026-01-05", weeks=999)
        assert len(dates) == sync_module.MAX_SCHEDULE_OCCURRENCES

    def test_unknown_mode(self) -> None:
        with pytest.raises(ValueError):
            routine_schedule_dates("bogus")


class TestScheduleRoutine:
    def _patched(self, tmp_path: Path):
        store = SQLiteDatabase(tmp_path / "sched.db")
        # Each schedule POST returns a distinct Garmin scheduleId (1001, 1002, ...).
        schedule_mock = MagicMock(side_effect=lambda *_a, **_k: 1000 + schedule_mock.call_count)
        unschedule_mock = MagicMock()
        client = MagicMock()
        patches = [
            patch.object(sync_module, "load_config", return_value={
                "garmin_email": "e", "garmin_password": "p"}),
            patch.object(sync_module.db, "get_db", return_value=store),
            patch.object(sync_module, "get_client", return_value=client),
            patch.object(sync_module, "schedule_workout", schedule_mock),
            patch.object(sync_module, "unschedule_workout", unschedule_mock),
        ]
        return store, schedule_mock, unschedule_mock, patches

    def test_schedules_each_date(self, tmp_path: Path) -> None:
        store, schedule_mock, _, patches = self._patched(tmp_path)
        store.mark_routine_synced("r1", garmin_workout_id="900", title="Push")
        dates = ["2026-07-20", "2026-07-27"]
        with patches[0], patches[1], patches[2], patches[3], patches[4]:
            result = sync_module.schedule_routine("r1", dates)
        assert result == {"scheduled": 2, "workout_id": "900", "dates": dates}
        assert schedule_mock.call_count == 2
        assert [c.args[1:] for c in schedule_mock.call_args_list] == [
            ("900", "2026-07-20"), ("900", "2026-07-27")]
        # Earliest date persisted for display, and both scheduleIds tracked.
        assert store.get_synced_routine("r1")["scheduled_date"] == "2026-07-20"
        assert set(store.get_routine_schedule_ids("r1")) == {"1001", "1002"}

    def test_reschedule_unschedules_prior_entries(self, tmp_path: Path) -> None:
        # Item #4 regression: scheduling the same routine again must remove the prior
        # calendar entries first (Garmin appends, so re-POSTing would stack duplicates).
        store, schedule_mock, unschedule_mock, patches = self._patched(tmp_path)
        store.mark_routine_synced("r1", garmin_workout_id="900", title="Push")
        with patches[0], patches[1], patches[2], patches[3], patches[4]:
            sync_module.schedule_routine("r1", ["2026-07-20"])
            unschedule_mock.assert_not_called()  # nothing to remove on the first booking
            first_ids = store.get_routine_schedule_ids("r1")
            sync_module.schedule_routine("r1", ["2026-07-21"])
        # The second booking unscheduled the first entry before creating the new one.
        assert [c.args[1] for c in unschedule_mock.call_args_list] == first_ids
        assert store.get_routine_schedule_ids("r1") == ["1002"]

    def test_raises_when_not_synced(self, tmp_path: Path) -> None:
        store, schedule_mock, _, patches = self._patched(tmp_path)
        with patches[0], patches[1], patches[2], patches[3], patches[4]:
            with pytest.raises(ValueError, match="not synced"):
                sync_module.schedule_routine("missing", ["2026-07-20"])
        schedule_mock.assert_not_called()

    def test_raises_on_empty_dates(self, tmp_path: Path) -> None:
        store, _, _, patches = self._patched(tmp_path)
        store.mark_routine_synced("r1", garmin_workout_id="900")
        with patches[0], patches[1], patches[2], patches[3], patches[4]:
            with pytest.raises(ValueError):
                sync_module.schedule_routine("r1", [])


class TestUnscheduleRoutineEntry:
    def _patched(self, tmp_path: Path):
        store = SQLiteDatabase(tmp_path / "unsched.db")
        unschedule_mock = MagicMock()
        patches = [
            patch.object(sync_module, "load_config", return_value={
                "garmin_email": "e", "garmin_password": "p"}),
            patch.object(sync_module.db, "get_db", return_value=store),
            patch.object(sync_module, "get_client", return_value=MagicMock()),
            patch.object(sync_module, "unschedule_workout", unschedule_mock),
        ]
        return store, unschedule_mock, patches

    def test_unschedules_and_removes_row(self, tmp_path: Path) -> None:
        store, unschedule_mock, patches = self._patched(tmp_path)
        store.add_routine_schedule("r1", "111", "2026-07-20")
        store.add_routine_schedule("r1", "222", "2026-07-27")
        with patches[0], patches[1], patches[2], patches[3]:
            sync_module.unschedule_routine_entry("r1", "111")
        assert unschedule_mock.call_args[0][1] == "111"
        # Only the removed entry is dropped from tracking.
        assert store.get_routine_schedule_ids("r1") == ["222"]

    def test_keeps_row_and_raises_on_transient_error(self, tmp_path: Path) -> None:
        # A transient Garmin failure must NOT drop the row (else the calendar entry is
        # orphaned and unremovable) — it re-raises so the caller can surface a retry.
        store, unschedule_mock, patches = self._patched(tmp_path)
        unschedule_mock.side_effect = RuntimeError("Garmin 500")
        store.add_routine_schedule("r1", "111", "2026-07-20")
        with patches[0], patches[1], patches[2], patches[3]:
            with pytest.raises(RuntimeError, match="500"):
                sync_module.unschedule_routine_entry("r1", "111")
        assert store.get_routine_schedule_ids("r1") == ["111"]

    def test_removes_row_when_entry_already_gone_404(self, tmp_path: Path) -> None:
        # A real HTTP 404 (response.status_code) means the entry is already gone → drop it.
        store, unschedule_mock, patches = self._patched(tmp_path)
        err = RuntimeError("Not Found")
        err.response = type("R", (), {"status_code": 404})()
        unschedule_mock.side_effect = err
        store.add_routine_schedule("r1", "111", "2026-07-20")
        with patches[0], patches[1], patches[2], patches[3]:
            sync_module.unschedule_routine_entry("r1", "111")
        assert store.get_routine_schedule_ids("r1") == []

    def test_transient_error_with_404_in_message_keeps_row(self, tmp_path: Path) -> None:
        # A transient error with no HTTP status whose text merely contains "404" (a
        # scheduleId or retry delay) must NOT be mistaken for "already gone" — keep the row.
        store, unschedule_mock, patches = self._patched(tmp_path)
        unschedule_mock.side_effect = RuntimeError("HTTP 500 at /schedule/40412, retry in 40400ms")
        store.add_routine_schedule("r1", "111", "2026-07-20")
        with patches[0], patches[1], patches[2], patches[3]:
            with pytest.raises(RuntimeError):
                sync_module.unschedule_routine_entry("r1", "111")
        assert store.get_routine_schedule_ids("r1") == ["111"]


class TestScheduledWorkoutsUI:
    def _client(self, store: SQLiteDatabase):
        srv._is_configured_cache = True  # skip the "not configured → /setup" redirect
        return patch.object(srv.db, "get_db", return_value=store), TestClient(srv.app)

    def _seed(self, store: SQLiteDatabase, n: int) -> None:
        store.mark_routine_synced("r1", garmin_workout_id="w1", title="Push")
        # Far-future dates so they always count as "upcoming" regardless of today.
        for i in range(n):
            store.add_routine_schedule("r1", f"s{i}", f"2999-01-{i + 1:02d}")

    def test_schedules_fragment_paginates_and_clamps(self, tmp_path: Path) -> None:
        store = SQLiteDatabase(tmp_path / "ui.db")
        self._seed(store, 11)  # 11 entries → 2 pages of 10
        db_patch, client = self._client(store)
        with db_patch, client:
            page1 = client.get("/api/routines/schedules?page=1").text
            page2 = client.get("/api/routines/schedules?page=2").text
            clamped = client.get("/api/routines/schedules?page=99").text
        assert "Page 1 of 2" in page1
        # The timeline humanizes dates ("Jan 11"); the 11th entry sits on page 2.
        assert "Jan 11" not in page1
        assert "Page 2 of 2" in page2 and "Jan 11" in page2
        # Out-of-range page clamps to the last page rather than erroring.
        assert "Page 2 of 2" in clamped

    def test_filter_by_routine_name_and_start_date(self, tmp_path: Path) -> None:
        store = SQLiteDatabase(tmp_path / "ui.db")
        store.mark_routine_synced("r1", garmin_workout_id="w1", title="Push Day")
        store.mark_routine_synced("r2", garmin_workout_id="w2", title="Leg Day")
        store.add_routine_schedule("r1", "s1", "2999-01-05")
        store.add_routine_schedule("r2", "s2", "2999-02-10")
        db_patch, client = self._client(store)
        with db_patch, client:
            by_name = client.get("/api/routines/schedules?q=leg").text
            by_date = client.get("/api/routines/schedules?start=2999-02-01").text
        # Text filter keeps only the matching routine.
        assert "Leg Day" in by_name and "Push Day" not in by_name
        # Start-date filter drops the earlier entry.
        assert "Leg Day" in by_date and "Push Day" not in by_date

    def test_page_size_selector(self, tmp_path: Path) -> None:
        store = SQLiteDatabase(tmp_path / "ui.db")
        store.mark_routine_synced("r1", garmin_workout_id="w1", title="Push")
        for i in range(30):  # 30 future entries
            store.add_routine_schedule("r1", f"s{i}", f"2999-{i // 28 + 1:02d}-{i % 28 + 1:02d}")
        db_patch, client = self._client(store)
        with db_patch, client:
            size25 = client.get("/api/routines/schedules?size=25").text
            size100 = client.get("/api/routines/schedules?size=100").text
            bad = client.get("/api/routines/schedules?size=7").text  # invalid → default 10
        # One Remove button per row → count rows per page.
        assert size25.count("/unschedule?") == 25 and "Page 1 of 2" in size25
        assert '<option value="25" selected>' in size25
        assert size100.count("/unschedule?") == 30 and "Page 1 of" not in size100
        assert bad.count("/unschedule?") == 10 and "Page 1 of 3" in bad
        assert '<option value="10" selected>' in bad

    def test_empty_state(self, tmp_path: Path) -> None:
        store = SQLiteDatabase(tmp_path / "ui.db")
        db_patch, client = self._client(store)
        with db_patch, client:
            html = client.get("/api/routines/schedules").text
        assert "No upcoming scheduled workouts." in html

    def test_schedule_route_triggers_table_refresh(self, tmp_path: Path) -> None:
        # A successful schedule fires the HX-Trigger event the table listens for,
        # so the "Scheduled workouts" table refreshes without a full page reload.
        store = SQLiteDatabase(tmp_path / "ui.db")
        store.mark_routine_synced("r1", garmin_workout_id="900", title="Push")
        db_patch, client = self._client(store)
        with db_patch, client, patch.object(
            srv, "schedule_routine",
            return_value={"scheduled": 1, "workout_id": "900", "dates": ["2999-01-05"]},
        ):
            resp = client.post("/api/routines/r1/schedule", data={"mode": "once", "date": "2999-01-05"})
        assert resp.status_code == 200
        assert resp.headers.get("HX-Trigger") == "refreshSchedules"

    def test_unschedule_route_removes_and_rerenders(self, tmp_path: Path) -> None:
        store = SQLiteDatabase(tmp_path / "ui.db")
        self._seed(store, 2)
        db_patch, client = self._client(store)
        unschedule_mock = MagicMock()
        with db_patch, client, \
                patch.object(sync_module, "load_config", return_value={
                    "garmin_email": "e", "garmin_password": "p"}), \
                patch.object(sync_module, "get_client", return_value=MagicMock()), \
                patch.object(sync_module, "unschedule_workout", unschedule_mock):
            resp = client.post("/api/routines/r1/schedule/s0/unschedule?page=1")
        assert resp.status_code == 200
        unschedule_mock.assert_called_once()
        # The entry is gone and the refreshed fragment is returned.
        assert store.get_routine_schedule_ids("r1") == ["s1"]
        assert 'id="scheduled-table"' in resp.text

    def test_unschedule_route_keeps_row_on_transient_error(self, tmp_path: Path) -> None:
        store = SQLiteDatabase(tmp_path / "ui.db")
        self._seed(store, 2)
        db_patch, client = self._client(store)
        with db_patch, client, \
                patch.object(sync_module, "load_config", return_value={
                    "garmin_email": "e", "garmin_password": "p"}), \
                patch.object(sync_module, "get_client", return_value=MagicMock()), \
                patch.object(sync_module, "unschedule_workout",
                             MagicMock(side_effect=RuntimeError("Garmin 500"))):
            resp = client.post("/api/routines/r1/schedule/s0/unschedule?page=1")
        # Transient failure surfaces an error toast and keeps the entry tracked.
        assert "toast-error" in resp.text
        assert set(store.get_routine_schedule_ids("r1")) == {"s0", "s1"}


class TestRoutineSyncUI:
    def _client(self, store: SQLiteDatabase):
        srv._is_configured_cache = True  # skip the "not configured → /setup" redirect
        return patch.object(srv.db, "get_db", return_value=store), TestClient(srv.app)

    def test_sync_route_swaps_row_and_toasts(self, tmp_path: Path) -> None:
        store = SQLiteDatabase(tmp_path / "ui.db")
        db_patch, client = self._client(store)
        row = {"id": "r1", "title": "Push", "exercise_count": 3, "synced": True, "scheduled_date": None}
        with db_patch, client, patch.object(
            srv, "sync_routine", return_value={"outcome": "created", "row": row}
        ):
            resp = client.post("/api/routines/r1/sync")
        assert resp.status_code == 200
        assert "toast-success" in resp.text
        # The updated row is returned as an out-of-band swap so it flips to synced.
        assert 'id="routine-row-r1"' in resp.text and 'hx-swap-oob="true"' in resp.text
        assert "Re-sync" in resp.text  # synced rows offer re-sync
        assert resp.headers.get("HX-Trigger") == "refreshSchedules"

    def test_sync_route_reports_failure(self, tmp_path: Path) -> None:
        store = SQLiteDatabase(tmp_path / "ui.db")
        db_patch, client = self._client(store)
        row = {"id": "r1", "title": "Push", "exercise_count": 3, "synced": False, "scheduled_date": None}
        with db_patch, client, patch.object(
            srv, "sync_routine", return_value={"outcome": "failed", "row": row}
        ):
            resp = client.post("/api/routines/r1/sync")
        assert "toast-error" in resp.text
        assert "hx-swap-oob" not in resp.text  # no row swap on failure

    def test_sync_route_demo_mode(self, tmp_path: Path) -> None:
        store = SQLiteDatabase(tmp_path / "ui.db")
        db_patch, client = self._client(store)
        with db_patch, client, patch.object(srv, "is_demo_mode", return_value=True):
            resp = client.post("/api/routines/r1/sync")
        assert "demo mode" in resp.text


class TestDbFacade:
    def test_get_synced_routine_facade_delegates(self) -> None:
        # Regression: the `db` module facade must expose get_synced_routine, else
        # `hevy2garmin sync-routines --list` crashes (it calls db.get_synced_routine).
        from hevy2garmin import db as db_facade

        store = MagicMock()
        store.get_synced_routine.return_value = {"garmin_workout_id": "w1"}
        with patch.object(db_facade, "get_db", return_value=store):
            assert db_facade.get_synced_routine("r1") == {"garmin_workout_id": "w1"}
            store.get_synced_routine.assert_called_once_with("r1")
