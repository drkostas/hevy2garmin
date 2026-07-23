# Changelog

All notable changes to hevy2garmin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.2] - 2026-07-23

### Fixed
- Credentials with leading or trailing whitespace (a pasted newline is the classic case) no longer break sync ([#257](https://github.com/drkostas/hevy2garmin/issues/257)). The Hevy API key, Garmin email and password are normalized on read, so a stray newline can't break the API call and an existing bad value already stored in the database is cleaned automatically on the next load. On the Vercel deploy the stored value takes precedence over the environment variable, so this also fixes the case where a bad key couldn't be cleared by editing the env var.

## [0.6.1] - 2026-07-23

### Added
- A Scheduled Workouts table on the Routines page ([#254](https://github.com/drkostas/hevy2garmin/pull/254), thanks @bcandido). See every upcoming scheduled routine (date and routine name) in one place, filter by start date or name, choose the page size, and remove an entry with one click, which also unschedules it on Garmin. The table reads from the local database, so it still renders even if the Hevy fetch is unavailable.

### Fixed
- Re-scheduling a routine no longer stacks duplicate entries on the Garmin calendar ([#254](https://github.com/drkostas/hevy2garmin/pull/254), thanks @bcandido). Garmin appends a fresh calendar entry on every schedule call with no server-side dedup, so the tool now tracks the schedule id Garmin returns and unschedules the prior entries before booking new dates, making re-scheduling idempotent.
- Routine sync now reconciles against the actual Garmin workout library before creating, so a database reset (ephemeral cloud storage, a migration) or a crash in the create→persist window no longer duplicates planned workouts. Before creating a routine's workout, a same-named workout already in the Garmin library is deleted and recreated instead of stacking a second copy — making routine sync self-healing across DB loss and mid-run failures. To stay safe, reconciliation only ever deletes a workout carrying hevy2garmin's provenance marker (now embedded in every synced routine's description), so a workout you built by hand in Garmin that happens to share a routine's title is never touched. The listing is best-effort: if it fails, sync falls back to the previous DB-only dedup.

## [0.6.0] - 2026-07-20

### Fixed
- Routine sync no longer risks a duplicate planned workout when Garmin scheduling fails mid-sync. Previously the created workout was only recorded *after* the schedule call, so a Garmin 429/500 on scheduling left the workout orphaned and untracked, and the next sync created a second copy. The workout is now persisted right after creation (as `schedule_pending`); if scheduling then fails, the next sync deletes and recreates that tracked workout and retries the schedule instead of duplicating it.

## [0.5.21] - 2026-07-19

### Fixed
- The **Replace** watch strategy no longer aborts the whole sync when the watch's high-resolution HR cannot be extracted (a 0.5.20 regression, [#244](https://github.com/drkostas/hevy2garmin/issues/244)). It now keeps the watch activity and merges the sets into it in place, so the workout still syncs and the watch HR is never lost. Only the named-exercise display is dropped when the HR cannot be preserved. HR extraction also tolerates a small clock offset between the Hevy workout window and the watch recording.

## [0.5.20] - 2026-07-18

### Added
- The watch-activity **Replace** strategy now extracts high-resolution heart-rate samples from the original Garmin FIT and embeds them in the named Hevy replacement before deleting the watch copy. If the source cannot be extracted or restored from backup, replacement stops and preserves the original activity.
- Sync Hevy routines to Garmin as planned workouts. Maps routine exercises to Garmin workout-service exercise IDs (validated against a real Garmin export), adds timed rest steps between sets, and supports per-routine scheduling (one-off and recurring weekly). Re-sync is checksum-based with a `--force` override, the sync summary reports created vs updated separately, and the dashboard gains a routines page plus a home-screen summary.

## [0.5.19] - 2026-07-14

### Added
- Safe Garmin upload recovery ([#227](https://github.com/drkostas/hevy2garmin/pull/227), thanks @donndonn). Uploads that fail mid-request (crash/timeout) are parked in a durable `pending_uploads` table instead of being blindly re-uploaded, so an upload that may have reached Garmin never creates a duplicate. Rename/description/watch-delete resume from checkpoints, same-id deletion is blocked, and delete retries are capped. New CLI and web controls to resolve stuck syncs: reconcile (never uploads, adopts an activity only with a start-time match and upload evidence), retry-failed-only, abandon, mark-synced, and skip.

## [0.5.18] - 2026-07-14

### Fixed
- Python 3.10 compatibility: timestamps with a single fractional-second digit (e.g. `2026-03-15T18:02:00.0`) or a space date/time separator no longer raise `ValueError` on Python 3.10, which the project supports. All ISO-8601 parsing now goes through a shared `parse_iso()` helper that normalizes the fraction width and the `Z`/space separators (previously 15 `datetime.fromisoformat` call sites could fail on 3.10 for such timestamps). (#229)

## [0.5.17] - 2026-07-13

### Fixed
- The "Not configured" error is now context-aware. On the cloud / GitHub Actions path (DATABASE_URL set) it no longer tells you to run `hevy2garmin init` (a local interactive wizard that can't run in Actions); instead it points you to finish setup in the dashboard and to make sure `DATABASE_URL` matches your deployment's database. (#224)

## [0.5.16] - 2026-07-13

### Fixed
- Merge mode: when Garmin rejects one exercise's name as an invalid sub-category, only that exercise's name is now stripped instead of every name in the workout. The offender is found by bisecting the payload (the atomic PUT gives no per-exercise error), so the rest of your exercises keep their real names. Falls back to stripping all names only if several exercises are rejected. (#222)

## [0.5.15] - 2026-07-10

### Changed
- Unified the bulk sync and per-workout cron sync paths behind a single `sync_one_workout()` helper. The Vercel cron now gets the same merge-reliability behavior (grace period, heart-rate retry, duplicate awareness) that the CLI and autosync paths already had. Thanks @donndonn for the contribution (#208, closes #206).

### Fixed
- The description toggle is now respected on the web sync path, and calories and average heart rate carry through on the merge path.

## [0.5.14] - 2026-07-09

### Added
- **Enforced cooldown after a Garmin login rate-limit** ([#211](https://github.com/drkostas/hevy2garmin/issues/211)). When Garmin rate-limits a login, retrying resets Garmin's own timer and makes it worse. The tool now records an exponential-backoff cooldown (2h, then 4h, 8h, capped at 24h, reset after a clean login) and, while it is active, the local setup skips the Garmin login attempt entirely so you cannot deepen the block by retrying. Cloud rate-limits are recorded too, and the setup page and dashboard show a live countdown with the Connect button disabled until it clears. Sync resumes automatically once the window passes.

## [0.5.13] - 2026-07-09

### Added
- **Grace period before syncing** ([#205](https://github.com/drkostas/hevy2garmin/issues/205)). Automatic syncs (self-hosted auto-sync and the CLI) now wait `sync.grace_period_minutes` (default 120) after a workout ends before syncing it, so the Garmin watch activity has time to appear and the workout merges into one activity instead of creating a duplicate. Manual "Sync now" ignores the grace period.
- **Duplicate detection (log-only)** ([#205](https://github.com/drkostas/hevy2garmin/issues/205)). Each sync scans recent workouts and reports any that ended up with both a tool-created and a watch activity for the same session, plus a manual "scan for duplicates" action. It only reports, it does not delete anything.

### Fixed
- **Fresh uploads that land without heart rate are now retried once and reported** ([#205](https://github.com/drkostas/hevy2garmin/issues/205)). The heart-rate fetch retries once if the first attempt is empty, and an upload that still ends up without HR is counted and logged instead of silently having none.

### Note
- Merge reliability currently applies to the self-hosted and CLI sync path. Bringing it to the Vercel cron path is tracked in [#206](https://github.com/drkostas/hevy2garmin/issues/206).

## [0.5.12] - 2026-07-07

### Fixed
- **Merge dropped every exercise set when Garmin rejected one exercise** ([#199](https://github.com/drkostas/hevy2garmin/issues/199)). The exerciseSets push is atomic, so a single exercise whose (category, subcategory) pair Garmin rejects (a 400 "Invalid Sub-Category") made the whole activity lose its sets, and after three such workouts merge was disabled for the rest of the run. It now retries once with the exercise names stripped (the category is kept, which Garmin always accepts), so the sets, reps and weights still land. Thanks @silas_christopher for the detailed report.
- **Some exercises showed as "Total Body" instead of their real category** ([#201](https://github.com/drkostas/hevy2garmin/issues/201)). Cardio machines (cycling, treadmill, elliptical, rowing machine and others) and a few rows were mapped to FIT categories the bundled library does not implement, so they fell back to the generic Total Body. They now use valid categories: cardio machines show as Cardio, and the chest-supported dumbbell row shows its real name.
- **Misleading Garmin rate-limit message** ([#202](https://github.com/drkostas/hevy2garmin/issues/202)). The setup screen said to "wait a few minutes" on a Garmin rate limit, but it is usually a few hours and retrying resets the timer. The message now says so, and makes clear it is on Garmin's side and separate from your password.

## [0.5.11] - 2026-06-26

### Added
- **"Unsync All" button** ([#174](https://github.com/drkostas/hevy2garmin/issues/174)). On the Workouts page, next to Reload Data. Clears the sync status of every workout so the next sync re-imports them all, which is handy after a mapping fix instead of unsyncing one at a time. It does not delete anything from Garmin, and workouts still on Garmin are skipped as duplicates on re-sync. Thanks @KaiBoos.

### Fixed
- **Footer showed the wrong version (e.g. 0.4.0) after a Vercel fork + sync** ([#189](https://github.com/drkostas/hevy2garmin/issues/189)). The version came from the installed package metadata, which the Vercel build can cache stale, so the footer showed an old number even though the code was current. It now reads the version from pyproject.toml in the deployed source, so the footer always matches the running code. Thanks @KaiBoos.

## [0.5.10] - 2026-06-26

### Added
- **"Merge sets" strategy for watch-recorded workouts** ([#159](https://github.com/drkostas/hevy2garmin/issues/159)). A third option for "Workouts recorded on a watch" (Settings, Advanced), requested by @bojanmk1: push the sets, reps, and weights into the watch activity and keep it, so you keep all the watch's native metrics (heart rate, training effect, body battery) and the structured set data in one activity. The exercise names still show as "Unknown" because Garmin does not apply pushed names to watch-recorded activities, but the set data is there. Default stays "replace" (named exercises, single activity).

## [0.5.9] - 2026-06-26

### Added
- **One activity for watch-recorded workouts** ([#159](https://github.com/drkostas/hevy2garmin/issues/159)). New setting "Workouts recorded on a watch" (Settings, Advanced). The default "Replace" uploads a single named activity with your heart rate and deletes the watch recording, so you get one activity with named exercises and no double-counted calories or activity totals. "Keep" leaves the watch activity untouched and lists the exercises in its description instead.

## [0.5.8] - 2026-06-26

### Fixed
- **Exercises showing as "Unknown" on watch-recorded workouts** ([#159](https://github.com/drkostas/hevy2garmin/issues/159)). When a workout was recorded on a Garmin watch, merge mode pushed the exercise sets, but Garmin ignores pushed exercise identities on activities it recorded itself, so they showed "Unknown" with no reps. The tool now checks the matched activity's manufacturer and, for any activity it did not create (a watch, etc.), uploads a fresh named activity instead of merging. Heart-rate fusion still pulls the watch HR into it. Confirmed against the live Garmin API.

## [0.5.7] - 2026-06-26

### Fixed
- **Auto-sync interval always reset to 2 hours** ([#177](https://github.com/drkostas/hevy2garmin/issues/177)). The interval dropdown read its value with `this.value` inside an htmx hx-vals expression, which did not resolve, so every change saved the default (120 min). It now reads the selected value explicitly, so your chosen interval sticks. Thanks @KaiBoos.

## [0.5.6] - 2026-06-25

### Added
- **Language-independent exercise mapping** ([#173](https://github.com/drkostas/hevy2garmin/issues/173)). Non-English Hevy exercises (German and others) now map to Garmin automatically using Hevy's `exercise_template_id`, which is the same in every language, instead of only the English exercise name. Built from Hevy's global catalog (428 exercises) via `scripts/gen_template_map.py`. You no longer need to map every exercise by hand just because your Hevy is not set to English. Thanks @KaiBoos for the idea.
- **"Reload Data" button on the Workouts page** ([#174](https://github.com/drkostas/hevy2garmin/issues/174)). The page serves cached workout data, so editing a workout in Hevy was not reflected until the next sync. The button refetches your latest workouts from Hevy on demand. Thanks @KaiBoos.

## [0.5.5] - 2026-06-25

### Fixed
- **Mapped exercises stayed in the "Unknown" list** ([#172](https://github.com/drkostas/hevy2garmin/issues/172)). After mapping an exercise on the Mappings page, it kept showing as unmapped until the next sync or a restart, even after a reload. The unmapped list now filters out exercises that already have a mapping, and a saved mapping is dropped from the cached list right away. Thanks @KaiBoos.

## [0.5.4] - 2026-06-25

### Fixed
- **Backfill not reaching older workouts** ([#165](https://github.com/drkostas/hevy2garmin/issues/165)). The "Sync N Workouts" backfill searched only the first few pages of Hevy history, so when the recent workouts were already synced and the unsynced ones were older, it stopped before finding them and reported done. It now scans the whole history. Together with the earlier fetch-by-ID fix, both the bulk backfill and the per-workout Upload reach any workout regardless of age.

## [0.5.3] - 2026-06-24

### Fixed
- **Exercises showing as "Choose an Exercise" on watch-recorded activities** ([#159](https://github.com/drkostas/hevy2garmin/issues/159)). When you record a strength workout on your Garmin watch and the tool merges Hevy data into it, Garmin accepts the sets but ignores the exercise names, so every set stays "Choose an Exercise". The tool now verifies after the merge whether the names actually stuck. When Garmin drops them, it restores the watch activity and uploads a separate, properly named activity instead, so the exercises are named. Confirmed live against a real Garmin account.

## [0.5.2] - 2026-06-24

### Fixed
- **"Workout not found" when syncing older workouts** ([#165](https://github.com/drkostas/hevy2garmin/issues/165)) — the per-workout Upload button and HR fetch now look up the exact workout by ID (`GET /v1/workouts/{id}`) instead of scanning only the first page of 10, so users with more than a page of history can sync any workout, not just recent ones.

## [0.5.1] - 2026-06-23

### Added
- **Merge into non-strength watch activities** ([#157](https://github.com/drkostas/hevy2garmin/pull/157)) — a `merge_activity_types` setting (default `["strength_training"]`) lets Enhance Watch Activities fuse Hevy workouts into other Garmin activity types you record on the watch (e.g. Indoor Climbing), instead of creating a duplicate. Configure extra types under Settings → Enhance Watch Activities → Advanced. Thanks @braianrabanal.

### Changed
- **Garmin login is now mobile-first** ([#147](https://github.com/drkostas/hevy2garmin/issues/147), [garmin-auth#29](https://github.com/drkostas/garmin-auth/issues/29)) — the login worker tries Garmin's mobile/app endpoint first (the one built for native 2FA, so MFA accounts no longer take a portal→427→fallback detour) and **no longer retries the other endpoint on a rate limit**. Garmin's login limit is per-account across both endpoints, so the old fallback was deepening the throttle that wouldn't clear. Verified end-to-end on a real 2FA account (login → email MFA → tokens).

### Added
- Version + changelog link in the dashboard footer ([#144](https://github.com/drkostas/hevy2garmin/issues/144)) — confirm which build you're running after an upgrade.
- **Heart rate now embedded in the uploaded activity** ([#158](https://github.com/drkostas/hevy2garmin/issues/158)) — fetched HR is written into the FIT at real timestamps, so it appears on the Garmin Connect activity, not just the dashboard chart. New `hr.py` merges HR sources (in-workout/AirPods-preferred, Garmin watch fill); the merge is source-agnostic and ready for in-workout HR the moment Hevy exposes it via the API (it does not today). Gated by the existing HR-fusion toggle, cached, and best-effort (never breaks a sync).

### Fixed
- **Serverless persistence** ([#145](https://github.com/drkostas/hevy2garmin/issues/145)) — custom exercise mappings and profile/settings now persist to Postgres on cloud deployments instead of the read-only `~/.hevy2garmin` filesystem. Fixes the 500 when saving a mapping on Vercel ([#142](https://github.com/drkostas/hevy2garmin/issues/142)), profile reverting to defaults / Pull-from-Garmin not sticking ([#139](https://github.com/drkostas/hevy2garmin/issues/139)), and the blank-dashboard crash on deploy without a database — now an actionable "set DATABASE_URL" error.
- **Activity lookup by date range** ([#140](https://github.com/drkostas/hevy2garmin/issues/140)) — `find_activity_by_start_time` now searches a ±1 day window instead of only the 10 most recent activities, so older uploads are found regardless of account volume. Thanks @zv33 ([#141](https://github.com/drkostas/hevy2garmin/pull/141)).
- **Quoted activity ID breaks rename** ([#153](https://github.com/drkostas/hevy2garmin/issues/153)) — Garmin sometimes returns `internalId` as a quoted string (`"'123'"`); it's now sanitized to a clean int before storage, so rename no longer 404s. Diagnosed by @frankzotynia10 ([#143](https://github.com/drkostas/hevy2garmin/pull/143)).
- **"Unknown" exercise names in merge mode** ([#138](https://github.com/drkostas/hevy2garmin/issues/138)) — the `exerciseSets` payload now sends a valid FIT sub-category string (or `null`) as the exercise `name`, with `probability`, matching the shape Garmin actually stores. Previously it fell back to the parent category name or `"TOTAL_BODY"`, which Garmin Connect rendered as "Unknown".
- **Redundant setup login tripped rate limits** ([#148](https://github.com/drkostas/hevy2garmin/issues/148)) — on cloud deployments the setup form no longer performs a server-side Garmin test login (the datacenter IP is blocked and it added to Garmin's per-account rate limit, surfacing a scary error that looked like setup failed). Real auth happens via the browser/worker flow; credentials are saved either way. Local installs keep the test login. The rate-limit message is also clearer (it's per-account, clears on its own, and your website login is unaffected).

## [0.4.0]

### Added
- **Dashboard password auth** ([#122](https://github.com/drkostas/hevy2garmin/issues/122)) — `H2G_PASSWORD` env var protects all routes behind a login page.
- **Enhance Watch Activities** ([#117](https://github.com/drkostas/hevy2garmin/issues/117)) — merge Hevy exercise data into watch-recorded Garmin activities (merge mode).
- **Settings page** ([#120](https://github.com/drkostas/hevy2garmin/issues/120)) — merge mode toggle, description toggle, advanced parameters.
- **Demo mode** ([#134](https://github.com/drkostas/hevy2garmin/issues/134), [#135](https://github.com/drkostas/hevy2garmin/issues/135), [#136](https://github.com/drkostas/hevy2garmin/issues/136)) — `DEMO_MODE` env var disables sync and shows banner. Public demo at hevy2garmin-demo.gkos.dev.
- **Fork-based deploy flow** ([#129](https://github.com/drkostas/hevy2garmin/issues/129)) — switched from clone to fork for easier upstream updates.

### Fixed
- garminconnect 0.3.x compatibility: `client.garth` → `client.client` ([#123](https://github.com/drkostas/hevy2garmin/issues/123)).
- Merge mode toggle doesn't persist from dashboard settings ([#130](https://github.com/drkostas/hevy2garmin/issues/130)).
- Exercise mapping not persisting after reload ([#124](https://github.com/drkostas/hevy2garmin/issues/124)).
- FIT generator hardened: cardio distance fields, null timestamps, edge cases ([#128](https://github.com/drkostas/hevy2garmin/issues/128)).
- Negative `weight_kg` clamped to 0 ([#103](https://github.com/drkostas/hevy2garmin/issues/103)).
- Credential masking on setup/settings pages ([#123](https://github.com/drkostas/hevy2garmin/issues/123)).
- Open redirect on `/login?next=` parameter.

### Changed
- Merge mode enabled by default ([#119](https://github.com/drkostas/hevy2garmin/issues/119)).

## [0.3.1]

### Added
- **Inline Garmin login** — authenticate without copy-paste URL tab-switching flow.

## [0.3.0]

### Changed
- **Breaking:** migrated to garmin-auth 0.3.0 + garminconnect 0.3.0 (new auth flow).

### Added
- Warmup + working set grammar coverage in tests.

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

[Unreleased]: https://github.com/drkostas/hevy2garmin/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/drkostas/hevy2garmin/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/drkostas/hevy2garmin/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/drkostas/hevy2garmin/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/drkostas/hevy2garmin/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/drkostas/hevy2garmin/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/drkostas/hevy2garmin/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/drkostas/hevy2garmin/releases/tag/v0.1.0
