/**
 * GitHub integration for auto-sync on a fork (port of the Python dashboard's
 * get_github_pat / _setup_github_actions / _build_sync_workflow_yaml, #458).
 *
 * The token lives in `platform_credentials` (platform 'github', credentials.pat) — the
 * row the Python dashboard writes from its Settings page — with GITHUB_PAT as the env
 * fallback. Never log or return the token.
 */
import sodium from "libsodium-wrappers";
import type { getDb } from "./db";
import { legacyEnvironmentValue } from "./profile-context";

type Sql = ReturnType<typeof getDb>;

/** The token: DB row first (set in-app), then the GITHUB_PAT environment variable. */
export async function getGithubPat(sql: Sql | null): Promise<string | null> {
  if (sql) {
    try {
      const rows = (await sql`SELECT credentials FROM platform_credentials WHERE platform = 'github' LIMIT 1`) as { credentials: unknown }[];
      const c = rows[0]?.credentials;
      const creds = typeof c === "string" ? (JSON.parse(c) as Record<string, unknown>) : (c as Record<string, unknown> | undefined);
      const pat = creds?.pat;
      if (typeof pat === "string" && pat.trim()) return pat.trim();
    } catch { /* fall through to env */ }
  }
  const env = (await legacyEnvironmentValue("GITHUB_PAT"))?.trim();
  return env || null;
}

/** Store the token the way the Python dashboard does (same row, same keys). */
export async function saveGithubPat(sql: Sql, pat: string): Promise<void> {
  await sql`
    INSERT INTO platform_credentials (platform, auth_type, credentials, status)
    VALUES ('github', 'pat', ${sql.json({ pat })}, 'active')
    ON CONFLICT (platform) DO UPDATE SET credentials = EXCLUDED.credentials, status = 'active'`;
}

/** "owner/repo": GITHUB_REPO, else Vercel's git metadata (a fork deployed from GitHub). */
export function getGithubRepo(): string | null {
  const explicit = process.env.GITHUB_REPO?.trim();
  if (explicit) return explicit;
  const owner = process.env.VERCEL_GIT_REPO_OWNER?.trim();
  const slug = process.env.VERCEL_GIT_REPO_SLUG?.trim();
  return owner && slug ? `${owner}/${slug}` : null;
}

function gh(pat: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`https://api.github.com/repos/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${pat}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", ...(init.headers ?? {}) },
    signal: init.signal ?? AbortSignal.timeout(10_000),
  });
}

/** repository_dispatch 'sync-trigger' → the fork's sync workflow runs the long sync off the request path. */
export async function triggerViaActions(pat: string, repo: string): Promise<boolean> {
  const res = await gh(pat, `${repo}/dispatches`, { method: "POST", body: JSON.stringify({ event_type: "sync-trigger" }) });
  return res.ok;
}

/** Interval (minutes) → cron. Same table as the Python dashboard's select: 30, 60, 120, 240, 360, 720, 1440. */
export function minutesToCron(minutes: number): string {
  if (minutes === 30) return "*/30 * * * *";
  if (minutes === 60) return "0 * * * *";
  if (minutes === 1440) return "0 0 * * *";
  if (minutes >= 60 && minutes % 60 === 0) return `0 */${Math.floor(minutes / 60)} * * *`;
  return "0 */2 * * *";
}

export function formatIntervalLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  if (minutes === 60) return "1 hour";
  if (minutes === 1440) return "24 hours";
  if (minutes % 60 === 0) return `${Math.floor(minutes / 60)} hours`;
  return `${minutes} minutes`;
}

/** The workflow the Python dashboard writes into the fork, byte-for-byte. */
export function buildSyncWorkflowYaml(intervalMinutes: number): string {
  const cron = minutesToCron(intervalMinutes);
  return (
    "name: Sync Workouts\n\n" +
    "on:\n" +
    "  schedule:\n" +
    `    - cron: '${cron}'\n` +
    "  workflow_dispatch: {}\n" +
    "  repository_dispatch:\n" +
    "    types: [sync-trigger]\n\n" +
    "concurrency:\n" +
    "  group: sync\n" +
    "  cancel-in-progress: false\n\n" +
    "jobs:\n" +
    "  sync:\n" +
    "    runs-on: ubuntu-latest\n" +
    "    timeout-minutes: 30\n" +
    "    steps:\n" +
    "      - uses: actions/checkout@v5\n" +
    "      - uses: actions/setup-python@v6\n" +
    "        with:\n" +
    "          python-version: '3.12'\n" +
    "      - name: Install\n" +
    "        run: pip install \".[cloud]\"\n" +
    "      - name: Sync\n" +
    "        env:\n" +
    "          DATABASE_URL: ${{ secrets.DATABASE_URL }}\n" +
    "        run: hevy2garmin sync\n"
  );
}

const WF_PATH = "contents/.github/workflows/sync.yml";

/** GitHub's secret encryption: a libsodium sealed box over the repo's public key. */
export async function sealSecret(publicKeyB64: string, value: string): Promise<string> {
  await sodium.ready;
  const pk = sodium.from_base64(publicKeyB64, sodium.base64_variants.ORIGINAL);
  const sealed = sodium.crypto_box_seal(sodium.from_string(value), pk);
  return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
}

export interface SetupResult { ok: boolean; message: string }

/**
 * Configure auto-sync on the fork: make the repo public, enable Actions, store DATABASE_URL
 * as a repo secret, write .github/workflows/sync.yml, then fire the first sync-trigger.
 * Same calls and order as the Python `_setup_github_actions`.
 */
export async function setupGithubActions(opts: { pat: string; repo: string; databaseUrl: string; intervalMinutes?: number; fetchImpl?: typeof fetch }): Promise<SetupResult> {
  const interval = opts.intervalMinutes ?? 120;
  const { pat, repo, databaseUrl } = opts;
  const f = opts.fetchImpl ?? fetch;
  const call = (path: string, init: RequestInit = {}) => f(`https://api.github.com/repos/${repo}${path ? `/${path}` : ""}`, {
    ...init, headers: { Authorization: `Bearer ${pat}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" }, signal: AbortSignal.timeout(10_000),
  });
  try {
    const [, actions, pk, wf] = await Promise.all([
      call("", { method: "PATCH", body: JSON.stringify({ private: false }) }),
      call("actions/permissions", { method: "PUT", body: JSON.stringify({ enabled: true }) }),
      call("actions/secrets/public-key"),
      call(WF_PATH),
    ]);
    if (![200, 204].includes(actions.status)) return { ok: false, message: `Failed to enable Actions: HTTP ${actions.status}` };
    if (!pk.ok) return { ok: false, message: `Failed to get repo public key: HTTP ${pk.status}` };
    const pkData = (await pk.json()) as { key: string; key_id: string };
    const encrypted = await sealSecret(pkData.key, databaseUrl);
    const payload: Record<string, string> = {
      message: `feat: auto-sync every ${formatIntervalLabel(interval)}`,
      content: Buffer.from(buildSyncWorkflowYaml(interval), "utf8").toString("base64"),
    };
    if (wf.status === 200) { const j = (await wf.json()) as { sha?: string }; if (j.sha) payload.sha = j.sha; }
    const [secret] = await Promise.all([
      call("actions/secrets/DATABASE_URL", { method: "PUT", body: JSON.stringify({ encrypted_value: encrypted, key_id: pkData.key_id }) }),
      call(WF_PATH, { method: "PUT", body: JSON.stringify(payload) }),
    ]);
    if (![200, 201, 204].includes(secret.status)) return { ok: false, message: `Failed to set DATABASE_URL secret: HTTP ${secret.status}` };
    void call("dispatches", { method: "POST", body: JSON.stringify({ event_type: "sync-trigger" }) }).catch(() => undefined);
    return { ok: true, message: `Auto-sync enabled! Workouts will sync every ${formatIntervalLabel(interval)}.` };
  } catch (e) {
    return { ok: false, message: `Failed to set up auto-sync: ${(e as Error).message}` };
  }
}

/** Disable: delete the workflow file from the fork (best effort, like the Python side). */
export async function disableGithubActions(opts: { pat: string; repo: string; fetchImpl?: typeof fetch }): Promise<boolean> {
  const f = opts.fetchImpl ?? fetch;
  const call = (path: string, init: RequestInit = {}) => f(`https://api.github.com/repos/${opts.repo}${path ? `/${path}` : ""}`, {
    ...init, headers: { Authorization: `Bearer ${opts.pat}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" }, signal: AbortSignal.timeout(10_000),
  });
  try {
    const wf = await call(WF_PATH);
    if (wf.status !== 200) return false;
    const { sha } = (await wf.json()) as { sha?: string };
    const del = await call(WF_PATH, { method: "DELETE", body: JSON.stringify({ message: "disable auto-sync", sha }) });
    return del.ok;
  } catch { return false; }
}
