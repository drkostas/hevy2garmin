# Changelog

All notable changes to hevy2garmin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Auto-sync UX overhaul** ([#4](https://github.com/drkostas/hevy2garmin/issues/4), [#16](https://github.com/drkostas/hevy2garmin/pull/16)) — loading indicator on toggle, parallel GitHub API calls cut setup time from ~6s to ~2-3s, workflow cron now derives from the selected interval (was hardcoded `0 */2 * * *`)
- **Workouts page DB cache** ([#3](https://github.com/drkostas/hevy2garmin/issues/3), [#15](https://github.com/drkostas/hevy2garmin/pull/15)) — `/workouts` reads from `app_cache` populated during sync, zero outbound Hevy API calls on warm loads. Added `app_cache` table to SQLite for parity with Postgres.
- Abstract `get_app_config` / `set_app_config` on the `Database` interface (both backends must implement).

## [0.1.2]

### Added
- **Proactive EU upload consent detection** ([#1](https://github.com/drkostas/hevy2garmin/issues/1), [#14](https://github.com/drkostas/hevy2garmin/pull/14)) — detect the 412 EU consent error, show clear remediation instructions linking to Garmin Connect Settings → Data → Device Upload, and warn users after Garmin auth during setup.
- **Fixed workout names on first 25 synced workouts** ([#2](https://github.com/drkostas/hevy2garmin/issues/2), [#13](https://github.com/drkostas/hevy2garmin/pull/13)) — activity ID lookup now retries with 3s/5s backoff and uses `startTimeGMT` instead of `startTimeLocal` to avoid timezone-offset mismatches.
- Public API surface for the soma integration (stable entry points for `HevyClient`, `lookup_exercise`, `generate_fit`, `upload_fit`, rename + description helpers).
- Failed workouts skip during the current session but retry on the next run, instead of being permanently marked as failed.

### Removed
- `debug_error` field from sync responses.
- Unprotected `/api/reset-sync` endpoint.

## [0.1.1]

### Added
- First PyPI release.
- DB-backed settings, mappings, and cached Hevy count.
- Connection reuse and pooled URL priority for faster cold starts on serverless.
- Per-page caching that eliminated Hevy API calls on most dashboard loads.

### Fixed
- Auto-sync toggle was sending inverted enabled state.
- Dashboard crash on sync log datetime parsing.
- Activity rename worked; setup-actions now creates `sync.yml` workflow.
- Toggling auto-sync off deletes the sync workflow to stop the cron.

## [0.1.0]

### Added
- Initial package: Hevy → Garmin workout sync with real exercise names mapped from 433 exercises, per-exercise HR from Garmin daily monitoring, FIT file generation, activity rename, rich text description, image upload.
- CLI (`hevy2garmin sync`, `backfill`, `status`).
- Web dashboard (FastAPI + HTMX): setup wizard, workouts page, mappings editor, settings.
- One-click Vercel + Neon deploy with browser-based Garmin auth via Cloudflare Worker proxy.
- Auto-sync via GitHub Actions cron (toggle creates/deletes `sync.yml`).

[Unreleased]: https://github.com/drkostas/hevy2garmin/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/drkostas/hevy2garmin/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/drkostas/hevy2garmin/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/drkostas/hevy2garmin/releases/tag/v0.1.0
