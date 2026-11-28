# Changelog

All notable changes to hevy2garmin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Hevy workout photos go to the Garmin activity. After every live sync that ends on a Garmin activity (a fresh upload or the replace strategy's named upload, a match, a merge into the watch activity, or a **Resync**), the web app downloads each image in the workout's `media`, in order, and posts it to the activity with garmin-auth 0.9.0's `uploadActivityImage`. Videos are skipped, and so are responses that are not an image or are over 15 MB. Only `https` URLs on the default port and on Hevy's photo hosts are fetched (`hevy.com`, `hevyapp.com`, their subdomains, and `*.cloudfront.net`), and a redirect is refused rather than followed; a refused URL is logged with its host. Uploads are paced like the engine's other Garmin calls. A new `synced_media` table records each photo per workout, URL and activity, so a sync or Resync adds only what the activity is missing, and Resync adds photos to workouts synced before this release. A failed download or upload is logged and never fails the sync; it is not recorded, so the next sync tries it again. **Sync workout photos** in Settings turns it off (stored as `workout_photos`, on by default). Nothing is downloaded or uploaded in demo mode. The weekly Hevy spec watch (#524) is removed now that the API has `media` (#237).
- The dashboard tells a fork when the original repo has new commits: "Update available: N new changes since your version", with **See what's new** linking to the GitHub compare. `GET /api/update-check` compares the deployed commit (`VERCEL_GIT_COMMIT_SHA`, or `HEVY2GARMIN_COMMIT_SHA` self-hosted) with upstream `main`, using the saved GitHub token when there is one, and caches the answer in `app_cache` for 6 hours. The banner loads after the page renders, and any GitHub or network failure means no banner. A failed check is cached under its own key for GitHub's `retry-after` when it sends one, else until its `x-ratelimit-reset` time, else for an hour, so dashboard views do not retry GitHub on every load; it never replaces a cached answer. A fork from before the history rewrite of 9 September 2026 gets the banner without a count, with links to the fork and the README's update steps. **Dismiss** hides it until upstream has a newer commit. On a Vercel fork with a saved GitHub token, **Update now** does what GitHub's Sync fork does: `POST /api/update-fork` (session-gated) calls merge-upstream on the fork's default branch, then the page waits for the new deployment and reloads. When GitHub had nothing to merge (`merge_type: "none"`), the banner says the fork is already up to date and that a new deployment may still be on its way, waits for nothing, and the cached check is refreshed so the banner goes. A 409 or 422 is not retried and links to the fork and the update steps; a 401 or 403 says the token needs the `repo` scope, and `workflow` when the update changes `.github/workflows/`. Self-hosted shows the banner without the button. `H2G_UPDATE_CHECK=off` turns it off; `H2G_UPSTREAM_REPO` names the repo to follow (default `drkostas/hevy2garmin`). Nothing is checked in demo mode, without a deployed commit or fork repo, or on the upstream repo itself (#749).
- Optional error reports to the same collector. With `COLLECTOR_URL` and `COLLECTOR_TOKEN` set, an uncaught error or unhandled rejection in a visitor's browser (at most 5 a page view) goes to the app's own `POST /api/client-error`, which forwards the message, source and user agent to `{COLLECTOR_URL}/collect` as `kind: "error"`. The token stays on the server. The route always answers 204 and sends nothing without both variables (#745).
- An optional visit counter that posts to a collector you configure. With `COLLECTOR_URL` and `COLLECTOR_TOKEN` set, the web app's proxy posts each page view (page name, referrer, user agent, client IP) to `{COLLECTOR_URL}/collect` in the background, with a 1.5 s timeout, and never changes the response. `COLLECTOR_PAGE` names the page (default: the request host). Unset, nothing is sent (#743).
- A **Remove** button on each synced routine on the Routines page. After a confirmation it deletes the routine's planned workout on Garmin, which also removes its calendar entries, and the routine's rows here. When Garmin no longer has the workout, it is removed here only (#733).
- `H2G_DIRECT_GARMIN_LOGIN=true` signs in to Garmin on a self-hosted server instead of through the Worker. The login, the two-factor step and the manual ticket exchange run garmin-auth's Worker code in-process (`garmin-auth/sso-local`, 0.8.0), so the password, code and ticket go only to Garmin, and `GARMIN_LOGIN_WORKER_URL` is ignored. The manual fallback posts the ticket to the new `/api/garmin-ticket-exchange`, which answers 404 while the flag is off. Off by default; the Worker path is unchanged. The Python dashboard had the same flag until it was removed (#685).
- An **Edited in Hevy** badge on the Workouts page, next to **Resync**, on synced workouts that changed in Hevy after they synced. Engine: `HevyClient.getWorkoutEvents(since, page, pageSize)` reads `GET /v1/workouts/events`, and `getWorkoutEventsSince(since, { maxPages })` walks its pages, reporting `truncated` when it stopped at the cap; a failed page throws. Web: `GET /api/edited-workouts` compares each synced row's stored `hevy_updated_at` with its newest Hevy event, as timestamps, reading at most 10 pages of events. The badges load after the page renders, so a slow or failing Hevy only means no badges, and a successful Resync clears its row's badge. Rows marked as synced by hand, skipped, or without a recorded Hevy version get none. Until the web pin reaches the engine release with the events read, no badges show (#701).
- Resync a workout you edited in Hevy after it was synced. Engine: `syncOneWorkout` takes `targetActivityId` with `targetHevyId` and pushes the current Hevy version into that Garmin activity in place, with the merge's backup and read-back, then renames and describes it and rewrites the ledger row. The workout must already be synced, and nothing is matched by time, uploaded or deleted: the activity is read by id, then identified by that id in Garmin's activity list for its day, which says whether a watch recorded it. Under the `describe` strategy a watch recording keeps its own sets. Heart rate comes from the activity's own FIT and the usual fallbacks, without writes, so calories and average HR match a normal sync. A stored activity Garmin no longer has returns `target_missing`; a name drop restores the previous sets and returns an error. `GarminGateway` gains an optional `activity(id)` read. Web: a **Resync** button next to **Unsync** on rows this app synced to a Garmin activity, with a confirmation, and the outcome shown on the row. It works for workouts from before the sync start date. `scripts/dump_garmin_activity.py` prints one activity's raw JSON, read-only. Until the web pin reaches the engine release with the option, the button reports that the engine does not support resync yet and changes nothing (#701).
- `H2G_SERVER_SYNC_SCHEDULE` names a self-hosted server's own sync schedule, such as `every 2 hours`. With it set, the dashboard and Settings show that schedule instead of the auto-sync toggle, interval and GitHub token, which only drive the GitHub Actions workflow, and **Sync all** says it runs on the server. Unset, nothing changes. The compose example sets it to match its scheduler (#683).
- The Hevy webhook on a self-hosted `web/` server syncs merge-first again, as the Python server did. It answers at once, waits 5 minutes, tries up to twice more 10 minutes apart to merge into the watch activity, and uploads a fresh activity only on the last attempt. `WEBHOOK_DELAY_SECONDS`, `WEBHOOK_RETRY_INTERVAL_SECONDS`, `WEBHOOK_MAX_ATTEMPTS` and `WEBHOOK_MAX_INFLIGHT` keep their Python names and defaults. Vercel and the GitHub Actions handoff are unchanged (#656).
- The web dashboard can be served under a path prefix: `H2G_BASE_PATH`, set at build time, becomes the Next.js `basePath`, and `withBasePath()` prefixes the hand-written `fetch("/api/...")` calls and plain links that Next does not. Unset, the build is unchanged. `web/Dockerfile` takes it as a build argument, and the compose example passes it through. The Python dashboard had this since #305 (#658).
- `web/Dockerfile` builds the dashboard from its standalone output: multi-stage, runs as the unprivileged `node` user, health check on `/api/version`, amd64 and arm64. `web/docker-compose.example.yml` runs it with Postgres 16 and a small scheduler that calls `GET /api/cron/sync` every two hours (#657).

### Fixed

- A resync no longer moves a workout to the top of the Workouts and History pages. It kept the activity but reset `synced_at`, which both pages date and sort rows by, so a workout from days ago jumped to the top and its original sync time was lost. The engine now passes `resync: true` to `markSynced` on the `targetActivityId` path only; the web store then keeps `synced_at` and records `resynced_at`, a new column, and the rows show it after the date ("Oct 7, 10:56 AM · resynced Oct 9, 02:52 PM"), on a line of its own on narrow screens. `GET /api/workouts` carries `resynced_at` as an optional field. The web app uses engine 0.14.0, which passes the flag (#709).
- The Routines page shows which Hevy routines are already on Garmin. After a refresh, a synced routine used to read **Sync to Garmin** again, as if it were a second routine. It now reads **Re-sync** and "on Garmin", taken from the synced table below it (#735).
- A routine whose workout was deleted in Garmin Connect can be synced again. The sync now asks Garmin before it skips an unchanged routine, and removing a schedule Garmin already deleted removes it here instead of failing with a 404. **Sync to Garmin** on an unchanged routine says it is already on Garmin instead of "Request failed (200)" (#729).
- A routine workout that is created again (after the routine changed, or after #728) is booked again on the routine's upcoming dates. Garmin deletes a workout's calendar entries with it, and the web sync never booked them again, so the routine left the Garmin calendar while the Routines page still listed its dates. Past dates are dropped, and a date that fails to book is tried again on the next sync (#731).
- Routine workouts rest after the last set of each exercise too, before the next exercise. Only the last set of the workout has no rest after it (#730).
- A routine synced to Garmin shows identical consecutive sets as one repeat block ("3 sets"), as Garmin's own editor builds them, instead of one step per set. Sets that differ (a warmup, a changed weight or rep count) stay separate steps. Routines already on Garmin are re-created in the new form on the next routine sync (#727).
- The web app saves the Garmin tokens after every refresh. Garmin rotates the refresh token on each one, and the cached client's refreshes on a 401 stayed in memory, so the next restart loaded a replaced refresh token and the login was lost. The fix is in garmin-auth 0.8.0, which the web app now uses (#721).
- The sync cron and the dashboard's batch sync stop when the engine hands back a workout the run already handled. A deferred workout stays pending, so the loop used to repeat it up to its cap of 50: a cron tick inside the grace period ran 50 identical passes, each fetching the Hevy list (#723).
- A sync that merged into a watch activity failed with "Invalid time value" (shown as "Something went wrong during the sync.") when the Timing settings were never saved. The settings loader passed `undefined` for each unsaved value, which replaced the default set time with NaN. It now passes only saved values, and the engine ignores any timing value that is not a number (#703).
- The setup page and the dashboard showed Hevy as "Not connected" when the key came from `HEVY_API_KEY`, though the sync used it. The badge now counts a key from the environment or the saved row, and a key Hevy rejected still shows as disconnected: for an environment key, which has no row to mark, a row holding only the status is written, never the key (#681).
- The webhook compares the `CRON_SECRET` bearer in constant time (#656).
- The README said the cron route is `POST /api/cron/sync`. It is `GET`; a POST answers 405. The Self-hosting section now shows the call and says that `GITHUB_PAT` plus `GITHUB_REPO` send the run to GitHub Actions instead (#657).
- `init` no longer reports a Garmin login it could not save. It checks the token folder can be written before asking for the password, and says so if the token file did not appear afterwards. In Docker on Linux a host folder that Docker created belongs to root, and the image runs as uid 999, so the login was lost and every later run failed with "No cached tokens" (#651, #653).
- The Docker section of the README mounts both folders for `init`, recommends named volumes, explains uid 999 for host folders, and tells docker-compose users how to reuse their old volumes (#651, #652).

## [0.14.0 (npm)] - 2026-10-12

### Fixed

- `syncOneWorkout` passes `resync: true` to `markSynced` when it resyncs a workout into its stored Garmin activity (`targetActivityId`), and `MarkSyncedOpts` gains the optional `resync`. A store can then keep the row's original sync time instead of moving the workout to the top of its lists. Every other write leaves it out (#709).

## [0.13.0 (npm)] - 2026-10-09

### Added

- `HevyClient.getWorkoutEvents(since, page, pageSize)` reads one page of Hevy's `GET /v1/workouts/events`, and `getWorkoutEventsSince(since, { maxPages })` walks the pages, newest first. A failed page throws; stopping at `maxPages` returns `truncated: true` (#701).

## [0.12.0 (npm)] - 2026-10-09

### Added

- `syncOneWorkout` takes `targetActivityId` with `targetHevyId` to resync a synced workout into the Garmin activity its ledger row stored, in place, with the merge's backup and read-back. Nothing is matched by time, uploaded or deleted. A stored activity Garmin no longer has returns `target_missing`. `GarminGateway` gains an optional `activity(id)` read (#701).

### Fixed

- `buildExerciseSetsPayload` ignores timing values that are not finite numbers, so an `undefined` no longer replaces a default and throws "Invalid time value" (#703).

## [0.11.1 (npm)] - 2026-10-08

### Fixed

- The activity description counts failure and drop sets as working sets, as the FIT file already does. Before, only `normal` sets were counted, and an exercise logged with only failure sets was missing from the description (#689).
- Daily heart rate is no longer always empty. The display name the wellness endpoint is keyed by was read from `/userprofile-service/userprofile/profile`, which Garmin now answers with 404, so every workout the watch did not record as an activity synced without HR and nothing said why. The name now comes from `/userprofile-service/socialProfile`, and when there is none the unkeyed `dailyHeartRate?date=` path is asked instead of giving up (#686).

## [0.11.0 (npm)] - 2026-10-03

### Added

- Engine: `syncOneWorkout` takes `mergeOnly`, and returns `merge_pending` when the merge found no Garmin activity instead of uploading. A `replace` match counts as found. The Python `merge_only` also refused those, so with `watch_strategy=replace` every webhook sync waited for the last attempt (#656).
- `onWatchActivityDeleted` takes an optional third argument, `{ hevyId, workoutEnd }`, passed from both delete sites, so a hook can key what it records on the workout. A hook written for two arguments keeps working (#655).

## [0.10.0 (npm)] - 2026-10-02

### Added

- `resolveExclusiveMatches` keeps at most one Hevy workout per Garmin activity. `matchHevyToGarmin`'s second pass can hand a workout that has no activity of its own the closest one within six hours, even when the first pass already paired that activity with another workout. The smaller gap between the starts wins, and a tie goes to the lower Hevy id.
- `HevyClient.updateWorkout(id, body)` replaces a workout on Hevy, with the same retry and auth handling as the reads.

## [0.12.0] - 2026-09-11

### Removed

- The Python dashboard: the FastAPI server, its templates and static files, the `serve` command, the Vercel Python entry (`api/index.py`, `vercel.json`) and `docker-compose.yml`. The dashboard is the Next.js app in `web/`, the deploy for every fork (Root Directory `web` on Vercel). Announced in 0.11.0 (#514).
- `fastapi`, `uvicorn`, `jinja2` and `python-multipart` from the dependencies. The package is the CLI: `hevy2garmin init`, `sync`, `status`, `map` and the rest are unchanged.

### Notes

- The PyPI package is deprecated with an end date of 2026-10-31 (#515). The maintained code is the TypeScript package and `web/`.

## [0.6.0 (npm)] - 2026-09-11

- `generateFit` accepts `trainingLoad`. When set, the FIT session carries `training_load_peak`, which Garmin Connect displays as the activity's Training Load for uploads (hevy2garmin#522 proved the field is honoured; #523). Off by default: a written load feeds Garmin's acute load and training status.

## [0.11.0] - 2026-09-11

### Deprecated
- **The Python dashboard is retired in 0.12.0.** The Next.js dashboard in `web/` is the deploy for every fork: set **Root Directory** to `web` on your Vercel project (Settings > General) before updating past 0.11.x. In 0.12.0 `api/index.py`, `server.py`, the templates and the root `vercel.json` routing are removed, so a project with an empty Root Directory stops deploying. The demo at `hevy2garmin-demo.gkos.dev` already runs the Next.js dashboard; the Python one stays at `hevy2garmin-demo.vercel.app` until 0.12.0.
- **The PyPI package is deprecated, with an end date of 2026-10-31.** The CLI and the Python sync core keep working until then; after that date the package receives no releases and is marked deprecated on PyPI. The replacements are the Next.js dashboard for the app and the npm package `hevy2garmin` for the sync engine (same FIT generation, same exercise map, same dedup rules, Python-parity goldens in its tests). `garmin-auth` on PyPI follows the same date.

### Changed
- The Garmin login Worker moved to garmin-auth (`garmin-auth-sso.gkos.workers.dev`); the dashboard binds `garmin-auth/sso-worker` and the Python setup page points at the new URL. `worker/` and `worker-di/` are gone from this repository; a fork with its own Worker keeps setting `GARMIN_LOGIN_WORKER_URL` (drkostas/soma#842).

### Changed
- `hevy2garmin` 0.5.0 adds the exercise to muscle-group mapping and volume aggregation (`getExerciseMuscles`, `aggregateMuscleVolumes`, `MUSCLE_LABELS`, `MUSCLE_HEX`) that soma's web and app each kept a copy of (soma#841).
- `hevy2garmin` 0.4.1 is 0.4.0 rebuilt from an empty `dist/`: 0.4.0 shipped stale compiled files that shadowed the sync engine's types. A `prepack` step now clears and rebuilds `dist/` before every publish ([#508](https://github.com/drkostas/hevy2garmin/issues/508)).
- `hevy2garmin` 0.4.0 adds `matchHevyToGarmin` and `toUtcDate`, the timestamp matcher soma used to keep as a local copy (soma#835).
- The `hevy2garmin-web` Vercel project is now connected to this repository with Root Directory `web`, so every pull request builds a preview of the Next.js dashboard next to the Python one, and merges to `main` deploy it ([#478](https://github.com/drkostas/hevy2garmin/issues/478)). Until now the green Vercel check on a PR had only ever built the Python dashboard.
- Coming next: `hevy2garmin-demo.gkos.dev` moves to the Next.js dashboard. The Python demo stays reachable for one more release at `hevy2garmin-demo.vercel.app` ([#456](https://github.com/drkostas/hevy2garmin/issues/456)).
- The sync engine now lives in the `hevy2garmin` npm package (0.3.0): `syncOneWorkout`, `listCandidates`, `reconcilePending`, `retryPending`, the pure dedup helpers and `generateDescription`, behind a `SyncStore` interface and a `GarminGateway`. The web dashboard imports it and keeps only a Postgres `SyncStore` adapter and route glue, so soma and any other consumer run the same dedup and dry-run logic ([#500](https://github.com/drkostas/hevy2garmin/issues/500)).
- The Next.js web dashboard in `web/` is now the recommended Vercel deploy: set **Root Directory** to `web` when importing a fork, or change it in an existing project's settings and redeploy ([#456](https://github.com/drkostas/hevy2garmin/issues/456)). The Python dashboard keeps working for existing deployments (Root Directory empty) but no longer gets new features. Both read the same database and credential rows.

### Added
- Web dashboard: a fresh-fork CI check (install from the lockfile, build, answer with a bare environment), `web/.env.example`, and a README section ([#462](https://github.com/drkostas/hevy2garmin/pull/462)).
- Web dashboard: the GitHub token can be saved in-app and the auto-sync GitHub Actions workflow is created from the dashboard, with the generated workflow tested against the Python generator's output ([#463](https://github.com/drkostas/hevy2garmin/pull/463)).
- Web dashboard: `H2G_SECRET` and `H2G_PASSWORD_HASH` (argon2) work the same as in the Python dashboard ([#464](https://github.com/drkostas/hevy2garmin/pull/464)).
- Web dashboard: pull the Garmin profile, sync all routines at once, `/sync` redirects to the dashboard, and a Playwright smoke test runs in CI ([#465](https://github.com/drkostas/hevy2garmin/pull/465)).
- `docs/CUTOVER.md`, a runbook for moving a deployment to the web dashboard: the checks that gate the flip, the one Vercel setting that performs it, the one that reverses it, and the behaviour you inherit ([#468](https://github.com/drkostas/hevy2garmin/pull/468), [#469](https://github.com/drkostas/hevy2garmin/pull/469)). It calls out that intervals.icu cleanup is Python-only, so `INTERVALS_API_KEY` goes inert and deleted watch duplicates stay on intervals.icu, and that `sync_log` is written only by the Python path, so its history panel shows a gap for any window the web path was live.

### Fixed
- Garmin credential rows written flat by the Python login are read by the web dashboard, and nested rows written by the web dashboard are read by the Python one; both self-heal on start ([#463](https://github.com/drkostas/hevy2garmin/pull/463)).
- The web parity smoke covers all eight pages, not six, and checks each is reachable by clicking the nav rather than only by direct URL ([#468](https://github.com/drkostas/hevy2garmin/pull/468)).
- The parity smoke runs on its own port instead of the one `npm run dev` uses, so it can no longer attach to a running dev server and test against that developer's `.env.local` and database ([#468](https://github.com/drkostas/hevy2garmin/pull/468)).
- CI runs the mobile Playwright project as well as desktop. The two navs are separate markup, so a mobile-only regression previously merged green ([#469](https://github.com/drkostas/hevy2garmin/pull/469)).

## [0.10.1] - 2026-08-30

### Fixed
- Fresh Vercel + Neon deploys no longer crash with `ModuleNotFoundError: No module named 'psycopg2'` ([#358](https://github.com/drkostas/hevy2garmin/pull/358), closes [#357](https://github.com/drkostas/hevy2garmin/issues/357)). 0.10.0 moved `psycopg2-binary` into the optional `[cloud]` extra to spare self-hosted SQLite installs a database driver, but the Vercel one-click deploy installs the base dependencies (not the extra), so the dashboard died the moment it queried Postgres. `psycopg2-binary` is restored to the base dependencies; it ships prebuilt wheels, so self-hosters take only a small wheel with no compilation.

## [0.10.0] - 2026-08-28

### Added
- Timezone setting so Strava shows the correct local time ([#348](https://github.com/drkostas/hevy2garmin/pull/348)). Hevy hands out UTC-only timestamps, so uploads carried no local offset and Garmin could forward them to Strava as raw UTC (a 6am workout showing up as a 3am "Night" workout). Set your timezone in Settings (Profile, an IANA name like `Europe/Berlin`) and the uploaded FIT now carries a DST-correct `local_timestamp` so the local time travels with the activity. Leave it blank to keep the previous behaviour.
- Mappings for 21 previously-unmapped exercises in Hevy's global catalog, plus Walking Lunge (Sandbag), Burpee Broad Jumps and Sled Pull ([#292](https://github.com/drkostas/hevy2garmin/pull/292), [#294](https://github.com/drkostas/hevy2garmin/pull/294), thanks @OliverKrr).
- Normalized-title fallback so an exercise whose name only differs by formatting still maps instead of falling back to a generic type ([#303](https://github.com/drkostas/hevy2garmin/pull/303), thanks @OliverKrr).
- Reverse-proxy sub-path support, so the dashboard can be served under a path prefix ([#305](https://github.com/drkostas/hevy2garmin/pull/305), thanks @OliverKrr).
- Every single-workout sync is now recorded in the sync log ([#306](https://github.com/drkostas/hevy2garmin/pull/306), thanks @OliverKrr).
- Optional Hevy-webhook sync, staged so a watch merge still wins over a plain upload ([#307](https://github.com/drkostas/hevy2garmin/pull/307), thanks @OliverKrr).
- When Replace swaps a watch activity, the replaced copy is now also removed from intervals.icu ([#308](https://github.com/drkostas/hevy2garmin/pull/308), thanks @OliverKrr).
- Timestamps on log lines, so container logs show when each sync ran and how long it took ([#341](https://github.com/drkostas/hevy2garmin/pull/341), thanks @diogormendes).

### Fixed
- Exercise names newer than the bundled FIT enums now resolve through the bundled catalog instead of rendering as a generic type ([#329](https://github.com/drkostas/hevy2garmin/issues/328), thanks @alasano).
- Merge mode no longer shows pushed exercises as "Unknown" on Garmin Connect. The set payload now sends confidence 100 for named exercises, which is what Connect needs to render the name while keeping the watch's native metrics ([#330](https://github.com/drkostas/hevy2garmin/issues/325), thanks @alasano).
- `generate_description` no longer raises a `TypeError` on sets with null reps or weight (bodyweight and cardio) ([#309](https://github.com/drkostas/hevy2garmin/pull/309), thanks @gianluca-mazza).
- The dashboard heart-rate endpoint no longer crashes when Garmin returns a null daily-HR series for the current day ([#327](https://github.com/drkostas/hevy2garmin/issues/326)).
- Several exercise-mapping corrections: the generated template map no longer overrides the hand-maintained table, generic entries use the correct sentinel, and Pallof Press, machine chest press, hip abduction and Overhead Dumbbell Lunge now map to their exact FIT matches ([#272](https://github.com/drkostas/hevy2garmin/pull/272), [#274](https://github.com/drkostas/hevy2garmin/pull/274), [#276](https://github.com/drkostas/hevy2garmin/pull/276), [#278](https://github.com/drkostas/hevy2garmin/pull/278), [#290](https://github.com/drkostas/hevy2garmin/pull/290), thanks @OliverKrr).
- An excluded activity id is never adopted from the Garmin import result ([#280](https://github.com/drkostas/hevy2garmin/pull/280), thanks @OliverKrr).

### Changed
- The default watch strategy is now `merge`, which keeps your recorded activity and its native metrics while pushing in the Hevy exercise names ([#332](https://github.com/drkostas/hevy2garmin/pull/332)). `replace` and `describe` remain available in Settings.
- `fit-tool` is no longer capped below 0.9.16. The heart-rate parsing that appeared to break on 0.9.16 was a signature mismatch in our own lenient-string patch, now fixed to work on both the old and new APIs ([#337](https://github.com/drkostas/hevy2garmin/pull/337), thanks @diogormendes).

### Internal
- Auto-sync now runs as an asyncio task with a clean lifespan shutdown instead of a background `threading.Timer`, and the shared sync state and loop were extracted into their own modules ([#338](https://github.com/drkostas/hevy2garmin/pull/338), [#342](https://github.com/drkostas/hevy2garmin/pull/342), thanks @diogormendes).
- HTTP-level test coverage now reaches every route (42/42), with the guard rails on the state-mutating ones mutation-tested ([#339](https://github.com/drkostas/hevy2garmin/pull/339), [#340](https://github.com/drkostas/hevy2garmin/pull/340), thanks @diogormendes), plus a regression corpus built from a real Hevy history ([#334](https://github.com/drkostas/hevy2garmin/pull/334), thanks @OliverKrr).
- Docker image split into builder and runtime stages, self-hosting documented as a first-class path, and an exercise-mapping audit against the FIT SDK ([#282](https://github.com/drkostas/hevy2garmin/pull/282), [#296](https://github.com/drkostas/hevy2garmin/pull/296), [#284](https://github.com/drkostas/hevy2garmin/pull/284), thanks @OliverKrr). `psycopg2-binary` moved to the optional `cloud` extra ([#335](https://github.com/drkostas/hevy2garmin/pull/335), thanks @diogormendes).

## [0.9.0] - 2026-07-28

### Added
- "Updated on Hevy" badge on the Routines page ([#265](https://github.com/drkostas/hevy2garmin/pull/265), thanks @bcandido). A synced routine that changed on Hevy since its last sync now shows an amber "Updated on Hevy" badge and an "Update" button, and the sync bar counts how many routines have drifted. The badge compares the exact Garmin payload hash a sync would produce against the last synced hash, so it means precisely "a sync would recreate this", not just "the Hevy timestamp moved".
- Detection of planned workouts deleted on Garmin ([#266](https://github.com/drkostas/hevy2garmin/pull/266), thanks @bcandido). If you delete a hevy2garmin-created planned workout in Garmin Connect, the Routines page now notices (reconciling tracked workouts against your Garmin library on load), shows a "Removed on Garmin" badge with a "Re-create" button, and the next sync recreates and reschedules it. The check fails safe: a listing error is never read as "everything was deleted", and it only ever acts on workouts carrying hevy2garmin's provenance marker, so a workout you built by hand in Garmin is never touched.

### Fixed
- Re-syncing a routine no longer plants past scheduled dates in Garmin's calendar history ([#264](https://github.com/drkostas/hevy2garmin/pull/264), thanks @bcandido). Restored schedule dates are now filtered to today or later, and orphaned schedule rows are pruned when every prior date is already past. An explicitly chosen date is still booked as-is.
- The Garmin workout listing now fails safe on an unexpected non-list response body ([#269](https://github.com/drkostas/hevy2garmin/pull/269)). A transient error-as-200 previously read as an empty library, which could briefly flag every synced routine as removed on Garmin; it now degrades to the last-known state instead.

## [0.8.0] - 2026-07-24

### Added
- Per-routine sync on the Routines page ([#255](https://github.com/drkostas/hevy2garmin/pull/255), thanks @bcandido). Each routine now has its own Sync / Re-sync button, so you can create or re-create a single planned workout on Garmin without running a full sync. A single sync uses the same safe reconciliation as the bulk path: it only ever replaces a Garmin workout carrying hevy2garmin's provenance marker (never one you built by hand), persists the workout before scheduling so a mid-sync failure can't orphan or duplicate it, and restores the routine's existing scheduled dates.
- Redesigned Routines page ([#255](https://github.com/drkostas/hevy2garmin/pull/255), thanks @bcandido). Routines are shown as cards with a clear on-Garmin / pending status, an expandable exercise list, and a per-routine schedule panel. A toolbar adds All / On Garmin / Pending filters (a "show only unsynced" view) and a name search, and a summary strip shows how many routines are on Garmin with a progress bar.

## [0.7.0] - 2026-07-24

### Added
- Hardened dashboard authentication. Failed logins are now rate-limited per client IP with exponential backoff and a global cap (HTTP 429 on lockout), so the login can't be brute-forced. The dashboard password can be supplied pre-hashed via `H2G_PASSWORD_HASH` (argon2, generated with `hevy2garmin hash-password`) so the plaintext never sits in the environment; session cookies gain the `Secure` flag over HTTPS and are signed with an optional dedicated `H2G_SECRET` (session lifetime configurable via `H2G_SESSION_TTL_DAYS`, default 30 days); a "Sign out everywhere" action invalidates every active session; and standard security headers (HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, a baseline CSP) are sent on every response. Existing password-only deployments keep working unchanged.

## [0.6.4] - 2026-07-24

### Fixed
- Replace now works on watch activities whose FIT file contains a non-UTF-8 byte in a string field ([#244](https://github.com/drkostas/hevy2garmin/issues/244)). Some devices (a Garmin Fenix 7 Pro was the first confirmed) write a manufacturer or product name with a byte that isn't valid UTF-8, and fit-tool decoded FIT strings strictly, so a single bad byte raised an error that aborted the entire heart-rate extraction. HR extraction now decodes FIT strings leniently, so the file parses and the heart rate comes through, letting Replace upload a named activity instead of falling back to keeping the watch copy (which showed exercise names as "unknown").

## [0.6.3] - 2026-07-24

### Fixed
- The Replace watch strategy now extracts heart rate from the watch activity's own recording without an over-strict time window ([#244](https://github.com/drkostas/hevy2garmin/issues/244)). Previously it only kept HR samples that fell inside the Hevy workout window (plus a 3-minute buffer), so a watch activity whose clock differed from the Hevy log by more than a few minutes lost all of its HR and fell back to keeping the watch copy, with exercise names then showing as "unknown". It now takes every heart-rate record from the activity's own file, since that file is a single recording of the workout. When no HR can be extracted, the reason is now logged instead of silently swallowed, so genuine device-specific extraction failures can be diagnosed.

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
