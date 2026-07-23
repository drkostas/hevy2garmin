"""Tests for configuration system."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from hevy2garmin.config import (
    DEFAULT_CONFIG,
    is_configured,
    load_config,
    save_config,
)


@pytest.fixture(autouse=True)
def _local_mode(monkeypatch):
    """File-based config tests run in local mode (no DB autodetect).

    The Postgres CI job sets DATABASE_URL globally; without this, save_config
    would write to the shared test DB and pollute later load_config() reads.
    Cloud-specific tests opt back in by patching get_database_url/get_db.
    """
    for var in ("DATABASE_URL", "POSTGRES_URL", "STORAGE_URL", "NEON_DATABASE_URL"):
        monkeypatch.delenv(var, raising=False)
    import hevy2garmin.db as _db

    _db.reset()


class TestLoadConfig:
    def test_returns_defaults_when_no_file(self, tmp_path: Path) -> None:
        with patch("hevy2garmin.config.CONFIG_FILE", tmp_path / "missing.json"):
            config = load_config()
            assert config["user_profile"]["weight_kg"] == 80.0
            assert config["timing"]["working_set_seconds"] == 40

    def test_save_load_roundtrip(self, tmp_path: Path) -> None:
        config_file = tmp_path / "config.json"
        with patch("hevy2garmin.config.CONFIG_DIR", tmp_path), \
             patch("hevy2garmin.config.CONFIG_FILE", config_file):
            original = load_config()
            original["hevy_api_key"] = "test-key-123"
            original["user_profile"]["weight_kg"] = 75.5
            save_config(original)

            loaded = load_config()
            assert loaded["hevy_api_key"] == "test-key-123"
            assert loaded["user_profile"]["weight_kg"] == 75.5

    def test_deep_merge_preserves_defaults(self, tmp_path: Path) -> None:
        config_file = tmp_path / "config.json"
        # Save partial config (missing timing)
        config_file.write_text(json.dumps({"hevy_api_key": "key", "user_profile": {"weight_kg": 90}}))

        with patch("hevy2garmin.config.CONFIG_FILE", config_file):
            config = load_config()
            assert config["hevy_api_key"] == "key"
            assert config["user_profile"]["weight_kg"] == 90
            # Defaults preserved for unset values
            assert config["user_profile"]["birth_year"] == 1990
            assert config["timing"]["working_set_seconds"] == 40

    def test_corrupt_file_returns_defaults(self, tmp_path: Path) -> None:
        config_file = tmp_path / "config.json"
        config_file.write_text("{corrupt json!!!")

        with patch("hevy2garmin.config.CONFIG_FILE", config_file):
            config = load_config()
            assert config["user_profile"]["weight_kg"] == 80.0

    def test_strips_whitespace_from_credentials(self, tmp_path: Path) -> None:
        # A stray leading/trailing newline on a pasted credential (#257) is
        # normalized on read, so it can't break the API call and an existing bad
        # value self-heals on the next load.
        config_file = tmp_path / "config.json"
        config_file.write_text(json.dumps({
            "hevy_api_key": "  abc123\n",
            "garmin_email": "\tuser@example.com ",
            "garmin_password": " pw ",
        }))
        with patch("hevy2garmin.config.CONFIG_FILE", config_file):
            config = load_config()
            assert config["hevy_api_key"] == "abc123"
            assert config["garmin_email"] == "user@example.com"
            assert config["garmin_password"] == "pw"


class TestIsConfigured:
    def test_false_without_api_key(self, tmp_path: Path) -> None:
        with patch("hevy2garmin.config.CONFIG_FILE", tmp_path / "missing.json"):
            assert is_configured() is False

    def test_true_with_api_key(self, tmp_path: Path, monkeypatch) -> None:
        config_file = tmp_path / "config.json"
        config_file.write_text(json.dumps({"hevy_api_key": "some-key"}))

        # When DATABASE_URL is set, is_configured also checks for Garmin tokens.
        # Clear it so this test only validates the API key check.
        monkeypatch.delenv("DATABASE_URL", raising=False)

        with patch("hevy2garmin.config.CONFIG_FILE", config_file):
            assert is_configured() is True

    def test_false_with_empty_api_key(self, tmp_path: Path) -> None:
        config_file = tmp_path / "config.json"
        config_file.write_text(json.dumps({"hevy_api_key": ""}))

        with patch("hevy2garmin.config.CONFIG_FILE", config_file):
            assert is_configured() is False


class TestSaveConfigCloud:
    """save_config must persist settings to the DB on cloud deployments (#139, #145).

    The home filesystem is read-only on serverless, so a file-only write
    silently lost profile/timing/hr_fusion changes (e.g. Pull-from-Garmin),
    which then reverted to defaults on the next stateless invocation.
    """

    def test_persists_app_keys_to_db_on_cloud(self, tmp_path: Path) -> None:
        fake_db = MagicMock()
        cfg = {
            "user_profile": {"weight_kg": 82.0, "birth_year": 1994, "sex": "male"},
            "timing": {"working_set_seconds": 45},
            "hr_fusion": {"enabled": True},
        }
        with patch("hevy2garmin.config.CONFIG_DIR", tmp_path), \
             patch("hevy2garmin.config.CONFIG_FILE", tmp_path / "config.json"), \
             patch("hevy2garmin.db.get_database_url", return_value="postgresql://x"), \
             patch("hevy2garmin.db.get_db", return_value=fake_db):
            save_config(cfg)

        written = {c.args[0]: c.args[1] for c in fake_db.set_app_config.call_args_list}
        assert set(written) == {"user_profile", "timing", "hr_fusion"}
        assert written["user_profile"]["weight_kg"] == 82.0

    def test_no_db_write_when_local(self, tmp_path: Path) -> None:
        fake_db = MagicMock()
        with patch("hevy2garmin.config.CONFIG_DIR", tmp_path), \
             patch("hevy2garmin.config.CONFIG_FILE", tmp_path / "config.json"), \
             patch("hevy2garmin.db.get_database_url", return_value=None), \
             patch("hevy2garmin.db.get_db", return_value=fake_db):
            save_config({"user_profile": {"weight_kg": 80.0}})
        fake_db.set_app_config.assert_not_called()

    def test_db_failure_does_not_raise(self, tmp_path: Path) -> None:
        fake_db = MagicMock()
        fake_db.set_app_config.side_effect = RuntimeError("db down")
        with patch("hevy2garmin.config.CONFIG_DIR", tmp_path), \
             patch("hevy2garmin.config.CONFIG_FILE", tmp_path / "config.json"), \
             patch("hevy2garmin.db.get_database_url", return_value="postgresql://x"), \
             patch("hevy2garmin.db.get_db", return_value=fake_db):
            # Must not propagate — settings save should never 500 on a DB hiccup
            save_config({"user_profile": {"weight_kg": 80.0}})


def test_default_has_grace_period() -> None:
    """DEFAULT_CONFIG must include sync.grace_period_minutes."""
    assert DEFAULT_CONFIG["sync"]["grace_period_minutes"] == 120
