"""Hevy API v1 client with retry and rate limiting."""

from __future__ import annotations

import logging
import os
import time

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

logger = logging.getLogger("hevy2garmin")


class HevyAuthError(Exception):
    """Raised when the Hevy API rejects the API key (401/403)."""

DEFAULT_BASE_URL = "https://api.hevyapp.com/v1"
API_CALL_DELAY = 0.5


class HevyClient:
    """HTTP client for the Hevy API v1."""

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
    ) -> None:
        self.base_url = (base_url or os.environ.get("HEVY_API_KEY_URL", DEFAULT_BASE_URL)).rstrip("/")
        key = api_key or os.environ.get("HEVY_API_KEY", "")
        if not key:
            raise ValueError("Hevy API key required. Pass api_key= or set HEVY_API_KEY env var.")

        self.session = requests.Session()
        self.session.headers.update({
            "api-key": key,
            "Accept": "application/json",
        })
        retry = Retry(
            total=5,
            backoff_factor=2,
            status_forcelist=[429, 500, 502, 503, 504],
            allowed_methods=["GET"],
            raise_on_status=False,
        )
        self.session.mount("https://", HTTPAdapter(max_retries=retry))

    def _get(self, path: str, params: dict | None = None) -> dict:
        """Make a GET request with rate limiting."""
        url = f"{self.base_url}{path}"
        resp = self.session.get(url, params=params, timeout=30)
        if resp.status_code in (401, 403):
            raise HevyAuthError(
                "Hevy API key is invalid or expired. "
                "Check your Hevy Pro subscription and regenerate the key at hevy.com/settings."
            )
        resp.raise_for_status()
        # Log rate-limit headers when approaching the limit
        remaining = resp.headers.get("X-RateLimit-Remaining") or resp.headers.get("x-ratelimit-remaining")
        if remaining is not None:
            try:
                rem = int(remaining)
                if rem < 10:
                    logger.warning("Hevy API rate limit low: %d requests remaining", rem)
            except ValueError:
                pass
        time.sleep(API_CALL_DELAY)
        return resp.json()

    def get_workout_count(self) -> int:
        """Get total number of workouts."""
        data = self._get("/workouts/count")
        return data["workout_count"]

    def get_workouts(self, page: int = 1, page_size: int = 10) -> dict:
        """Get a page of workouts."""
        return self._get("/workouts", {"page": page, "pageSize": page_size})

    def get_all_workouts(self, since_page: int = 1, page_size: int = 10) -> list[dict]:
        """Fetch all workouts (paginated). Returns list of workout dicts."""
        all_workouts: list[dict] = []
        page = since_page
        while True:
            data = self.get_workouts(page, page_size)
            workouts = data.get("workouts", [])
            all_workouts.extend(workouts)
            logger.info("  Page %d/%d — %d workouts", page, data.get("page_count", "?"), len(workouts))
            if page >= data.get("page_count", page):
                break
            page += 1
        return all_workouts

    def get_routines(self, page: int = 1, page_size: int = 10) -> dict:
        """Get a page of routines."""
        return self._get("/routines", {"page": page, "pageSize": page_size})

    def get_routine_folders(self, page: int = 1, page_size: int = 10) -> dict:
        """Get a page of routine folders."""
        return self._get("/routine_folders", {"page": page, "pageSize": page_size})

    def get_exercise_templates(self, page: int = 1, page_size: int = 10) -> dict:
        """Get a page of exercise templates."""
        return self._get("/exercise_templates", {"page": page, "pageSize": page_size})

    def get_workout_events(self, since: str, page: int = 1, page_size: int = 10) -> dict:
        """Get workout events since a timestamp (ISO 8601) for incremental sync."""
        return self._get("/workouts/events", {"since": since, "page": page, "pageSize": page_size})
