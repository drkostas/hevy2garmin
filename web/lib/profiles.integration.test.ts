import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { acquireSyncLock } from "hevy2garmin";
import { getDb } from "./db";
import { createProfile, listProfiles, type Profile } from "./profiles";
import { withProfile } from "./profile-context";
import { closeProfileDatabases, profileClient, profileSchema } from "./profile-database";
import { garminTokenStore, GARMIN_TOKEN_PLATFORM } from "./garmin-upload";
import { SCHEMA_TABLES } from "./schema";
import { resolveHevyKey } from "./hevy-sync";
import { postgresLockBackend } from "./sync-lock-store";

const databaseUrl = process.env.H2G_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("profiles against an isolated Postgres database", () => {
  let first: Profile;
  let second: Profile;

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (url.pathname !== "/h2g_profiles_test" || url.hostname !== "127.0.0.1") {
      throw new Error("Integration tests require a disposable local h2g_profiles_test database.");
    }
    for (const key of ["POSTGRES_URL", "STORAGE_URL", "NEON_DATABASE_URL"]) vi.stubEnv(key, undefined);
    vi.stubEnv("DATABASE_URL", databaseUrl!);
    const sql = getDb({ global: true });
    await sql`INSERT INTO synced_workouts (hevy_id, title) VALUES ('legacy-workout', 'Existing history') ON CONFLICT DO NOTHING`;
    first = await createProfile("First person");
    second = await createProfile("Second person");
  });

  afterAll(async () => {
    // This is only the disposable database guarded above, never a deployment database.
    for (const profile of [first, second].filter(Boolean)) {
      await profileClient().unsafe(`DROP SCHEMA "${profileSchema(profile.id)}" CASCADE`);
      await profileClient()`DELETE FROM public.h2g_profiles WHERE id = ${profile.id}`;
    }
    await profileClient()`DELETE FROM public.synced_workouts WHERE hevy_id = 'legacy-workout'`;
    await closeProfileDatabases();
    vi.unstubAllEnvs();
  });

  it("preserves existing history and creates every table for both new profiles", async () => {
    const sql = getDb({ global: true });
    expect((await sql`SELECT hevy_id FROM synced_workouts`)[0].hevy_id).toBe("legacy-workout");
    expect((await listProfiles()).map((profile) => profile.id)).toContain("default");
    for (const profile of [first, second]) {
      const tables = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema = ${profileSchema(profile.id)}`;
      expect(tables.map((table) => table.table_name).sort()).toEqual([...SCHEMA_TABLES].sort());
      const rows = await withProfile(profile.id, () => getDb()`SELECT * FROM synced_workouts`);
      expect(rows).toEqual([]);
    }
  });

  it("keeps concurrent credentials and identical workout IDs in their own profiles", async () => {
    await Promise.all([first, second].map((profile) => withProfile(profile.id, async () => {
      const sql = getDb();
      await sql`INSERT INTO synced_workouts (hevy_id, title) VALUES ('same-id', ${profile.name})`;
      await sql`INSERT INTO platform_credentials (platform, credentials)
        VALUES ('hevy', ${sql.json({ api_key: profile.name })})`;
      await new Promise((resolve) => setTimeout(resolve, profile === first ? 15 : 1));
      expect((await sql`SELECT title FROM synced_workouts WHERE hevy_id = 'same-id'`)[0].title).toBe(profile.name);
      vi.stubEnv("HEVY_API_KEY", "legacy-environment-key");
      expect(await resolveHevyKey()).toBe(profile.name);
    })));
  });

  it("keeps each profile's Garmin tokens in its own schema, in garmin-auth's stored shape", async () => {
    for (const profile of [first, second]) {
      await garminTokenStore(profile.id, databaseUrl!).save({ di_token: profile.name, di_refresh_token: "test-refresh", di_client_id: "test-client" });
    }
    for (const profile of [first, second]) {
      expect(JSON.parse((await garminTokenStore(profile.id, databaseUrl!).load())!).di_token).toBe(profile.name);
      const [row] = await profileClient().unsafe(
        `SELECT credentials FROM "${profileSchema(profile.id)}".platform_credentials WHERE platform = $1`, [GARMIN_TOKEN_PLATFORM]);
      expect(row.credentials.garmin_tokens.di_token).toBe(profile.name);
    }
    expect(await garminTokenStore("default", databaseUrl!).load()).toBeNull();
    await garminTokenStore(first.id, databaseUrl!).delete();
    expect(await garminTokenStore(first.id, databaseUrl!).load()).toBeNull();
    expect(await garminTokenStore(second.id, databaseUrl!).load()).not.toBeNull();
  });

  it("keeps overlap locks independent between profiles", async () => {
    const held = [];
    try {
      for (const profile of [first, second]) {
        const lock = await withProfile(profile.id, () => acquireSyncLock({ backend: postgresLockBackend(getDb()), key: "sync" }));
        expect(lock).not.toBeNull();
        if (lock) held.push(lock);
      }
      const duplicate = await withProfile(first.id, () => acquireSyncLock({ backend: postgresLockBackend(getDb()), key: "sync" }));
      expect(duplicate).toBeNull();
    } finally {
      await Promise.all(held.map((lock) => lock.release()));
    }
  });

  it("refuses an unknown profile instead of falling back to the existing account", async () => {
    await expect(withProfile(randomUUID(), () => getDb()`SELECT * FROM synced_workouts`)).rejects.toThrow("Profile not found");
  });
});
