# Cutover runbook: Python dashboard to the Next.js web dashboard

Tracking issue: [#456](https://github.com/drkostas/hevy2garmin/issues/456).

Both dashboards read and write the same database and the same `platform_credentials`
rows, so they can run side by side against one Neon project. The flip is a Vercel
project setting, not a code change, which is what makes it reversible.

## The gate

Do not flip until all of these are green on `main`:

| Check | What it proves |
| --- | --- |
| Fresh fork (Vercel-style base install) | the Python path still installs and boots from its base dependencies |
| Fresh fork (web, Vercel-style install) | the web path installs from its lockfile and builds with a bare environment |
| Tests (Web) | web unit suite |
| Tests (TypeScript) | the `hevy2garmin` TS package |
| Tests (Postgres), Tests (SQLite 3.10 and 3.12) | the Python path across both stores |
| Playwright parity smoke | all 8 pages render their no-database state, on desktop and mobile |

The parity smoke runs a production build with only a password in the environment
and no `DATABASE_URL`, because that is what a fresh fork sees before it wires Neon.
It runs on its own port so it can never adopt a developer's dev server, which would
otherwise pull in a real `.env.local`.

## The flip

Per-deployment, in the Vercel project. Nothing is pushed to the repo.

1. Settings, then General, then Root Directory. Set it to `web`.
2. Redeploy.

A fork that leaves Root Directory empty keeps deploying the Python dashboard from
`api/index.py`. That is why the setting is used instead of rewriting the root
`vercel.json`: a config change would reach every fork on its next "Sync fork" and
break deployments whose owners had not opted in.

## Rollback

Clear the Root Directory field and redeploy. The next deployment serves the Python
dashboard again.

No data migration is involved in either direction. Both paths share one database,
credentials, and sync history, so a rollback loses nothing that was synced while
the web path was live.

Keep the Python entry point for at least one release after the flip so this remains
a one-setting revert.

## What changes for the operator

Verified differences at the time of writing. None of these block the flip, but a
deployer migrating from the Python path should know about them.

**intervals.icu cleanup stops.** When the Python sync deletes a watch duplicate it
also removes the matching activity from intervals.icu (`sync.py`, via
`try_delete_icu_activity`). The web path has no intervals.icu support at all, so
`INTERVALS_API_KEY` and `INTERVALS_ATHLETE_ID` become inert and deleted watch
duplicates stay on intervals.icu. This is the one silent behaviour change worth
announcing.

**Session lifetime is no longer configurable.** Python reads
`H2G_SESSION_TTL_DAYS`, defaulting to 30 days. The web path fixes the same 30 days
in `web/lib/auth.ts`. Deployers on the default see no change; anyone who set a
custom value silently returns to 30 days.

**`H2G_TRUST_FORWARDED_PREFIX` has no web equivalent.** Relevant only when serving
behind a reverse proxy at a subpath.

**Garmin login moves to the Worker.** `GARMIN_EMAIL`, `GARMIN_PASSWORD` and
`H2G_DIRECT_GARMIN_LOGIN` are Python-only. The web path authenticates through the
Cloudflare Worker from `/setup`, overridable with `GARMIN_LOGIN_WORKER_URL`. Garmin
blocks SSO from cloud IPs, which is why the web path uses the Worker rather than
logging in directly.

## Auth environment

The web path accepts the Python names, so an existing deployment does not have to
change variables to move. Verified against `web/lib/auth.ts`.

Session signing key, first match wins:

1. `HEVY2GARMIN_SECRET`, used as raw bytes, preserving existing deployments.
2. Otherwise `H2G_SECRET`, else `H2G_PASSWORD`, else `H2G_PASSWORD_HASH`, each run
   through `SHA-256("h2g-session-" + seed)` to match the Python derivation.

Login password:

1. `H2G_PASSWORD_HASH` when set, an argon2id string from `hevy2garmin hash-password`.
2. Otherwise the plaintext `H2G_PASSWORD`.

Web-only variables, which have no Python counterpart: `DATABASE_URL`,
`CRON_SECRET`, `GITHUB_REPO`, `GARMIN_LOGIN_WORKER_URL`. See `web/.env.example`.

## Announcing

Policy on #456 is announce before flip. Say so in the README and the changelog
before changing any project setting, and call out the intervals.icu change above,
since that is the one an affected user would otherwise discover on their own.
