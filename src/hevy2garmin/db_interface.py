"""Abstract database interface for hevy2garmin."""

from __future__ import annotations

from abc import ABC, abstractmethod


class Database(ABC):
    """Abstract base class for workout sync storage."""

    @abstractmethod
    def is_synced(self, hevy_id: str) -> bool:
        """Check if a Hevy workout has already been synced."""

    @abstractmethod
    def get_garmin_id(self, hevy_id: str) -> str | None:
        """Get the Garmin activity ID for a synced workout."""

    @abstractmethod
    def mark_synced(
        self,
        hevy_id: str,
        garmin_activity_id: str | None = None,
        title: str = "",
        calories: int | None = None,
        avg_hr: int | None = None,
    ) -> None:
        """Record a successfully synced workout."""

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
