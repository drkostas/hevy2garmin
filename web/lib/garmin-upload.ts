/**
 * Garmin upload wrappers — the DANGEROUS half of the sync engine.
 *
 * This module is the ONLY place in the web app that can write to Garmin
 * Connect (upload a FIT, rename, set a description). A bad Garmin upload
 * creates a duplicate Garmin/Strava activity, which is a hard user constraint,
 * so every entry point here is a thin, explicit wrapper over the published
 * `hevy2garmin` package's Garmin ops — no FIT generation, no HTTP is
 * reimplemented, and nothing in this file decides WHETHER to upload.
 *
 * `getGarminClient()` READS the stored DI tokens from platform_credentials
 * (platform='garmin_tokens') via garmin-auth. Building the client performs no
 * activity write; it only authenticates. The functions that mutate Garmin
 * (`upload`, `rename`, `describe`) are called by sync-one ONLY on the live path
 * (dryRun === false). `findExistingActivity` and `listActivityIds` are READs
 * (the 409-prevention lookup and pre-upload snapshot) and are always safe.
 */
import { GarminAuth, DBTokenStore, type GarminClient } from "garmin-auth";
import {
  uploadFit,
  renameActivity,
  setDescription,
  type UploadResult,
} from "hevy2garmin";

export interface ActivityLookupOptions {
  /** Activity IDs observed before the upload; never adopt one as the result. */
  excludeActivityIds?: Iterable<number | string>;
}

export interface UploadOptions extends ActivityLookupOptions {}

interface ActivitySummary {
  activityId?: unknown;
  startTimeGMT?: string;
  startTimeLocal?: string;
  activityTypeKey?: string;
  activityType?: { typeKey?: string; parentTypeKey?: string };
}

const MATCH_ACTIVITY_TYPES = new Set(["strength_training", "other"]);

function withUtcIfMissing(raw: string): string {
  const value = raw.trim().replace(" ", "T");
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}Z`;
}

async function listActivities(client: GarminClient): Promise<ActivitySummary[]> {
  return client.connectapi<ActivitySummary[]>(
    "/activitylist-service/activities/search/activities?limit=100",
  );
}

/** The DI tokens live in platform_credentials at this platform key. */
export const GARMIN_TOKEN_PLATFORM = "garmin_tokens";

let cachedClient: GarminClient | null = null;

/**
 * Build (and cache) an authenticated GarminClient from the DI tokens stored in
 * Postgres. Uses garmin-auth's DBTokenStore, which reads
 * platform_credentials.credentials->garmin_tokens (the NESTED shape the TS
 * stack writes). Throws when DATABASE_URL is unset or the tokens are missing /
 * need a fresh MFA login — callers surface that as a "reconnect Garmin" error.
 *
 * This authenticates only; it does not upload or mutate any activity.
 */
export async function getGarminClient(databaseUrl?: string): Promise<GarminClient> {
  if (cachedClient) return cachedClient;
  const url = databaseUrl ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set (cannot load Garmin tokens)");
  const store = new DBTokenStore(url, GARMIN_TOKEN_PLATFORM);
  const auth = new GarminAuth({ store });
  cachedClient = await auth.client();
  return cachedClient;
}

/** Reset the cached client (test seam / after a token rotation). */
export function resetGarminClient(): void {
  cachedClient = null;
}

/**
 * READ: is there already a Garmin activity at this start time? This is dedup
 * layer 2 — the pre-upload lookup that prevents a duplicate (409) upload. It
 * is implemented here as well as in the package because the web app can be
 * deployed with an older published package. Returns the existing activity id,
 * or null when the timestamp is free. Never writes.
 */
export async function findExistingActivity(
  client: GarminClient,
  startTime: string,
  options: ActivityLookupOptions = {},
): Promise<number | null> {
  const target = Date.parse(withUtcIfMissing(startTime));
  if (Number.isNaN(target)) return null;
  const excluded = new Set([...options.excludeActivityIds ?? []].map(String));
  const activities = await listActivities(client);
  for (const activity of activities) {
    const activityId = Number(activity.activityId);
    if (!Number.isSafeInteger(activityId) || activityId <= 0) continue;
    if (excluded.has(String(activityId))) continue;
    const typeKey =
      activity.activityTypeKey ??
      activity.activityType?.typeKey ??
      activity.activityType?.parentTypeKey;
    if (typeKey && !MATCH_ACTIVITY_TYPES.has(typeKey)) continue;
    const rawStart = activity.startTimeGMT ?? activity.startTimeLocal;
    if (!rawStart) continue;
    const candidate = Date.parse(withUtcIfMissing(rawStart));
    if (!Number.isNaN(candidate) && Math.abs(candidate - target) < 10 * 60 * 1000) {
      return activityId;
    }
  }
  return null;
}

/**
 * Snapshot Garmin IDs immediately before an upload. The published package
 * version used by the web app may resolve an async upload by timestamp without
 * knowing this snapshot, so the wrapper performs the final old-ID guard too.
 */
export async function listActivityIds(client: GarminClient): Promise<number[]> {
  const rows = await listActivities(client);
  return rows
    .map((row) => Number(row.activityId))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
}

/**
 * WRITE: upload a FIT (bytes) to Garmin. Thin passthrough to the package's
 * uploadFit. Only ever reached on the live sync path (dryRun === false); the
 * dry-run path returns before any wrapper here is called.
 */
export async function upload(
  client: GarminClient,
  fit: Uint8Array,
  workoutStart?: string,
  options: UploadOptions = {},
): Promise<UploadResult> {
  const result = await uploadFit(client, fit, workoutStart);
  if (result.activityId == null || !options.excludeActivityIds) return result;
  const excluded = new Set([...options.excludeActivityIds].map(String));
  // A timestamp-only resolver can select a pre-existing activity when Garmin
  // has not indexed the just-uploaded FIT yet. Returning null keeps the durable
  // pending row open so reconciliation can resolve it later safely.
  return excluded.has(String(result.activityId))
    ? { ...result, activityId: null }
    : result;
}

/** WRITE: rename a Garmin activity. Thin passthrough to renameActivity. */
export async function rename(
  client: GarminClient,
  activityId: number,
  name: string,
): Promise<void> {
  return renameActivity(client, activityId, name);
}

/** WRITE: set a Garmin activity's description. Thin passthrough to setDescription. */
export async function describe(
  client: GarminClient,
  activityId: number,
  description: string,
): Promise<void> {
  return setDescription(client, activityId, description);
}
