# Contributing to hevy2garmin

Thanks for your interest. This doc covers the dev loop and the release process.

## Dev setup

```bash
git clone https://github.com/drkostas/hevy2garmin.git
cd hevy2garmin
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev,cloud]"
```

## Running tests

```bash
PYTHONPATH=src pytest tests/ -q
```

## Running the dashboard locally

```bash
PYTHONPATH=src python -m hevy2garmin.cli serve --port 8123
```

Dev server runs on `http://localhost:8123`.

## Workflow

1. **Start from an issue.** If one doesn't exist, open it first.
2. **Branch from `main`** with a name that references the issue: `fix/12-name` or `feat/42-thing`.
3. **Commit.** Small, focused commits. Conventional prefixes (`feat:`, `fix:`, `perf:`, `docs:`, `cleanup:`) are appreciated.
4. **Open a PR** with `Closes #N` in the body so merging auto-closes the issue.
5. **Wait for CI** (`.github/workflows/ci.yml` — runs pytest + ruff on Python 3.10/3.11/3.12).
6. **Merge.** `main` is protected; PRs are required.

## Releasing to PyPI

Releases are automated. **Just bump the version in `pyproject.toml` and merge to main.**

### Step by step

1. Update `version` in `pyproject.toml` following [SemVer](https://semver.org):
   - patch (`0.1.2` → `0.1.3`) for bug fixes
   - minor (`0.1.2` → `0.2.0`) for backwards-compatible features
   - major (`0.1.2` → `1.0.0`) for breaking changes
2. Move the `## [Unreleased]` section in `CHANGELOG.md` to `## [X.Y.Z]` with today's date, and open a new empty `## [Unreleased]` at the top.
3. Open a PR titled `release: vX.Y.Z`.
4. After merge, `.github/workflows/publish.yml` detects the version change on `main`, builds the wheel + sdist, tags the commit as `vX.Y.Z`, and publishes to PyPI.
5. Verify at https://pypi.org/project/hevy2garmin/ and on the [Releases tab](https://github.com/drkostas/hevy2garmin/releases).

### How the automation works

`publish.yml` has two jobs:
- `check-version` diffs `pyproject.toml` against `HEAD~1` on every push to `main`. If the version string changed, it outputs `should_publish=true`.
- `publish` runs only when `should_publish=true`. It's pinned to the `pypi` environment and has `id-token: write` permission for OIDC trusted publishing — no API tokens stored in the repo.

### Trusted publisher setup

PyPI is configured to trust this specific workflow:

| Field | Value |
|---|---|
| PyPI project | `hevy2garmin` |
| Owner | `drkostas` |
| Repository | `hevy2garmin` |
| Workflow filename | `publish.yml` |
| Environment | `pypi` |

Every publish mints a short-lived token from GitHub's OIDC identity — nothing is stored long-term.

### If a publish fails

- Check the **Actions** tab → failed run → `publish` job logs.
- Common causes: version wasn't actually bumped, CI failing on tests, PyPI trust config drift.
- To retry: fix the issue, bump the patch version again, open another release PR. Don't try to re-run a failed publish — the version already exists on PyPI once a successful upload lands.

## Reporting bugs

Open an issue at https://github.com/drkostas/hevy2garmin/issues. Include:
- What you ran
- What you expected
- What actually happened (with logs if possible)
- Your environment (local / Docker / Vercel)
