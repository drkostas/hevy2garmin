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
 * (dryRun === false). `findExistingActivity` is a READ (the 409-prevention
 * lookup) and is always safe to call.
 */
import { getDb } from "./db";
import { GarminAuth, DBTokenStore, type GarminClient } from "garmin-auth";

/** The DI tokens live in platform_credentials at this platform key. */
export const GARMIN_TOKEN_PLATFORM = "garmin_tokens";

let cachedClient: GarminClient | null = null;
let normalized = false;

/**
 * Self-heal the token row (#459). garmin-auth < 0.3 (Python 0.2.x) wrote the DI payload FLAT
 * ({di_token, …}); 0.3+ on both stacks writes it NESTED under `garmin_tokens`, which is the only
 * shape DBTokenStore reads. A fork whose row was written by an older deploy would be told to
 * "reconnect Garmin" for no reason. Idempotent; runs once per process; never throws.
 */
export async function normalizeGarminTokenRow(sql: ReturnType<typeof getDb>): Promise<void> {
  if (normalized) return;
  try {
    await sql`
      UPDATE platform_credentials
         SET credentials = jsonb_build_object('garmin_tokens', credentials), auth_type = 'oauth', status = 'active'
       WHERE platform = ${GARMIN_TOKEN_PLATFORM}
         AND credentials ? 'di_token'
         AND NOT (credentials ? 'garmin_tokens')`;
    normalized = true;
  } catch { /* best effort: DBTokenStore reports the real problem if any */ }
}

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
  try { await normalizeGarminTokenRow(getDb()); } catch { /* no DB handle: DBTokenStore reports it */ }
  const store = new DBTokenStore(url, GARMIN_TOKEN_PLATFORM);
  const auth = new GarminAuth({ store });
  cachedClient = await auth.client();
  return cachedClient;
}

/** Reset the cached client (test seam / after a token rotation). */
export function resetGarminClient(): void {
  cachedClient = null;
}
