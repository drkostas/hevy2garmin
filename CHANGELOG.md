# Changelog

All notable changes to hevy2garmin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0]

### Added
- **Unsync tools** ([#40](https://github.com/drkostas/hevy2garmin/issues/40)) — API (`POST /api/unsync/{id}`), dashboard "Unsync" button, and CLI (`hevy2garmin unsync`) to remove sync records and re-sync workouts. Includes optional Garmin activity deletion.
- **Edit detection** ([#56](https://github.com/drkostas/hevy2garmin/issues/56)) — detects workouts edited on Hevy after sync. Shows "Edited on Hevy" badge on the workouts page with a one-click "Re-sync" button that deletes the old Garmin activity and uploads fresh.
- **Auto-sync UX overhaul** ([#4](https://github.com/drkostas/hevy2garmin/issues/4)) — loading indicator on toggle, parallel GitHub API calls (~3x faster setup), workflow cron derives from the selected interval.
- **Workouts page DB cache** ([#3](https://github.com/drkostas/hevy2garmin/issues/3)) — zero Hevy API calls on warm loads. `app_cache` table added to SQLite for parity with Postgres.
- **Endpoint auth** ([#84](https://github.com/drkostas/hevy2garmin/issues/84)) — `POST /api/*` endpoints check `HEVY2GARMIN_SECRET` env var via cookie (auto-set on page load) or `X-Api-Key` header. Local dev unaffected (no secret = no auth).
- **Cardio exercise support** ([#83](https://github.com/drkostas/hevy2garmin/issues/83)) — FIT generator uses `duration_seconds` from sets for treadmill/bike/isometric exercises. Description shows distance and duration ("Treadmill: 1 set · 5.0km · 30min").
- **Hevy API key expiry handling** ([#59](https://github.com/drkostas/hevy2garmin/issues/59)) — detects 401/403 from Hevy, shows "API key expired" with link to setup. Auto-sync disables itself on auth failure (persists to DB on Vercel).
- Comprehensive edge case test suite: 118 tests (was 77).
- `CHANGELOG.md`, `CONTRIBUTING.md` with release process docs.

### Fixed
- **Wrong activity match** ([#36](https://github.com/drkostas/hevy2garmin/issues/36)) — removed the dangerous `get_activities[0]` fallback that grabbed unrelated Garmin activities (bike rides, runs) during rapid sync. Now matches only by start time, only strength training activities, with 3 retries at 3s/5s/10s.
- **Duplicate uploads on retry** ([#44](https://github.com/drkostas/hevy2garmin/issues/44)) — checks Garmin for existing activity before uploading. Prevents duplicates when a prior sync crashed between upload and DB write.
- **Concurrent sync race condition** ([#50](https://github.com/drkostas/hevy2garmin/issues/50)) — `_sync_executing` lock prevents simultaneous syncs. All sync entry points covered. 5-minute timeout auto-releases hung locks.
- **Dedup blocks re-sync** ([#66](https://github.com/drkostas/hevy2garmin/issues/66)) — re-sync now uses `force=1` to bypass dedup check. Deletes old Garmin activity before uploading fresh.
- **Activity type filter** ([#74](https://github.com/drkostas/hevy2garmin/issues/74)) — `find_activity_by_start_time` skips non-strength activities to prevent false-positive dedup matches.
- **Timestamp crash** ([#82](https://github.com/drkostas/hevy2garmin/issues/82)) — `_parse_timestamp` returns None on null/empty/malformed input instead of crashing. `generate_fit` raises clear `ValueError`.
- **Timestamp comparison** ([#76](https://github.com/drkostas/hevy2garmin/issues/76)) — stale workout detection parses timestamps via `datetime.fromisoformat` instead of string comparison. Handles Z vs +00:00 correctly.
- Warmup-only exercises now show in descriptions ("2 warmup sets") instead of being silently skipped.
- Singular/plural grammar: "1 set" not "1 sets".

## [0.1.2]

### Added
- **Proactive EU upload consent detection** ([#1](https://github.com/drkostas/hevy2garmin/issues/1)) — detect the 412 EU consent error, show clear remediation instructions.
- **Fixed workout names on first 25 synced workouts** ([#2](https://github.com/drkostas/hevy2garmin/issues/2)) — activity ID lookup retries with backoff, uses `startTimeGMT` for matching.
- Public API surface for soma integration.

### Removed
- `debug_error` field from sync responses.
- Unprotected `/api/reset-sync` endpoint.

## [0.1.1]

### Added
- First PyPI release.
- DB-backed settings, mappings, and cached Hevy count.
- Connection reuse and pooled URL priority for faster cold starts on serverless.

### Fixed
- Auto-sync toggle was sending inverted enabled state.
- Dashboard crash on sync log datetime parsing.

## [0.1.0]

### Added
- Initial package: Hevy → Garmin workout sync with real exercise names mapped from 433 exercises, per-exercise HR from Garmin daily monitoring, FIT file generation, activity rename, rich text description, image upload.
- CLI (`hevy2garmin sync`, `backfill`, `status`).
- Web dashboard (FastAPI + HTMX): setup wizard, workouts page, mappings editor, settings.
- One-click Vercel + Neon deploy with browser-based Garmin auth via Cloudflare Worker proxy.
- Auto-sync via GitHub Actions cron.

[Unreleased]: https://github.com/drkostas/hevy2garmin/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/drkostas/hevy2garmin/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/drkostas/hevy2garmin/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/drkostas/hevy2garmin/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/drkostas/hevy2garmin/releases/tag/v0.1.0
