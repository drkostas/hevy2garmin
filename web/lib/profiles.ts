import { randomUUID } from "node:crypto";
import { activeProfileId, DEFAULT_PROFILE_ID } from "./profile-context";
import { profileClient, profileSchema, profileSql } from "./profile-database";
import { SCHEMA_STATEMENTS } from "./schema";

export interface Profile { id: string; name: string }
let ready: Promise<void> | null = null;

async function ensureProfiles(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const sql = profileSql();
      await sql`CREATE TABLE IF NOT EXISTS public.h2g_profiles (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      // Existing credentials and history stay in public, untouched.
      await sql`INSERT INTO public.h2g_profiles (id, name) VALUES ('default', 'Default profile')
        ON CONFLICT (id) DO NOTHING`;
    })().catch((error) => { ready = null; throw error; });
  }
  await ready;
}

export async function listProfiles(): Promise<Profile[]> {
  await ensureProfiles();
  return profileSql()`SELECT id, name FROM public.h2g_profiles ORDER BY created_at, id`;
}

export async function requireProfile(id: string): Promise<Profile> {
  profileSchema(id);
  if (id === DEFAULT_PROFILE_ID) return { id, name: "Default profile" };
  await ensureProfiles();
  const rows = await profileSql()`SELECT id, name FROM public.h2g_profiles WHERE id = ${id}`;
  if (!rows[0]) throw new Error("Profile not found. Select an existing profile.");
  return rows[0] as Profile;
}

export async function activeProfile(): Promise<Profile> {
  return requireProfile(await activeProfileId());
}

export function profileName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 80) {
    throw new Error("Use a profile name between 1 and 80 characters.");
  }
  return value.trim();
}

export async function createProfile(value: unknown): Promise<Profile> {
  const name = profileName(value);
  await ensureProfiles();
  const id = randomUUID();
  const schema = profileSchema(id);
  await profileClient().begin(async (sql) => {
    // The identifier comes from a generated UUID, never the display name.
    await sql.unsafe(`CREATE SCHEMA "${schema}"`);
    await sql.unsafe(`SET LOCAL search_path = "${schema}"`);
    for (const statement of SCHEMA_STATEMENTS) await sql.unsafe(statement);
    await sql`INSERT INTO public.h2g_profiles (id, name) VALUES (${id}, ${name})`;
  });
  return { id, name };
}

export async function renameProfile(id: string, value: unknown): Promise<void> {
  const name = profileName(value);
  await requireProfile(id);
  await ensureProfiles();
  await profileSql()`UPDATE public.h2g_profiles SET name = ${name} WHERE id = ${id}`;
}
