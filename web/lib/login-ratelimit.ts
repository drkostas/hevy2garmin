/**
 * Dashboard login rate-limiting with exponential backoff — port of the Python
 * hevy2garmin.login_ratelimit. Protects POST /api/login from brute-force
 * guessing: tracks failed attempts per client IP (plus a global counter that
 * blunts distributed guessing) and enforces a short lockout that backs off
 * exponentially. State lives in the app_cache key-value table so it survives
 * serverless restarts.
 *
 * Tuned for a single human admin: 5 tries per IP, minute-scale lockouts capped
 * at 15 min. All functions are BEST-EFFORT — a storage failure NEVER throws and
 * NEVER locks the admin out (same guarantee as the Python module).
 */
import type { getDb } from "./db";

type Sql = ReturnType<typeof getDb>;

const PREFIX = "login_fail:";
const GLOBAL_KEY = PREFIX + "__global__";

const MAX_FAILS = 5; // per-IP failures before the first lockout
const BASE_SECONDS = 60; // first lockout: 1 minute
const MAX_SECONDS = 15 * 60; // cap per-IP lockout at 15 minutes
const GLOBAL_MAX_FAILS = 50; // aggregate failures (all IPs) before a soft global lockout
const GLOBAL_SECONDS = 15 * 60; // global soft lockout window
const WINDOW_SECONDS = 15 * 60; // counters reset if the last failure is older than this

interface FailState {
  fails?: number;
  until?: string | null;
  ts?: string | null;
}

async function readState(sql: Sql, key: string): Promise<FailState> {
  try {
    const rows = (await sql`SELECT value FROM app_cache WHERE key = ${key} LIMIT 1`) as Array<{
      value: unknown;
    }>;
    const v = rows[0]?.value;
    return v && typeof v === "object" ? (v as FailState) : {};
  } catch {
    return {};
  }
}

async function writeState(sql: Sql, key: string, state: FailState): Promise<void> {
  try {
    await sql`
      INSERT INTO app_cache (key, value, updated_at)
      VALUES (${key}, ${sql.json(state)}, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `;
  } catch {
    /* best-effort: never let a storage failure lock the admin out */
  }
}

function secondsUntil(iso: string | null | undefined): number {
  if (!iso) return 0;
  const until = Date.parse(iso);
  if (Number.isNaN(until)) return 0;
  const remaining = Math.floor((until - Date.now()) / 1000);
  return remaining > 0 ? remaining : 0;
}

/** Seconds left in this key's lockout, or 0. Best-effort → 0 on any error. */
async function remaining(sql: Sql, key: string): Promise<number> {
  const state = await readState(sql, key);
  return secondsUntil(state.until);
}

/** Record one failure with a rolling window + exponential backoff. Returns lock seconds. */
async function bump(
  sql: Sql,
  key: string,
  maxFails: number,
  base: number,
  cap: number,
): Promise<number> {
  const now = Date.now();
  const state = await readState(sql, key);
  let fails = Number(state.fails ?? 0);
  if (state.ts) {
    const last = Date.parse(state.ts);
    if (!Number.isNaN(last) && (now - last) / 1000 > WINDOW_SECONDS) fails = 0;
  }
  fails += 1;

  let lockSecs = 0;
  let untilIso: string | null = null;
  if (fails >= maxFails) {
    const over = fails - maxFails; // 0 on first lockout, grows on repeats
    lockSecs = Math.min(base * 2 ** over, cap);
    untilIso = new Date(now + lockSecs * 1000).toISOString();
  }
  await writeState(sql, key, { fails, until: untilIso, ts: new Date(now).toISOString() });
  return lockSecs;
}

/** Seconds this client must wait before another attempt (0 = allowed). */
export async function lockoutRemaining(sql: Sql, clientKey: string): Promise<number> {
  const perIp = await remaining(sql, PREFIX + clientKey);
  const global = await remaining(sql, GLOBAL_KEY);
  return Math.max(perIp, global);
}

/** Record a failed login for this client (and the global counter). */
export async function recordFailure(sql: Sql, clientKey: string): Promise<void> {
  await bump(sql, PREFIX + clientKey, MAX_FAILS, BASE_SECONDS, MAX_SECONDS);
  await bump(sql, GLOBAL_KEY, GLOBAL_MAX_FAILS, GLOBAL_SECONDS, GLOBAL_SECONDS);
}

/** Clear this client's failure counter after a successful login. */
export async function clearFailures(sql: Sql, clientKey: string): Promise<void> {
  await writeState(sql, PREFIX + clientKey, { fails: 0, until: null, ts: null });
}

/** Human "1 min 30 sec" style cooldown label — matches the Python format_cooldown. */
export function formatCooldown(seconds: number): string {
  if (seconds <= 0) return "0 sec";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m && s) return `${m} min ${s} sec`;
  if (m) return `${m} min`;
  return `${s} sec`;
}
