<p align="center">
  <img src="src/hevy2garmin/static/favicon.svg" width="80" height="80" alt="hevy2garmin logo">
</p>

<h1 align="center">hevy2garmin</h1>

<p align="center">
  <a href="https://github.com/drkostas/hevy2garmin/actions/workflows/ci.yml"><img src="https://github.com/drkostas/hevy2garmin/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://pypi.org/project/hevy2garmin/"><img src="https://img.shields.io/pypi/v/hevy2garmin" alt="PyPI"></a>
  <a href="https://pypi.org/project/hevy2garmin/"><img src="https://img.shields.io/pypi/pyversions/hevy2garmin" alt="Python"></a>
</p>

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

Open [hevy.com/settings](https://hevy.com/settings), scroll to **Integrations & API**, click **Generate API Key**, and copy it. If you don't see this section, you need to upgrade to Hevy Pro.

**Step 2: Create a free GitHub account** (skip if you already have one)

Sign up at [github.com](https://github.com/signup). You'll use this to sign into Vercel too.

**Step 3: Create a GitHub access token**

This token lets hevy2garmin set up automatic syncing on your behalf. Open [this link](https://github.com/settings/tokens/new?scopes=repo,workflow&description=hevy2garmin) (sign in if prompted):

1. Set **Expiration** to **No expiration** (otherwise auto-sync stops when it expires)
2. Scroll to the bottom, click **Generate token**
3. **Copy the token immediately** (starts with `ghp_`). GitHub only shows it once.

**Step 4: Fork the repo**

[Fork hevy2garmin on GitHub](https://github.com/drkostas/hevy2garmin/fork) -- click the green **Create fork** button. This gives you your own copy that stays linked to the original, so you can pull updates later with one click.

**Step 5: Deploy to Vercel**

1. Go to [vercel.com/new](https://vercel.com/new) and sign in with GitHub
2. Find **hevy2garmin** in your repo list and click **Import**
3. **Add a database (required).** If you see an **Integrations** or **Storage** section during import, add **Neon Postgres** (it's free). This is where your sync history lives. If you don't see it during import, that's fine: deploy first, then open your project's **Storage** tab, add **Neon Postgres**, and redeploy. A serverless host has a read-only filesystem, so with no database the app can't save anything and shows an "internal server error".
4. **Environment Variables.** Vercel does not pre-fill these. The form shows an empty field with a placeholder like `EXAMPLE_NAME`. Add each of the four below as its own variable: type the name in **Key**, the value in **Value**, then click **Add More** for the next one.

| Key | What to paste |
|-------|--------------|
| `HEVY_API_KEY` | The API key from step 1 |
| `GARMIN_EMAIL` | Your Garmin Connect email |
| `GARMIN_PASSWORD` | Your Garmin Connect password |
| `GITHUB_PAT` | The token from step 3 |

5. Click **Deploy** and wait about a minute for it to build. If the deployed page shows an "internal server error", it almost always means the database step was skipped: add **Neon Postgres** from the **Storage** tab, then redeploy.

**Step 6: Connect Garmin**

Click **Continue to Dashboard**, then **Visit** to open your app. Bookmark this URL -- it's your dashboard.

On the setup page, enter your Garmin email and password and click **Connect**.

- If your Garmin account **does not** have 2FA enabled, you're connected in a second. That's it.
- If your Garmin account **has 2FA enabled**, Garmin emails you a 6-digit code. A code input appears on the page, paste the code, click **Verify**. Done.

Then click **Save & Continue**.

Garmin blocks automated logins from cloud servers (AWS, Azure, Vercel), so hevy2garmin routes the login through a Cloudflare Worker that runs on Cloudflare's edge network. Garmin accepts those IPs, so the whole flow happens in a single click from the dashboard -- no browser tab switching, no URL copying.

> **Fallback for edge cases:** on the rare occasion Garmin doesn't accept the direct login (most often when the account has an unusual security configuration), the setup page automatically reveals the old "Sign into Garmin in a new tab and paste the URL back" flow as a safety net. You don't need to do anything differently -- just follow the instructions the page shows you.

**Step 7: Sync your workouts**

You're on the dashboard. Click **Sync All Workouts** to backfill your history. The app syncs one workout at a time (you can close the page and come back, it picks up where it left off).

> **EU users:** If you see an upload consent error, go to [Garmin Connect Settings](https://connect.garmin.com/modern/settings) > scroll to **Data** > enable **Device Upload**. This is a one-time Garmin GDPR requirement.

To keep future workouts syncing automatically, toggle **Auto-sync** on the dashboard. This creates a background job that syncs new workouts every 2 hours.

> **Sync timing:** hevy2garmin waits `sync.grace_period_minutes` (default 120)
> after a workout ends before syncing it automatically, so your Garmin watch
> activity can land first and it merges into one activity instead of creating a
> duplicate. On Vercel the default cron runs once a day; if your plan allows,
> lower the cron interval (e.g. every few hours) so recently-finished workouts
> sync the same day. Manual "Sync now" always ignores the grace period.

**That's it.** Check [Garmin Connect](https://connect.garmin.com/modern/activities) to see your workouts with proper exercise names, sets, reps, and weights.

### Web Dashboard (local install)

```bash
pip install hevy2garmin
hevy2garmin serve
```

> Not on PyPI yet? Install from source: `git clone https://github.com/drkostas/hevy2garmin.git && cd hevy2garmin && pip install .`

Open [localhost:8123](http://localhost:8123). The setup wizard walks you through connecting Hevy and Garmin.

Once you click **Sync Now**, your workouts appear in [Garmin Connect](https://connect.garmin.com/modern/activities) within a few seconds. Enable **auto-sync** on the dashboard to keep things synced on a schedule (30 min to 24 hours).

To keep the server running in the background:

```bash
nohup hevy2garmin serve > /dev/null 2>&1 &
```

<details>
<summary>systemd service file (Linux)</summary>

Save as `/etc/systemd/system/hevy2garmin.service`:

```ini
[Unit]
Description=hevy2garmin dashboard
After=network.target

[Service]
ExecStart=hevy2garmin serve
Restart=always
User=your-username
Environment=HEVY_API_KEY=your-key
Environment=GARMIN_EMAIL=your-email

[Install]
WantedBy=multi-user.target
```

Then `sudo systemctl enable --now hevy2garmin`.

</details>

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

```bash
git clone https://github.com/drkostas/hevy2garmin.git
cd hevy2garmin
docker build -t hevy2garmin .
```

Before running in Docker, you need Garmin auth tokens. Either:
- Run `pip install hevy2garmin && hevy2garmin init` locally (if you have Python), or
- Run `docker run -it -v ~/.garminconnect:/root/.garminconnect hevy2garmin init` to set up inside Docker interactively

**Web dashboard with auto-sync:**

```bash
docker run -d -p 8123:8123 --restart unless-stopped \
  -v ~/.hevy2garmin:/root/.hevy2garmin \
  -v ~/.garminconnect:/root/.garminconnect \
  -e HEVY_API_KEY=... \
  -e GARMIN_EMAIL=... \
  hevy2garmin serve
```

Open [localhost:8123](http://localhost:8123) and enable auto-sync on the dashboard.

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

For cloud deployments (Vercel, CI/CD), install with Postgres support:

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

1. Go to [Hevy Settings](https://hevyapp.com/settings) > Integrations & API
2. Click **Generate API Key** and copy it
3. Paste it into `hevy2garmin init`, the web dashboard setup, or set as `HEVY_API_KEY` env var

If you don't see the Integrations & API section, you need to upgrade to [Hevy Pro](https://hevyapp.com).

## Credentials

**Three ways to provide credentials** (in order of precedence):
1. CLI flags: `--hevy-api-key`, `--garmin-email`, `--garmin-password`
2. Environment variables: `HEVY_API_KEY`, `GARMIN_EMAIL`, `GARMIN_PASSWORD`
3. Config file: `~/.hevy2garmin/config.json` (created by `hevy2garmin init` or the web dashboard)

See [`.env.example`](.env.example) for all available env vars.

**Garmin authentication:** Only needs the password for initial login. After that, tokens are cached (in `~/.garminconnect` locally or in Postgres for cloud deploys) and refresh automatically.

> **Cloud deploys (Vercel):** Garmin blocks automated logins from cloud servers, so hevy2garmin routes the login through a Cloudflare Worker (`hevy2garmin-exchange-di.gkos.workers.dev`) that runs on Cloudflare's edge network. The Worker accepts your email + password from the setup page, completes the login (including 2FA if enabled), and returns a DI OAuth token that hevy2garmin stores in your Postgres database. This happens in a single click from the setup wizard. On the rare occasion Garmin rejects the direct login, the setup page automatically falls back to a "sign in via browser, paste the URL back" flow.

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

### pip

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
When Garmin pushes an API-uploaded activity to Strava, Strava sometimes uses the
upload time instead of the workout time. The FIT file and Garmin Connect have the
correct time — this is a Garmin→Strava quirk for non-watch uploads and isn't
something hevy2garmin can control.

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
