"""Abstract database interface for hevy2garmin."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class NoWritableDatabaseError(RuntimeError):
    """No Postgres URL is set and the local SQLite fallback cannot be written.

    Happens on serverless deploys (Vercel/Lambda) where the home filesystem is
    read-only and no database has been attached. Handlers catch this to show an
    actionable "add a database" message instead of a raw 500 (#145, #142).
    """


class Database(ABC):
    """Abstract base class for workout sync storage."""

    @abstractmethod
    def is_synced(self, hevy_id: str) -> bool:
        """Check if a Hevy workout has already been synced."""

    @abstractmethod
    def get_garmin_id(self, hevy_id: str) -> str | None:
        """Get the Garmin activity ID for a synced workout."""

    @abstractmethod
    def known_garmin_activity_ids(self, exclude_hevy_id: str | None = None) -> set[str]:
        """Return every Garmin activity id the ledger already maps to a workout.

        Covers both finished syncs and in-flight uploads. ``exclude_hevy_id``
        drops the id belonging to that one Hevy workout, so a workout's own
        prior upload is never treated as a sibling's. Used to stop a later
        workout's start-time lookup from claiming an activity that already
        belongs to a different Hevy workout (#796).
        """

    @abstractmethod
    def mark_synced(
        self,
        hevy_id: str,
        garmin_activity_id: str | None = None,
        title: str = "",
        calories: int | None = None,
        avg_hr: int | None = None,
        hevy_updated_at: str | None = None,
        sync_method: str = "upload",
    ) -> None:
        """Record a successfully synced workout."""

    @abstractmethod
    def get_stale_synced(self, workouts: list[dict]) -> list[str]:
        """Return hevy_ids of synced workouts edited on Hevy since sync."""

    @abstractmethod
    def get_synced_count(self) -> int:
        """Get total number of synced workouts."""

    @abstractmethod
    def get_recent_synced(self, limit: int = 10) -> list[dict]:
        """Get recently synced workouts."""

    @abstractmethod
    def record_sync_log(
        self,
        synced: int = 0,
        skipped: int = 0,
        failed: int = 0,
        trigger: str = "manual",
    ) -> None:
        """Persist a sync run result."""

    @abstractmethod
    def get_sync_log(self, limit: int = 20) -> list[dict]:
        """Get recent sync log entries."""

    @abstractmethod
    def get_cached_hr(self, hevy_id: str) -> dict | None:
        """Get cached HR data for a workout. Returns None if not cached."""

    @abstractmethod
    def cache_hr(self, hevy_id: str, data: dict) -> None:
        """Cache HR data for a workout."""

    @abstractmethod
    def unsync(self, hevy_id: str) -> bool:
        """Remove a sync record. Returns True if a record was deleted."""

    @abstractmethod
    def unsync_all(self) -> int:
        """Remove all sync records. Returns count of deleted records."""

    @abstractmethod
    def get_app_config(self, key: str) -> dict | None:
        """Get a JSON value from the generic key-value app cache."""

    @abstractmethod
    def set_app_config(self, key: str, value: dict) -> None:
        """Store a JSON value in the generic key-value app cache."""

    @abstractmethod
    def claim_pending(self, hevy_id: str, payload: dict[str, Any]) -> bool:
        """Atomically claim submission authority for a workout."""

    @abstractmethod
    def get_pending(self, hevy_id: str) -> dict | None:
        """Return one unfinished upload operation."""

    @abstractmethod
    def list_pending(self) -> list[dict]:
        """Return unfinished upload operations, newest first."""

    @abstractmethod
    def update_pending(self, hevy_id: str, **changes: Any) -> None:
        """Persist selected pending-operation fields."""

    @abstractmethod
    def delete_pending(self, hevy_id: str) -> bool:
        """Abandon an unfinished operation."""

    @abstractmethod
    def complete_pending(self, hevy_id: str, terminal: dict[str, Any]) -> None:
        """Atomically upsert terminal state and remove pending state."""

    @abstractmethod
    def resolve_terminal(
        self,
        hevy_id: str,
        *,
        status: str,
        garmin_activity_id: str | None = None,
        reason: str | None = None,
        source: str | None = None,
    ) -> None:
        """Atomically create a manual/skipped terminal state and clear pending."""

    @abstractmethod
    def get_workout_states(self, hevy_ids: list[str]) -> dict[str, dict]:
        """Batch-fetch terminal and pending state with terminal precedence."""

    @abstractmethod
    def get_terminal_counts(self) -> dict[str, int]:
        """Return uploaded, manual, skipped, and total terminal counts."""

    # ── Routine → Garmin planned-workout tracking ───────────────────────────
    @abstractmethod
    def get_synced_routine(self, hevy_routine_id: str) -> dict | None:
        """Return the sync record for a Hevy routine, or None if never synced."""

    @abstractmethod
    def list_synced_routines(self) -> list[dict]:
        """Return every routine sync record (same keys as :meth:`get_synced_routine`)."""

    @abstractmethod
    def set_routine_status(self, hevy_routine_id: str, status: str) -> None:
        """Update only the status of a routine sync record.

        Leaves every other field (including ``synced_at``) untouched — used by
        reconciliation to flag ``missing_on_garmin`` / restore ``success`` without
        clobbering the recorded hash or sync time. No-op for unknown ids.
        """

    @abstractmethod
    def is_routine_synced(self, hevy_routine_id: str, hevy_updated_at: str | None = None) -> bool:
        """True if the routine was synced and (if given) not edited on Hevy since."""

    @abstractmethod
    def mark_routine_synced(
        self,
        hevy_routine_id: str,
        garmin_workout_id: str | None = None,
        title: str = "",
        hevy_updated_at: str | None = None,
        scheduled_date: str | None = None,
        content_hash: str | None = None,
        status: str = "success",
    ) -> None:
        """Record a routine synced to a Garmin planned workout.

        ``status="schedule_pending"`` marks a workout that was created on Garmin
        but whose calendar scheduling hasn't been confirmed yet, so the next sync
        retries it instead of skipping the routine as already done.
        ``status="missing_on_garmin"`` (set via :meth:`set_routine_status`) marks a
        workout that no longer exists on Garmin (deleted by the user there); any
        non-``success`` status defeats the unchanged-hash skip, so a sync recreates it.
        """

    @abstractmethod
    def delete_synced_routine(self, hevy_routine_id: str) -> bool:
        """Remove a routine sync record (and its calendar entries). True if deleted."""

    @abstractmethod
    def add_routine_schedule(
        self, hevy_routine_id: str, schedule_id: str, scheduled_date: str | None = None
    ) -> None:
        """Record a Garmin calendar entry (``workoutScheduleId``) for a routine."""

    @abstractmethod
    def get_routine_schedule_ids(self, hevy_routine_id: str) -> list[str]:
        """Return the Garmin calendar entry ids currently booked for a routine."""

    @abstractmethod
    def get_routine_scheduled_dates(self, hevy_routine_id: str) -> list[str]:
        """Return the distinct dates (ISO) a routine currently has booked, ascending."""

    @abstractmethod
    def clear_routine_schedules(self, hevy_routine_id: str) -> None:
        """Drop all tracked calendar entries for a routine (after unscheduling them)."""

    @abstractmethod
    def delete_routine_schedule(self, hevy_routine_id: str, schedule_id: str) -> bool:
        """Drop one tracked calendar entry. Returns True if a row was removed."""

    @abstractmethod
    def get_upcoming_routine_schedules(
        self, on_or_after: str, limit: int, offset: int, title_query: str | None = None
    ) -> list[dict]:
        """Return scheduled calendar entries on/after ``on_or_after`` (ISO date), with
        the routine title, ordered by date. Paginated via ``limit``/``offset``.

        ``title_query`` (optional) filters to routines whose title contains it
        (case-insensitive substring). Each dict has ``hevy_routine_id``,
        ``schedule_id``, ``scheduled_date``, ``title``.
        """

    @abstractmethod
    def count_upcoming_routine_schedules(
        self, on_or_after: str, title_query: str | None = None
    ) -> int:
        """Count scheduled entries on/after ``on_or_after`` (optionally filtered by
        ``title_query``), for pagination."""

    @abstractmethod
    def get_routine_stats(self) -> dict:
        """Return routine sync counts: ``{"synced": int, "scheduled": int}``."""

    @abstractmethod
    def get_recent_synced_routines(self, limit: int = 5) -> list[dict]:
        """Return recently synced routines, newest first."""
