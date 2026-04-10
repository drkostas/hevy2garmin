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
- Python 3.10+ (for local install only, not needed for one-click deploy)

## Quick Start

Pick the option that fits you best:

### One-Click Deploy (no coding required)

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

**Step 4: Deploy to Vercel**

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fdrkostas%2Fhevy2garmin&env=HEVY_API_KEY,GARMIN_EMAIL,GARMIN_PASSWORD,GITHUB_PAT&envDescription=Hevy%20API%20key%2C%20Garmin%20credentials%2C%20and%20GitHub%20PAT%20(repo%2Bworkflow%20scopes)&stores=%5B%7B%22type%22%3A%22postgres%22%7D%5D&project-name=hevy2garmin)

Click the button above. Sign in with GitHub if prompted. You'll see a few screens:

1. **Create Git Repository** -- leave the defaults (private is fine) and click **Create**
2. **Add Products > Neon** -- click **Add**, then **Continue** on the plan screen, select your project from the dropdown, and click **Connect**
3. **Environment Variables** -- fill in these 4 values:

| Field | What to paste |
|-------|--------------|
| `HEVY_API_KEY` | The API key from step 1 |
| `GARMIN_EMAIL` | Your Garmin Connect email |
| `GARMIN_PASSWORD` | Your Garmin Connect password |
| `GITHUB_PAT` | The token from step 3 |

4. Click **Deploy** and wait about a minute for it to build.

**Step 5: Connect Garmin**

Click **Continue to Dashboard**, then **Visit** to open your app. Bookmark this URL -- it's your dashboard.

On the setup page, enter your Garmin email and password and click **Connect**.

- If your Garmin account **does not** have 2FA enabled, you're connected in a second. That's it.
- If your Garmin account **has 2FA enabled**, Garmin emails you a 6-digit code. A code input appears on the page, paste the code, click **Verify**. Done.

Then click **Save & Continue**.

Garmin blocks automated logins from cloud servers (AWS, Azure, Vercel), so hevy2garmin routes the login through a Cloudflare Worker that runs on Cloudflare's edge network. Garmin accepts those IPs, so the whole flow happens in a single click from the dashboard -- no browser tab switching, no URL copying.

> **Fallback for edge cases:** on the rare occasion Garmin doesn't accept the direct login (most often when the account has an unusual security configuration), the setup page automatically reveals the old "Sign into Garmin in a new tab and paste the URL back" flow as a safety net. You don't need to do anything differently -- just follow the instructions the page shows you.

**Step 6: Sync your workouts**

You're on the dashboard. Click **Sync All Workouts** to backfill your history. The app syncs one workout at a time (you can close the page and come back, it picks up where it left off).

> **EU users:** If you see an upload consent error, go to [Garmin Connect Settings](https://connect.garmin.com/modern/settings) > scroll to **Data** > enable **Device Upload**. This is a one-time Garmin GDPR requirement.

To keep future workouts syncing automatically, toggle **Auto-sync** on the dashboard. This creates a background job that syncs new workouts every 2 hours.

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
