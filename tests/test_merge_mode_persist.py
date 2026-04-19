"""Tests for merge_mode toggle persistence through settings form and config loader."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

from hevy2garmin.config import load_config, save_config


class TestMergeModeFilePersistence:
    """Verify merge_mode round-trips through config file (local deployments)."""

    def test_merge_mode_false_persists(self, tmp_path: Path) -> None:
        config_file = tmp_path / "config.json"
        with patch("hevy2garmin.config.CONFIG_DIR", tmp_path), \
             patch("hevy2garmin.config.CONFIG_FILE", config_file):
            config = load_config()
            config["merge_mode"] = False
            save_config(config)

            reloaded = load_config()
            assert reloaded["merge_mode"] is False

    def test_merge_mode_true_persists(self, tmp_path: Path) -> None:
        config_file = tmp_path / "config.json"
        with patch("hevy2garmin.config.CONFIG_DIR", tmp_path), \
             patch("hevy2garmin.config.CONFIG_FILE", config_file):
            config = load_config()
            config["merge_mode"] = True
            save_config(config)

            reloaded = load_config()
            assert reloaded["merge_mode"] is True

    def test_merge_mode_default_true_when_absent(self, tmp_path: Path) -> None:
        """Without merge_mode saved, config.get('merge_mode', True) returns True."""
        with patch("hevy2garmin.config.CONFIG_FILE", tmp_path / "missing.json"):
            config = load_config()
            assert config.get("merge_mode", True) is True


class TestMergeModeDbPersistence:
    """Verify merge_mode is loaded from DB merge_settings (cloud deployments)."""

    def _make_db_loader(self, app_cache_rows: list[dict]):
        """Return a patched load_config that simulates DB app_cache rows.

        Each row dict: {"key": "...", "value": {...}}
        The mock replaces the Postgres cursor that load_config queries.
        """
        class FakeCursor:
            def __init__(self, rows):
                self._rows = rows
                self._result = []

            def execute(self, sql, params=None):
                if "app_cache" in sql and "key IN" in sql:
                    self._result = self._rows
                else:
                    self._result = []

            def fetchall(self):
                return self._result

            def fetchone(self):
                return self._result[0] if self._result else None

            def __enter__(self):
                return self

            def __exit__(self, *a):
                pass

        class FakeConn:
            def __init__(self, rows):
                self._rows = rows

            def cursor(self):
                return FakeCursor(self._rows)

            def __enter__(self):
                return self

            def __exit__(self, *a):
                pass

        class FakeDb:
            def __init__(self, rows):
                self._rows = rows

            def _get_conn(self):
                return FakeConn(self._rows)

        return FakeDb(app_cache_rows)

    def _patch_db(self, tmp_path, fake_db):
        """Context manager stack to patch config file + DB layer for load_config."""
        from contextlib import ExitStack
        stack = ExitStack()
        stack.enter_context(patch("hevy2garmin.config.CONFIG_FILE", tmp_path / "missing.json"))
        stack.enter_context(patch("hevy2garmin.db.get_database_url", return_value="postgres://fake"))
        stack.enter_context(patch("hevy2garmin.db.get_db", return_value=fake_db))
        return stack

    def test_merge_mode_false_loaded_from_db(self, tmp_path: Path) -> None:
        fake_db = self._make_db_loader([
            {"key": "merge_settings", "value": {"merge_mode": False, "description_enabled": True,
                                                  "merge_overlap_pct": 70, "merge_max_drift_min": 20}},
        ])

        with self._patch_db(tmp_path, fake_db):
            config = load_config()
            assert config.get("merge_mode", True) is False

    def test_merge_mode_true_loaded_from_db(self, tmp_path: Path) -> None:
        fake_db = self._make_db_loader([
            {"key": "merge_settings", "value": {"merge_mode": True, "description_enabled": True,
                                                  "merge_overlap_pct": 70, "merge_max_drift_min": 20}},
        ])

        with self._patch_db(tmp_path, fake_db):
            config = load_config()
            assert config.get("merge_mode", True) is True

    def test_all_merge_settings_unpacked(self, tmp_path: Path) -> None:
        fake_db = self._make_db_loader([
            {"key": "merge_settings", "value": {"merge_mode": False, "description_enabled": False,
                                                  "merge_overlap_pct": 85, "merge_max_drift_min": 30}},
        ])

        with self._patch_db(tmp_path, fake_db):
            config = load_config()
            assert config["merge_mode"] is False
            assert config["description_enabled"] is False
            assert config["merge_overlap_pct"] == 85
            assert config["merge_max_drift_min"] == 30
