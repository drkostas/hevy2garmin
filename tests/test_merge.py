"""Tests for merge mode: matching heuristic + payload builder."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from hevy2garmin.merge import (
    MergeResult,
    attempt_merge,
    build_exercise_sets_payload,
    reset_circuit_breaker,
    _category_to_string,
    _exercise_to_string,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def _make_garmin_activity(
    activity_id: int = 12345,
    start: str = "2026-03-15 18:02:00",
    duration_s: float = 43 * 60,
    type_key: str = "strength_training",
) -> dict:
    return {
        "activityId": activity_id,
        "startTimeGMT": start,
        "startTimeLocal": start,
        "duration": duration_s,
        "activityType": {"typeKey": type_key},
    }


HEVY_WORKOUT = {
    "id": "test-123",
    "title": "Push",
    "start_time": "2026-03-15T18:00:00+00:00",
    "end_time": "2026-03-15T18:45:00+00:00",
    "exercises": [
        {
            "title": "Bench Press (Barbell)",
            "sets": [
                {"type": "warmup", "weight_kg": 40, "reps": 12},
                {"type": "normal", "weight_kg": 60, "reps": 10},
                {"type": "normal", "weight_kg": 60, "reps": 8},
            ],
        },
        {
            "title": "Shoulder Press (Dumbbell)",
            "sets": [
                {"type": "normal", "weight_kg": 14, "reps": 12},
                {"type": "normal", "weight_kg": 14, "reps": 10},
            ],
        },
    ],
}


# ---------------------------------------------------------------------------
# Matching heuristic tests
# ---------------------------------------------------------------------------

class TestFindMatchingActivity:

    def test_exact_overlap_matches(self):
        """Strength training with high overlap → match."""
        from hevy2garmin.garmin import find_matching_garmin_activity

        client = MagicMock()
        client.get_activities_by_date.return_value = [
            _make_garmin_activity(start="2026-03-15 18:02:00", duration_s=43 * 60),
        ]
        match = find_matching_garmin_activity(client, HEVY_WORKOUT)
        assert match is not None
        assert match["activityId"] == 12345

    def test_low_overlap_rejected(self):
        """Activity with only 50% overlap is below 70% threshold → no match."""
        from hevy2garmin.garmin import find_matching_garmin_activity

        client = MagicMock()
        # Activity starts 22 min late, only ~50% overlap with 45-min hevy workout
        client.get_activities_by_date.return_value = [
            _make_garmin_activity(start="2026-03-15 18:22:00", duration_s=23 * 60),
        ]
        match = find_matching_garmin_activity(client, HEVY_WORKOUT)
        assert match is None

    def test_wrong_type_rejected(self):
        """Running activity with perfect overlap → no match."""
        from hevy2garmin.garmin import find_matching_garmin_activity

        client = MagicMock()
        client.get_activities_by_date.return_value = [
            _make_garmin_activity(type_key="running"),
        ]
        match = find_matching_garmin_activity(client, HEVY_WORKOUT)
        assert match is None

    def test_incomplete_activity_rejected(self):
        """Activity still in progress (end time in future) → no match."""
        from datetime import datetime, timezone
        from hevy2garmin.garmin import find_matching_garmin_activity

        now = datetime.now(timezone.utc)
        # Activity started 10 min ago with a very long duration (still recording)
        recent_start = now.strftime("%Y-%m-%d %H:%M:%S")
        hevy_now = {
            **HEVY_WORKOUT,
            "start_time": now.isoformat(),
            "end_time": (now + __import__("datetime").timedelta(minutes=45)).isoformat(),
        }
        client = MagicMock()
        client.get_activities_by_date.return_value = [
            _make_garmin_activity(start=recent_start, duration_s=999999),
        ]
        match = find_matching_garmin_activity(client, hevy_now)
        assert match is None

    def test_best_of_multiple_candidates(self):
        """When multiple candidates overlap, pick the highest-scoring one."""
        from hevy2garmin.garmin import find_matching_garmin_activity

        client = MagicMock()
        client.get_activities_by_date.return_value = [
            _make_garmin_activity(activity_id=1, start="2026-03-15 18:10:00", duration_s=35 * 60),
            _make_garmin_activity(activity_id=2, start="2026-03-15 18:01:00", duration_s=44 * 60),
        ]
        match = find_matching_garmin_activity(client, HEVY_WORKOUT)
        assert match is not None
        assert match["activityId"] == 2  # Better overlap + closer start


# ---------------------------------------------------------------------------
# Payload builder tests
# ---------------------------------------------------------------------------

class TestBuildPayload:

    def test_payload_structure(self):
        """Payload has activityId and exerciseSets list."""
        payload = build_exercise_sets_payload(
            HEVY_WORKOUT,
            activity_id=12345,
            activity_start_time="2026-03-15 18:00:00",
            activity_duration_s=45 * 60,
        )
        assert payload["activityId"] == 12345
        assert isinstance(payload["exerciseSets"], list)
        assert len(payload["exerciseSets"]) > 0

    def test_active_and_rest_sets(self):
        """Payload contains both ACTIVE and REST sets."""
        payload = build_exercise_sets_payload(
            HEVY_WORKOUT,
            activity_id=12345,
            activity_start_time="2026-03-15 18:00:00",
            activity_duration_s=45 * 60,
        )
        types = {s["setType"] for s in payload["exerciseSets"]}
        assert "ACTIVE" in types
        assert "REST" in types

    def test_exercise_count_matches(self):
        """Number of ACTIVE sets matches total sets in Hevy workout."""
        payload = build_exercise_sets_payload(
            HEVY_WORKOUT,
            activity_id=12345,
            activity_start_time="2026-03-15 18:00:00",
            activity_duration_s=45 * 60,
        )
        active = [s for s in payload["exerciseSets"] if s["setType"] == "ACTIVE"]
        # 3 bench sets + 2 shoulder sets = 5
        assert len(active) == 5

    def test_weight_in_grams(self):
        """Weight is converted from kg to grams."""
        payload = build_exercise_sets_payload(
            HEVY_WORKOUT,
            activity_id=12345,
            activity_start_time="2026-03-15 18:00:00",
            activity_duration_s=45 * 60,
        )
        first_active = next(s for s in payload["exerciseSets"] if s["setType"] == "ACTIVE")
        assert first_active["weight"] == 40000  # 40 kg warmup = 40000 grams

    def test_wkt_step_index_groups_exercises(self):
        """wktStepIndex groups sets by exercise (0 for bench, 1 for shoulder)."""
        payload = build_exercise_sets_payload(
            HEVY_WORKOUT,
            activity_id=12345,
            activity_start_time="2026-03-15 18:00:00",
            activity_duration_s=45 * 60,
        )
        active = [s for s in payload["exerciseSets"] if s["setType"] == "ACTIVE"]
        bench_steps = {s["wktStepIndex"] for s in active[:3]}
        shoulder_steps = {s["wktStepIndex"] for s in active[3:]}
        assert bench_steps == {0}
        assert shoulder_steps == {1}

    def test_category_string_mapping(self):
        """Exercise categories are strings, not ints."""
        payload = build_exercise_sets_payload(
            HEVY_WORKOUT,
            activity_id=12345,
            activity_start_time="2026-03-15 18:00:00",
            activity_duration_s=45 * 60,
        )
        first_active = next(s for s in payload["exerciseSets"] if s["setType"] == "ACTIVE")
        assert first_active["exercises"][0]["category"] == "BENCH_PRESS"
        assert isinstance(first_active["exercises"][0]["name"], str)

    def test_empty_workout(self):
        """Workout with no exercises produces empty sets list."""
        workout = {**HEVY_WORKOUT, "exercises": []}
        payload = build_exercise_sets_payload(
            workout,
            activity_id=12345,
            activity_start_time="2026-03-15 18:00:00",
            activity_duration_s=45 * 60,
        )
        assert payload["exerciseSets"] == []


# ---------------------------------------------------------------------------
# Category string conversion tests
# ---------------------------------------------------------------------------

class TestCategoryConversion:

    def test_known_category(self):
        assert _category_to_string(0) == "BENCH_PRESS"
        assert _category_to_string(28) == "SQUAT"
        assert _category_to_string(23) == "ROW"

    def test_unknown_category(self):
        assert _category_to_string(65534) == "UNKNOWN"
        assert _category_to_string(9999) == "UNKNOWN"


# ---------------------------------------------------------------------------
# Integration: attempt_merge
# ---------------------------------------------------------------------------

class TestAttemptMerge:

    def setup_method(self):
        reset_circuit_breaker()

    @patch("hevy2garmin.merge.find_matching_garmin_activity")
    @patch("hevy2garmin.merge.get_activity_exercise_sets")
    @patch("hevy2garmin.merge.push_exercise_sets")
    @patch("hevy2garmin.merge.rename_activity")
    @patch("hevy2garmin.merge.set_description")
    def test_merge_path_taken(self, mock_desc, mock_rename, mock_push, mock_get_sets, mock_find):
        """When a match is found, PUT is called and result is merged=True."""
        mock_find.return_value = _make_garmin_activity()
        mock_get_sets.return_value = {"exerciseSets": []}
        mock_db = MagicMock()

        result = attempt_merge(MagicMock(), HEVY_WORKOUT, mock_db)

        assert result.merged is True
        assert result.activity_id == 12345
        mock_push.assert_called_once()
        mock_rename.assert_called_once()

    @patch("hevy2garmin.merge.find_matching_garmin_activity")
    def test_no_match_fallback(self, mock_find):
        """When no match, result is merged=False with reason."""
        mock_find.return_value = None
        mock_db = MagicMock()

        result = attempt_merge(MagicMock(), HEVY_WORKOUT, mock_db)

        assert result.merged is False
        assert "No matching" in result.fallback_reason

    @patch("hevy2garmin.merge.find_matching_garmin_activity")
    @patch("hevy2garmin.merge.get_activity_exercise_sets")
    @patch("hevy2garmin.merge.push_exercise_sets")
    def test_circuit_breaker_trips(self, mock_push, mock_get_sets, mock_find):
        """After 3 consecutive PUT failures, merge is disabled."""
        mock_find.return_value = _make_garmin_activity()
        mock_get_sets.return_value = {"exerciseSets": []}
        mock_push.side_effect = RuntimeError("PUT failed")
        mock_db = MagicMock()

        for _ in range(3):
            attempt_merge(MagicMock(), HEVY_WORKOUT, mock_db)

        # 4th attempt should be blocked by circuit breaker
        result = attempt_merge(MagicMock(), HEVY_WORKOUT, mock_db)
        assert result.merged is False
        assert "Circuit breaker" in result.fallback_reason


# ---------------------------------------------------------------------------
# Sync integration tests
# ---------------------------------------------------------------------------

class TestSyncIntegration:
    """Test merge mode wired into sync.py."""

    WORKOUTS = [
        {
            "id": "w1", "title": "Push",
            "start_time": "2026-03-15T18:00:00+00:00", "end_time": "2026-03-15T18:45:00+00:00",
            "updated_at": "2026-03-15T18:45:00+00:00",
            "exercises": [{"title": "Bench Press (Barbell)", "sets": [{"type": "normal", "weight_kg": 60, "reps": 8}]}],
        },
        {
            "id": "w2", "title": "Pull",
            "start_time": "2026-03-16T18:00:00+00:00", "end_time": "2026-03-16T18:45:00+00:00",
            "updated_at": "2026-03-16T18:45:00+00:00",
            "exercises": [{"title": "Bent Over Row (Barbell)", "sets": [{"type": "normal", "weight_kg": 50, "reps": 10}]}],
        },
    ]

    def _mock_hevy(self):
        h = MagicMock()
        h.get_workout_count.return_value = 2
        h.get_workouts.return_value = {"workouts": self.WORKOUTS, "page_count": 1}
        return h

    @patch("hevy2garmin.sync.db")
    @patch("hevy2garmin.sync.get_client")
    @patch("hevy2garmin.sync.HevyClient")
    @patch("hevy2garmin.sync.attempt_merge")
    def test_merge_on_both_match(self, mock_merge, mock_hevy_cls, mock_gclient, mock_db):
        """merge ON, both match → both use merge path."""
        mock_hevy_cls.return_value = self._mock_hevy()
        mock_gclient.return_value = MagicMock()
        mock_db.is_synced.return_value = False
        mock_merge.return_value = MergeResult(merged=True, activity_id=12345)

        from hevy2garmin.sync import sync
        stats = sync(config={"hevy_api_key": "t", "merge_mode": True}, limit=2)

        assert stats["merged"] == 2
        assert stats["merge_fallback"] == 0
        assert mock_merge.call_count == 2
        calls = mock_db.mark_synced.call_args_list
        assert all(c.kwargs.get("sync_method") == "merge" for c in calls)

    @patch("hevy2garmin.sync.db")
    @patch("hevy2garmin.sync.get_client")
    @patch("hevy2garmin.sync.HevyClient")
    @patch("hevy2garmin.sync.attempt_merge")
    @patch("hevy2garmin.sync.generate_fit", return_value={"exercises": 1, "total_sets": 1, "calories": 100, "avg_hr": 90})
    @patch("hevy2garmin.sync.upload_fit", return_value={"activity_id": 222})
    @patch("hevy2garmin.sync.find_activity_by_start_time", return_value=None)
    @patch("hevy2garmin.sync.rename_activity")
    @patch("hevy2garmin.sync.set_description")
    @patch("hevy2garmin.sync.generate_description", return_value="test")
    def test_merge_on_second_falls_back(self, *mocks):
        """merge ON, first matches, second doesn't → fallback to upload."""
        (mock_desc, mock_setdesc, mock_rename, mock_find, mock_upload,
         mock_fit, mock_merge, mock_hevy_cls, mock_gclient, mock_db) = mocks

        mock_hevy_cls.return_value = self._mock_hevy()
        mock_gclient.return_value = MagicMock()
        mock_db.is_synced.return_value = False
        call_count = [0]
        def alt(c, w, d, **kwargs):
            call_count[0] += 1
            return MergeResult(merged=True, activity_id=111) if call_count[0] == 1 else MergeResult(merged=False, fallback_reason="No match")
        mock_merge.side_effect = alt

        from hevy2garmin.sync import sync
        stats = sync(config={"hevy_api_key": "t", "merge_mode": True}, limit=2)

        assert stats["merged"] == 1
        assert stats["merge_fallback"] == 1
        calls = mock_db.mark_synced.call_args_list
        assert calls[0].kwargs.get("sync_method") == "merge"
        assert calls[1].kwargs.get("sync_method") == "upload_fallback"

    @patch("hevy2garmin.sync.db")
    @patch("hevy2garmin.sync.get_client")
    @patch("hevy2garmin.sync.HevyClient")
    @patch("hevy2garmin.sync.attempt_merge")
    @patch("hevy2garmin.sync.generate_fit", return_value={"exercises": 1, "total_sets": 1, "calories": 100, "avg_hr": 90})
    @patch("hevy2garmin.sync.upload_fit", return_value={"activity_id": 333})
    @patch("hevy2garmin.sync.find_activity_by_start_time", return_value=None)
    @patch("hevy2garmin.sync.rename_activity")
    @patch("hevy2garmin.sync.set_description")
    @patch("hevy2garmin.sync.generate_description", return_value="test")
    def test_merge_off_normal_upload(self, *mocks):
        """merge OFF → normal upload, merge never attempted."""
        (mock_desc, mock_setdesc, mock_rename, mock_find, mock_upload,
         mock_fit, mock_merge, mock_hevy_cls, mock_gclient, mock_db) = mocks

        mock_hevy_cls.return_value = self._mock_hevy()
        mock_gclient.return_value = MagicMock()
        mock_db.is_synced.return_value = False

        from hevy2garmin.sync import sync
        stats = sync(config={"hevy_api_key": "t", "merge_mode": False}, limit=2)

        assert stats["merged"] == 0
        assert mock_merge.call_count == 0
        calls = mock_db.mark_synced.call_args_list
        assert all(c.kwargs.get("sync_method") == "upload" for c in calls)
