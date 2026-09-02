/**
 * Hevy READ wrappers — the SAFE half of the sync engine.
 *
 * This module ONLY reads from the Hevy API (workout count + full workout list).
 * It never writes to Hevy, never touches Garmin, and never uploads a FIT. The
 * upload half of the pipeline (generateFit / uploadFit / rename / delete) lives
 * elsewhere and is deliberately excluded here — a bad Garmin upload creates a
 * duplicate Garmin/Strava activity, a hard user constraint, so the read side is
 * kept isolated and testable.
 *
 * The Hevy API key is resolved (in order):
 *   1. the `key` argument, if given;
 *   2. process.env.HEVY_API_KEY;
 *   3. the `platform_credentials` row where platform='hevy' (credentials.api_key),
 *      matching how the Python config.py resolves it.
 */
import { HevyClient } from "hevy2garmin";
import { getDb } from "./db";

/** Read the stored Hevy API key from platform_credentials (platform='hevy'). */
async function keyFromDb(): Promise<string | null> {
  let sql: ReturnType<typeof getDb>;
  try {
    sql = getDb();
  } catch {
    return null;
  }
  const rows = await sql`
    SELECT credentials
    FROM platform_credentials
    WHERE platform = 'hevy'
    LIMIT 1
  `.catch(() => [] as Array<{ credentials: unknown }>);
  const creds = rows[0]?.credentials;
  const parsed =
    typeof creds === "string" ? (JSON.parse(creds) as Record<string, unknown>) : (creds as Record<string, unknown> | undefined);
  const apiKey = parsed?.api_key;
  return typeof apiKey === "string" && apiKey.trim() ? apiKey.trim() : null;
}

/** Resolve the Hevy API key (arg → env → DB), or null. Exposed for raw calls. */
export async function resolveHevyKey(key?: string | null): Promise<string | null> {
  const explicit = key?.trim();
  const fromEnv = process.env.HEVY_API_KEY?.trim();
  return explicit || fromEnv || (await keyFromDb());
}

/**
 * Build a HevyClient. Resolves the API key from the argument, then the
 * HEVY_API_KEY env var, then the platform_credentials table. Throws when no key
 * can be found so callers can surface a clear "connect Hevy first" error.
 */
export async function getHevyClient(key?: string | null): Promise<HevyClient> {
  const explicit = key?.trim();
  const fromEnv = process.env.HEVY_API_KEY?.trim();
  const apiKey = explicit || fromEnv || (await keyFromDb());
  if (!apiKey) {
    throw new Error("No Hevy API key available (arg, HEVY_API_KEY, or platform_credentials).");
  }
  return new HevyClient(apiKey);
}

/** READ-only: total number of workouts Hevy reports for this account. */
export async function fetchWorkoutCount(key?: string | null): Promise<number> {
  const client = await getHevyClient(key);
  return client.getWorkoutCount();
}

/**
 * READ-only: fetch the full paginated workout history from Hevy.
 * Thin passthrough to HevyClient.getAllWorkouts, which walks every page.
 */
export async function fetchAllWorkouts(key?: string | null): Promise<HevyWorkout[]> {
  const client = await getHevyClient(key);
  return (await client.getAllWorkouts()) as HevyWorkout[];
}

/**
 * The subset of a raw Hevy workout the SAFE sync side reads. Hevy returns many
 * more fields; only `id` is required for dedup, the rest are best-effort display.
 */
export interface HevyWorkout {
  id: string;
  title?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  updated_at?: string | null;
  // Hevy payloads carry additional fields we don't type here.
  [key: string]: unknown;
}
