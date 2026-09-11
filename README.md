<p align="center">
  <img src="src/hevy2garmin/static/favicon.svg" width="80" height="80" alt="hevy2garmin logo">
</p>

<h1 align="center">hevy2garmin</h1>

<p align="center">
  <a href="https://github.com/drkostas/hevy2garmin/actions/workflows/ci.yml"><img src="https://github.com/drkostas/hevy2garmin/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://pypi.org/project/hevy2garmin/"><img src="https://img.shields.io/pypi/v/hevy2garmin" alt="PyPI"></a>
  <a href="https://pypi.org/project/hevy2garmin/"><img src="https://img.shields.io/pypi/pyversions/hevy2garmin" alt="Python"></a>
</p>

> **0.12.0:** the Python dashboard is gone. The dashboard is the Next.js app in `web/` (Root Directory `web` on Vercel); the PyPI package is the CLI and is deprecated with an end date of **2026-10-31** (#515).


<p align="center">
  Sync your <a href="https://hevyapp.com">Hevy</a> gym workouts to <a href="https://connect.garmin.com">Garmin Connect</a> with correct exercise names, sets, reps, weights, calorie estimation, and optional heart rate overlay from your Garmin watch.
</p>

<p align="center">
  <a href="https://hevy2garmin-demo.gkos.dev"><strong>Try the live demo</strong></a>
  &nbsp;·&nbsp;
  <a href="https://hevy-garmin-explainer.vercel.app"><strong>See how it works</strong></a>
</p>

<p align="center">
  <img src="docs/screenshots/dashboard.png" alt="Dashboard" width="800">
</p>

> **Hevy Pro required.** The Hevy API is only available with a [Hevy Pro](https://hevyapp.com) subscription. Without it, hevy2garmin cannot access your workouts.

## Why?

Hevy is great for tracking gym workouts but doesn't sync to Garmin. This tool bridges the gap:

- **Maps 433+ Hevy exercises** to Garmin FIT SDK categories so bench press shows as bench press, not "Other"
- **Generates proper FIT files** with exercise structure, sets, reps, weights, and timing
- **Uploads to Garmin Connect** with the correct activity name and a detailed description
- **Estimates calories** using the Keytel formula (weight, age, VO2max, heart rate)
- **Overlays heart rate data** from your Garmin watch onto workout charts with per-exercise segments
- **Tracks synced workouts** so nothing gets duplicated

## Screenshots

| Workouts | Mappings |
|----------|----------|
| ![Workouts](docs/screenshots/workouts.png) | ![Mappings](docs/screenshots/mappings.png) |
| **HR Timeline** | **Calorie Breakdown** |
| ![HR Chart](docs/screenshots/hr-chart.png) | ![Calories](docs/screenshots/calories.png) |

## Requirements

- **[Hevy Pro](https://hevyapp.com) subscription** (required for API access)
- A [Garmin Connect](https://connect.garmin.com) account
- Python 3.10+ (for local install only, not needed for the Vercel deploy)

## Quick Start

Pick the option that fits you best:

### Vercel Deploy (no coding required)

Deploy from your phone or computer in about 5 minutes. No terminal or coding needed.

> **You need [Hevy Pro](https://hevyapp.com) for API access.** Free Hevy accounts cannot use hevy2garmin.

**Step 1: Get your Hevy API key**

Open [hevy.com/settings](https://hevy.com/settings), scroll to **Developer** (Hevy recently renamed this section from **Integrations & API**), click **Generate API Key**, and copy it. If you don't see this section, you need to upgrade to Hevy Pro.

**Step 2: Create a free GitHub account** (skip if you already have one)

Sign up at [github.com](https://github.com/signup). You'll use this to sign into Vercel too.

**Step 3: Fork the repo**

[Fork hevy2garmin on GitHub](https://github.com/drkostas/hevy2garmin/fork) -- click the green **Create fork** button. This gives you your own copy that stays linked to the original, so you can pull updates later with one click.

**Step 4: Deploy to Vercel**

1. Go to [vercel.com/new](https://vercel.com/new) and sign in with GitHub
2. Find **hevy2garmin** in your repo list and click **Import**. If your fork isn't listed even though GitHub shows it, click **Adjust GitHub App Permissions** (or **Configure GitHub App**) and grant Vercel access to the repo, then it will appear.
3. **Root Directory: `web`.** On the import screen click **Edit** next to **Root Directory** and enter `web`. This deploys the current dashboard (Next.js). Leaving it empty deploys the older Python dashboard, which still works but no longer gets new features.
4. **Add a database (required).** If you see an **Integrations** or **Storage** section during import, add **Neon Postgres** (it's free). This is where your sync history lives. If you don't see it during import, that's fine: deploy first, then open your project's **Storage** tab, add **Neon Postgres**, and redeploy. A serverless host has a read-only filesystem, so with no database the app can't save anything and shows an "internal server error".
5. Click **Deploy** and wait about a minute for it to build. You don't need to set any environment variables: you enter your Hevy key and Garmin login in the app on the next step. If you want a login on your dashboard, add `H2G_PASSWORD` under **Environment Variables** (you can also do this later, see [Securing the dashboard](#securing-the-dashboard)). If the deployed page shows an "internal server error", it almost always means the database step was skipped: add **Neon Postgres** from the **Storage** tab, then redeploy.

**Step 5: Connect Hevy and Garmin**

Click **Continue to Dashboard**, then **Visit** to open your app. Bookmark this URL -- it's your dashboard.

The setup page walks you through it: paste your Hevy API key from step 1, then enter your Garmin email and password and click **Connect**.

- If your Garmin account **does not** have 2FA enabled, you're connected in a second. That's it.
- If your Garmin account **has 2FA enabled**, Garmin emails you a 6-digit code. A code input appears on the page, paste the code, click **Verify**. Done.

Then click **Save & Continue**.

Garmin blocks automated logins from cloud servers (AWS, Azure, Vercel), so hevy2garmin routes the login through a Cloudflare Worker that runs on Cloudflare's edge network. Garmin accepts those IPs, so the whole flow happens in a single click from the dashboard -- no browser tab switching, no URL copying.

> **Fallback for edge cases:** on the rare occasion Garmin doesn't accept the direct login (most often when the account has an unusual security configuration), the setup page automatically reveals the old "Sign into Garmin in a new tab and paste the URL back" flow as a safety net. You don't need to do anything differently -- just follow the instructions the page shows you.

**Step 6: Sync your workouts**

You're on the dashboard. Click **Sync All Workouts** to backfill your history. The app syncs one workout at a time (you can close the page and come back, it picks up where it left off).

> **EU users:** If you see an upload consent error, go to [Garmin Connect Settings](https://connect.garmin.com/modern/settings) > scroll to **Data** > enable **Device Upload**. This is a one-time Garmin GDPR requirement.

To keep future workouts syncing automatically, toggle **Auto-sync** on the dashboard. The first time, it asks for a GitHub token so it can schedule the job on your fork: create one with `repo` and `workflow` scopes [here](https://github.com/settings/tokens/new?scopes=repo,workflow&description=hevy2garmin) (set **Expiration** to **No expiration** so it doesn't stop later), paste it into **Settings**, then turn **Auto-sync** on. It syncs new workouts every 2 hours.

> **Sync timing:** hevy2garmin waits `sync.grace_period_minutes` (default 120)
> after a workout ends before syncing it automatically, so your Garmin watch
> activity can land first and it merges into one activity instead of creating a
> duplicate. On Vercel the default cron runs once a day; if your plan allows,
> lower the cron interval (e.g. every few hours) so recently-finished workouts
> sync the same day. Manual "Sync now" always ignores the grace period.

**That's it.** Check [Garmin Connect](https://connect.garmin.com/modern/activities) to see your workouts with proper exercise names, sets, reps, and weights.

### Web dashboard (Next.js)

The dashboard Vercel deploys with **Root Directory** `web` is a Next.js app. It uses the same database and the same `platform_credentials` rows as the Python dashboard, so both can run against one Neon project, and switching between them loses nothing.

**Already deployed the Python dashboard on Vercel?** Open your Vercel project, go to **Settings > General > Root Directory**, enter `web`, save, then open **Deployments** and **Redeploy** the latest one. Your database, credentials and sync history carry over as they are. To go back, clear the Root Directory and redeploy. The Python dashboard (`api/index.py`, Root Directory empty) keeps working for existing deployments, but new features land in `web/` only.

To run it locally:

```bash
cd web
cp .env.example .env.local   # fill in DATABASE_URL, H2G_PASSWORD (or H2G_PASSWORD_HASH), HEVY2GARMIN_SECRET (or H2G_SECRET), CRON_SECRET
npm ci && npm run dev        # http://localhost:8096
```

CI runs a fresh-fork check on every change: the web app must install from its lockfile, build, and answer with a bare environment. A red check blocks the merge, so `main` stays deployable for a fresh fork.

[`docs/CUTOVER.md`](docs/CUTOVER.md) is the runbook for switching a deployment over: the checks that gate the flip, the one Vercel setting that performs it, the one that reverses it, and the behaviour differences you inherit. Read it before changing any project setting.

### CLI

```bash
pip install hevy2garmin

# Interactive setup (Hevy API key + Garmin credentials)
hevy2garmin init

# Sync your 10 most recent workouts
hevy2garmin sync

# List recent workouts (checkmark = already synced)
hevy2garmin list

# Check sync status
hevy2garmin status

# Dry run (generate FIT files without uploading)
hevy2garmin sync --dry-run

# Sync last 5 workouts only
hevy2garmin sync -n 5
```

After syncing, check [Garmin Connect](https://connect.garmin.com/modern/activities) to see your workouts.

**Recurring sync without the dashboard:** set up a crontab after running `hevy2garmin init`:

```bash
# Sync every 2 hours (uses credentials saved by hevy2garmin init)
0 */2 * * * hevy2garmin sync
```

### Docker

The image is the CLI. The dashboard is `web/` (above); this is for one-off or scheduled syncs on a box without Python.

```bash
git clone https://github.com/drkostas/hevy2garmin.git
cd hevy2garmin
docker build -t hevy2garmin .
```

Before running in Docker, you need Garmin auth tokens. Either:
- Run `pip install hevy2garmin && hevy2garmin init` locally (if you have Python), or
- Run `docker run -it -v ~/.garminconnect:/root/.garminconnect hevy2garmin init` to set up inside Docker interactively

**One-off sync:**

```bash
docker run --rm \
  -v ~/.hevy2garmin:/root/.hevy2garmin \
  -v ~/.garminconnect:/root/.garminconnect \
  -e HEVY_API_KEY=... \
  -e GARMIN_EMAIL=... \
  hevy2garmin sync
```

### Python API

```bash
pip install hevy2garmin
```

> Deprecated: no releases after 2026-10-31. The npm package `hevy2garmin` and the `web/` dashboard replace it.

Before using the API, make sure credentials are available via `~/.hevy2garmin/config.json` (run `hevy2garmin init`), environment variables, or pass them directly.

```python
from hevy2garmin.sync import sync

# Uses config from ~/.hevy2garmin/config.json (or env vars)
result = sync()
print(f"Synced: {result['synced']}, Skipped: {result['skipped']}")

# Or pass credentials directly (no config file needed)
result = sync(hevy_api_key="...", garmin_email="...", garmin_password="...")
```

```python
# Just the exercise mapper
from hevy2garmin.mapper import lookup_exercise

cat, subcat, name = lookup_exercise("Bench Press (Barbell)")
# (0, 1, "Bench Press (Barbell)")

# Just FIT generation (see Hevy API docs for workout dict format:
# https://docs.hevy.com/#tag/workout/operation/workout)
from hevy2garmin.fit import generate_fit

result = generate_fit(hevy_workout_dict, hr_samples=None, output_path="workout.fit")
```

For self-hosted installs (Docker, local), the base install is sufficient — SQLite is used automatically with no extra dependencies:

```bash
pip install hevy2garmin
```

For cloud deployments (Vercel, CI/CD) that need Postgres support:

```bash
pip install hevy2garmin[cloud]
```

This adds `psycopg2-binary` and enables automatic Postgres backend detection via `DATABASE_URL`.

### TypeScript / npm

The same logic is available as a TypeScript package for Node, serverless functions, and Vercel crons, so you can run the sync without a Python runtime.

```bash
npm install hevy2garmin
```

```ts
import { generateFit, HevyClient } from "hevy2garmin";
```

It lives alongside the Python package in the [`typescript/`](typescript) folder of this repo and is published to npm under the same name. Setup, the full API, and examples are in the [TypeScript README](typescript/README.md). The Python package on PyPI stays fully supported.

## Getting Your Hevy API Key

> **Hevy Pro is required.** API access is not available on the free plan.

1. Go to [Hevy Settings](https://hevyapp.com/settings) > Developer (formerly Integrations & API)
2. Click **Generate API Key** and copy it
3. Paste it into `hevy2garmin init`, the web dashboard setup, or set as `HEVY_API_KEY` env var

If you don't see the Developer section, you need to upgrade to [Hevy Pro](https://hevyapp.com).

## Credentials

**Three ways to provide credentials** (in order of precedence):
1. CLI flags: `--hevy-api-key`, `--garmin-email`, `--garmin-password`
2. Environment variables: `HEVY_API_KEY`, `GARMIN_EMAIL`, `GARMIN_PASSWORD`
3. Config file: `~/.hevy2garmin/config.json` (created by `hevy2garmin init` or the web dashboard)

See [`.env.example`](.env.example) for all available env vars.

**Garmin authentication:** Only needs the password for initial login. After that, tokens are cached (in `~/.garminconnect` locally or in Postgres for cloud deploys) and refresh automatically.

> **Cloud deploys (Vercel):** Garmin blocks automated logins from cloud servers, so hevy2garmin routes the login through a Cloudflare Worker (`hevy2garmin-exchange-di.gkos.workers.dev`) that runs on Cloudflare's edge network. The Worker accepts your email + password from the setup page, completes the login (including 2FA if enabled), and returns a DI OAuth token that hevy2garmin stores in your Postgres database. This happens in a single click from the setup wizard. On the rare occasion Garmin rejects the direct login, the setup page automatically falls back to a "sign in via browser, paste the URL back" flow.

## Securing the dashboard

The web dashboard in `web/` requires a password on every page and API route: set `H2G_PASSWORD` (or an argon2 `H2G_PASSWORD_HASH`) and `HEVY2GARMIN_SECRET` for the session cookie, plus `CRON_SECRET` for the cron and webhook routes. `web/.env.example` lists them. Without `H2G_PASSWORD` the app refuses to serve anything but the setup page, so a public URL is never open by accident.

## Self-hosting

The Vercel deploy is the quickest way to run hevy2garmin, but it is not the only one. The dashboard is the Next.js app in `web/`; it runs anywhere Node runs:

```bash
git clone https://github.com/drkostas/hevy2garmin.git
cd hevy2garmin/web
cp .env.example .env.local   # DATABASE_URL, H2G_PASSWORD, HEVY2GARMIN_SECRET, CRON_SECRET, HEVY_API_KEY
npm ci && npm run build && npm start   # http://localhost:8096
```

Put it behind nginx, Caddy or Traefik on a subdomain, terminate TLS there, and keep the port bound to `127.0.0.1`. `DATABASE_URL` can point at a local Postgres instead of Neon; the schema is created on first start.

### Keeping it in sync

The web app syncs when you press **Sync Now**, on its cron route (`POST /api/cron/sync` with `CRON_SECRET`; Vercel calls it daily, a self-hosted box calls it from cron), and on a Hevy webhook (`POST /api/cron/webhook`, same secret). The CLI is the other option: `hevy2garmin sync` from cron, with credentials saved by `hevy2garmin init`.

### Removing duplicates from intervals.icu

The `replace` watch strategy deletes the watch recording from Garmin once the named activity is uploaded, so Garmin ends up with one activity. Garmin deletions do not propagate, though: if you also sync Garmin to [intervals.icu](https://intervals.icu), the copy it already pulled stays there, and every merged workout leaves a duplicate behind.

Set both of these and hevy2garmin deletes it there as well, matched on the Garmin activity id:

```
INTERVALS_API_KEY=
INTERVALS_ATHLETE_ID=
```

Entirely opt-in — with either one missing the step is skipped. It also never fails a sync: intervals.icu being down or slow is logged and ignored, because the Garmin upload has already succeeded by that point.

### Running as a non-root user

The image runs as uid 999. Named volumes (what the compose file uses) are handled automatically. If you use **bind mounts** instead — the `-v ~/.hevy2garmin:/root/.hevy2garmin` form shown in the Docker section — grant that user access once:

```bash
sudo chown -R 999:999 ~/.hevy2garmin ~/.garminconnect
```

The paths inside the container are unchanged, so nothing needs moving.

## Updating

### Vercel (fork-based deploy)

Your Vercel project is linked to your GitHub fork. To get the latest version:

1. Go to your fork on GitHub (e.g. `github.com/your-username/hevy2garmin`)
2. Click **Sync fork** → **Update branch** (this pulls the latest changes from the original repo)
3. Vercel auto-deploys when your fork updates. Wait ~1 minute for the build to finish.
4. Open your dashboard URL and reconnect Garmin if prompted (token format may change between versions)

**If you deployed before April 2026** using the old one-click button, your repo may be a standalone copy instead of a fork ("Sync fork" button won't appear). To migrate:

1. [Fork hevy2garmin](https://github.com/drkostas/hevy2garmin/fork) to your GitHub account
2. In Vercel dashboard → your project → **Settings** → **Git** → disconnect the old repo
3. Connect the new fork → redeploy
4. Your Neon database and env vars stay intact (they're on the Vercel project, not the repo)
5. You can delete the old standalone copy from GitHub to avoid having two "hevy2garmin" repos

### pip (the CLI)

```bash
pip install --upgrade hevy2garmin
```

### Docker

```bash
cd hevy2garmin
git pull origin main
docker build -t hevy2garmin .
```

### Git clone (local)

```bash
cd hevy2garmin
git pull origin main
pip install -e .
```

## Activity Description

When hevy2garmin syncs a workout, it adds a text description to the Garmin activity summarizing your session:

```
🏋️ Push Day
⏱️ 52 min
🔥 387 kcal
❤️ avg 118 bpm

• Bench Press (Barbell): 3 sets · 80.0kg × 8
• Incline Dumbbell Press: 3 sets · 28.0kg × 10
• Cable Fly: 3 sets · 15.0kg × 12

— synced by hevy2garmin
```

This is visible in the activity details on Garmin Connect and any connected apps (Strava, etc.). Cardio exercises show distance and duration instead of weight and reps.

## Enhance Watch Activities (opt-in)

By default, hevy2garmin creates a new Garmin activity from your Hevy workout using your watch's daily HR monitoring (~2 min sampling). This works without any behavior change. When a matching watch-recorded workout is found and the **Replace** strategy is selected, hevy2garmin instead downloads that activity's high-resolution HR, saves a durable backup, embeds it in the named Hevy FIT, uploads the replacement, and only then deletes the watch copy. If neither the original FIT nor an existing backup is available, replacement stops and preserves the watch activity.

If you start a **Strength Training** activity on your Garmin watch when you hit the gym, you can enable **Enhance Watch Activities** in the config (`"merge_mode": true`). hevy2garmin detects the matching watch activity and combines it with your Hevy data using the configured watch strategy. The in-place strategies keep the original watch activity; Replace creates one named composite activity. Depending on the selected strategy, benefits include:

- **1-second HR sampling** (vs ~2 min in continuous monitoring)
- **Training effect, EPOC, recovery time, and VO2max impact** remain when an in-place strategy keeps the original activity (Garmin does not transfer these to an uploaded replacement)
- **Correct Strava timestamps** (watch-synced activities use the real time, not upload time)
- **Single activity** on Garmin (no duplicate)

If no matching watch activity is found, hevy2garmin falls back to the default flow automatically. Matching requires 70% temporal overlap with a Strength Training activity within 20 minutes of the Hevy workout start time.

### Non-strength watch activities (climbing, etc.)

By default, only watch activities recorded as **Strength Training** are eligible for enhancement. If you record something else on your watch at the same time as your Hevy workout — e.g. a **Climbing** session — it's matched as **Strength Training only**, so it won't be merged and a separate activity is created instead.

To also enhance e.g. climbing sessions, add the Garmin activity type(s) under **Settings → Enhance Watch Activities → Advanced → Additional Watch Activity Types**, using Garmin's internal type names (comma-separated), for example:

```
bouldering, indoor_climbing
```

or set `merge_activity_types` directly in `config.json`:

```json
"merge_activity_types": ["strength_training", "bouldering", "indoor_climbing"]
```

## How It Works

1. Pulls workouts from the Hevy API
2. Maps each exercise to a Garmin FIT SDK category and subcategory (433+ built-in mappings, plus any custom ones you add)
3. Generates a structured FIT file with timing, sets, reps, weights, and calories
4. Optionally fetches HR data from Garmin daily monitoring and overlays it on the workout
5. Authenticates with Garmin via [garmin-auth](https://pypi.org/project/garmin-auth/) (self-healing OAuth)
6. Uploads the FIT file, renames the activity, and sets the description
7. Tracks synced workouts in SQLite (local) or Postgres (cloud) to avoid duplicates

## Exercise Mapping

433+ Hevy exercises are mapped to Garmin FIT SDK categories. If an exercise isn't mapped it falls back to "Unknown" (category 65534). The web dashboard shows unmapped exercises and lets you add custom mappings with a few clicks. You can also add them via CLI:

```bash
hevy2garmin map "My Custom Exercise" --category 28 --subcategory 0
```

## FAQ

**Is the sync one-way?**
Yes — Hevy → Garmin only. Anything you record directly on your watch stays on
Garmin; it does not flow back into Hevy. Keep logging your gym sessions in Hevy
(it's better for that) and this tool makes sure Garmin knows about them.

**Will my gym workouts get duplicated in Health Connect / on my phone (Android)?**
hevy2garmin uploads each Hevy workout to Garmin Connect once, as a single
Strength Training activity (or merges it into a watch-recorded one if you enable
[Enhance Watch Activities](#enhance-watch-activities-opt-in)). It does not write
to Health Connect directly — whatever Garmin Connect chooses to mirror into
Health Connect is Garmin's behavior. If you use Hevy for the gym and Garmin for
running, your runs are untouched; only your Hevy workouts are added.

**Do I need a Hevy Pro subscription?**
Yes. The Hevy API key requires an active Hevy Pro subscription, and the key stops
working once the subscription lapses. See [Getting Your Hevy API Key](#getting-your-hevy-api-key).

**Does it work with non-Garmin watches (Samsung, Amazfit/Zepp, etc.)?**
The tool reads from **Hevy** and writes to **Garmin Connect** — it's not tied to
a specific watch. The destination is always Garmin Connect, so you need a Garmin
account; the watch brand you wear at the gym doesn't matter. It runs in the
browser/cloud, not on the watch.

**My activity shows the wrong time on Strava.**
The FIT file and Garmin Connect have the correct time. The problem is the handoff
to Strava: for uploads that did not come from a real Garmin device, Strava can
render the raw UTC time instead of your local time, so a 6am workout in a UTC+3
zone shows up as 3am. Set your **Timezone** in Settings (Profile section, an IANA
name like `Europe/Berlin`) and the tool stamps your local time into the uploaded
file, so the correct offset travels with the activity. Leave it blank to keep the
previous UTC behaviour.

**Why does Garmin Connect show different calories than hevy2garmin calculated?**
hevy2garmin writes its Keytel estimate into the FIT file (session and lap
`total_calories`). When the file also carries heart-rate samples, Garmin Connect
discards that value and recomputes calories from the HR with its own model and
the weight, age and gender in your Garmin profile. That model is tuned for steady
cardio, so lifting sessions often come out lower than our estimate. The only lever
on Garmin's side is your Garmin Connect profile. Dropping HR from the upload would
keep our number but lose the HR graph and everything Garmin derives from HR, so
the tool keeps HR. Reported in [#343](https://github.com/drkostas/hevy2garmin/issues/343).

**Why is there no Training Effect or recovery time on a synced workout?**
Garmin computes aerobic and anaerobic Training Effect, recovery time and body
battery impact only for activities its own devices recorded. The FIT format has
fields for them, but Garmin Connect ignores those fields on third-party uploads.
If you record the session on your watch and enable
[Enhance Watch Activities](#enhance-watch-activities-opt-in), Garmin keeps the
metrics it computed and the tool adds your Hevy sets to that same activity.
Hevy-only workouts cannot get them. See
[#324](https://github.com/drkostas/hevy2garmin/issues/324) and
[#325](https://github.com/drkostas/hevy2garmin/issues/325).

**Does 2FA / MFA work on Garmin?**
Native 2FA support is in progress (tracked in
[#29 on garmin-auth](https://github.com/drkostas/garmin-auth/issues/29)). For now,
if your Garmin account has 2FA enabled, temporarily disable it, connect through
hevy2garmin, then re-enable it — the auth tokens persist for months afterward.

## Development

```bash
git clone https://github.com/drkostas/hevy2garmin.git
cd hevy2garmin
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
pytest tests/ -v
```

To test the Postgres backend locally:

```bash
pip install -e ".[dev,cloud]"
DATABASE_URL=postgresql://user:pass@localhost:5432/hevy2garmin pytest tests/ -v
```

## License

MIT
