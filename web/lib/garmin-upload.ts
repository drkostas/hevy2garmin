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
import { GarminAuth, DBTokenStore, type GarminClient, type TokenStore } from "garmin-auth";
import { resolveDatabaseUrl } from "./database-url";
import { activeProfile } from "./profiles";
import { activeProfileId, DEFAULT_PROFILE_ID } from "./profile-context";
import { profileSql } from "./profile-database";

/** The DI tokens live in platform_credentials at this platform key. */
export const GARMIN_TOKEN_PLATFORM = "garmin_tokens";

/**
 * Where a profile's Garmin tokens live. The default profile keeps garmin-auth's DBTokenStore.
 * DBTokenStore opens its own plain connections, which would reach the default profile's row,
 * so an added profile runs the same statements through its own schema-scoped handle.
 */
export function garminTokenStore(profileId: string, databaseUrl: string): TokenStore {
  if (profileId === DEFAULT_PROFILE_ID) return new DBTokenStore(databaseUrl, GARMIN_TOKEN_PLATFORM);
  const sql = profileSql(profileId);
  return {
    async load() {
      const rows = await sql`SELECT credentials FROM platform_credentials WHERE platform = ${GARMIN_TOKEN_PLATFORM} LIMIT 1`;
      const tokens = rows[0]?.credentials?.garmin_tokens;
      if (typeof tokens === "string") return tokens;
      return tokens && typeof tokens === "object" && "di_token" in tokens ? JSON.stringify(tokens) : null;
    },
    async save(tokens) {
      const payload = typeof tokens === "string" ? JSON.parse(tokens) : tokens;
      await sql`INSERT INTO platform_credentials (platform, auth_type, credentials, status, connected_at)
        VALUES (${GARMIN_TOKEN_PLATFORM}, 'oauth', ${sql.json({ garmin_tokens: payload })}, 'active', now())
        ON CONFLICT (platform) DO UPDATE
          SET credentials = EXCLUDED.credentials, auth_type = EXCLUDED.auth_type,
              status = EXCLUDED.status, connected_at = EXCLUDED.connected_at`;
    },
    async delete() {
      await sql`DELETE FROM platform_credentials WHERE platform = ${GARMIN_TOKEN_PLATFORM}`;
    },
  };
}

const clients = new Map<string, Promise<GarminClient>>();
const normalized = new Set<string>();

/**
 * Self-heal the token row (#459). garmin-auth < 0.3 (Python 0.2.x) wrote the DI payload FLAT
 * ({di_token, …}); 0.3+ on both stacks writes it NESTED under `garmin_tokens`, which is the only
 * shape DBTokenStore reads. A fork whose row was written by an older deploy would be told to
 * "reconnect Garmin" for no reason. Idempotent; runs once per process; never throws.
 */
export async function normalizeGarminTokenRow(sql: ReturnType<typeof getDb>): Promise<void> {
  const id = await activeProfileId();
  if (normalized.has(id)) return;
  try {
    await sql`
      UPDATE platform_credentials
         SET credentials = jsonb_build_object('garmin_tokens', credentials), auth_type = 'oauth', status = 'active'
       WHERE platform = ${GARMIN_TOKEN_PLATFORM}
         AND credentials ? 'di_token'
         AND NOT (credentials ? 'garmin_tokens')`;
    normalized.add(id);
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
  const profile = await activeProfile();
  let pending = clients.get(profile.id);
  if (!pending) {
    pending = (async () => {
      const url = databaseUrl ?? resolveDatabaseUrl();
      if (!url) throw new Error("DATABASE_URL not set (cannot load Garmin tokens)");
      try { await normalizeGarminTokenRow(getDb()); } catch { /* DBTokenStore reports the real failure. */ }
      return new GarminAuth({ store: garminTokenStore(profile.id, url) }).client();
    })().catch((error) => { clients.delete(profile.id); throw error; });
    clients.set(profile.id, pending);
  }
  return pending;
}

/** Reset the cached client (test seam / after a token rotation). */
export function resetGarminClient(profileId?: string): void {
  if (profileId) clients.delete(profileId);
  else clients.clear();
}
