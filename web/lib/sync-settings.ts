/**
 * The user's sync settings, read from where the Settings page saves them.
 *
 * `POST /api/settings` writes `merge_settings` and `hr_fusion` into `app_cache`
 * and the Settings page reads them back to draw the form. Until now nothing
 * else read them, so merge mode, the watch strategy, the activity-type list and
 * HR fusion were controls that changed the stored value and nothing else. This
 * module is what carries them to the sync engine.
 *
 * Key names and defaults match `config.py`, so a database shared with the
 * Python pipeline means the same thing to both.
 */
import type { FitProfile, MergeSettings } from "hevy2garmin";
import type { Sql } from "./pending-store";

export interface SyncSettings {
  merge: MergeSettings;
  hrFusion: boolean;
  descriptionEnabled: boolean;
  /**
   * Who the user is and how long their sets take. Without it a FIT is encoded
   * for an 80 kg person born in 1990, with no timezone, whoever is syncing.
   */
  profile: Partial<FitProfile>;
  /**
   * Put the workout's Hevy photos on its Garmin activity (#237). Not an engine
   * option: the web app uploads them around the engine call.
   */
  photos: boolean;
}

/** What a fresh install syncs with: merge on, sets pushed into the watch activity. */
export const DEFAULT_SYNC_SETTINGS: SyncSettings = {
  merge: {
    enabled: true,
    watchStrategy: "merge",
    activityTypes: ["strength_training"],
    overlapThreshold: 0.7,
    maxDriftMinutes: 20,
  },
  hrFusion: true,
  descriptionEnabled: true,
  profile: {},
  photos: true,
};

/** `timing` in the stored config, in the engine's spelling. */
const TIMING_KEYS: Array<[string, keyof FitProfile]> = [
  ["working_set_seconds", "workingSetS"],
  ["warmup_set_seconds", "warmupSetS"],
  ["rest_between_sets_seconds", "restSetsS"],
  ["rest_between_exercises_seconds", "restExercisesS"],
];

/** `user_profile` in the stored config, in the engine's spelling. */
const PROFILE_KEYS: Array<[string, keyof FitProfile]> = [
  ["weight_kg", "weightKg"],
  ["birth_year", "birthYear"],
  ["vo2max", "vo2max"],
];

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** One `app_cache` value, or null. Never throws: a missing table is not fatal. */
async function readConfig(sql: Sql, key: string): Promise<Record<string, unknown> | null> {
  const rows = (await sql`SELECT value FROM app_cache WHERE key = ${key} LIMIT 1`.catch(
    () => [] as Array<{ value: unknown }>,
  )) as Array<{ value: unknown }>;
  const value = rows[0]?.value;
  return isObj(value) ? value : null;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * The exercises the user mapped by hand.
 *
 * Merging pushes structured sets, and a set whose exercise the built-in table
 * does not cover would be dropped without these.
 */
export async function loadCustomMappings(sql: Sql): Promise<Record<string, [number, number]>> {
  const rows = (await sql`
    SELECT hevy_name, category, subcategory FROM custom_mappings
  `.catch(() => [] as Array<{ hevy_name: string; category: number; subcategory: number }>)) as Array<{
    hevy_name: string;
    category: number;
    subcategory: number;
  }>;
  const out: Record<string, [number, number]> = {};
  for (const r of rows) {
    if (!r?.hevy_name) continue;
    out[r.hevy_name] = [Number(r.category), Number(r.subcategory ?? 0)];
  }
  return out;
}

/**
 * The settings a sync should run with.
 *
 * Every field falls back to the documented default, so a database with no
 * `app_cache` rows yet syncs the way a fresh install is meant to rather than
 * with merge silently off.
 */
export async function loadSyncSettings(sql: Sql): Promise<SyncSettings> {
  const [mergeCfg, hrCfg, profileCfg, timingCfg, customMappings, photosCfg] = await Promise.all([
    readConfig(sql, "merge_settings"),
    readConfig(sql, "hr_fusion"),
    readConfig(sql, "user_profile"),
    readConfig(sql, "timing"),
    loadCustomMappings(sql),
    readConfig(sql, "workout_photos"),
  ]);

  // Only fields the user actually set are carried, so an absent one keeps the
  // engine's default rather than becoming a zero.
  const profile: Partial<FitProfile> = {};
  for (const [stored, engine] of PROFILE_KEYS) {
    const n = Number(profileCfg?.[stored]);
    if (Number.isFinite(n) && n > 0) (profile as Record<string, unknown>)[engine] = n;
  }
  const tz = profileCfg?.timezone;
  if (typeof tz === "string" && tz.trim()) profile.timezone = tz.trim();
  for (const [stored, engine] of TIMING_KEYS) {
    const n = Number(timingCfg?.[stored]);
    if (Number.isFinite(n) && n >= 0) (profile as Record<string, unknown>)[engine] = n;
  }

  const d = DEFAULT_SYNC_SETTINGS;
  const strategy = String(mergeCfg?.merge_watch_strategy ?? d.merge.watchStrategy);
  const types = Array.isArray(mergeCfg?.merge_activity_types)
    ? (mergeCfg!.merge_activity_types as unknown[]).map(String).filter(Boolean)
    : d.merge.activityTypes!;

  return {
    merge: {
      enabled: bool(mergeCfg?.merge_mode, d.merge.enabled!),
      watchStrategy:
        strategy === "merge" || strategy === "replace" || strategy === "describe"
          ? strategy
          : d.merge.watchStrategy,
      activityTypes: types.length ? types : d.merge.activityTypes,
      // Stored as a percentage for the form, used as a fraction by the matcher.
      overlapThreshold: num(mergeCfg?.merge_overlap_pct, 70) / 100,
      maxDriftMinutes: num(mergeCfg?.merge_max_drift_min, d.merge.maxDriftMinutes!),
      customMappings: Object.keys(customMappings).length ? customMappings : undefined,
      // The same four numbers the FIT uses, so a merged workout and an
      // uploaded one lay their sets out the same way.
      // Only the values the user saved. A missing one left as `undefined`
      // overrode the engine's default and threw on every merge (#703).
      timing: Object.fromEntries(
        (["workingSetS", "warmupSetS", "restSetsS", "restExercisesS"] as const)
          .filter((k) => profile[k] != null)
          .map((k) => [k, profile[k]]),
      ),
    },
    hrFusion: bool(hrCfg?.enabled, d.hrFusion),
    descriptionEnabled: bool(mergeCfg?.description_enabled, d.descriptionEnabled),
    profile,
    photos: bool(photosCfg?.enabled, d.photos),
  };
}


/**
 * The sync start date, or null when the user has not set one (#647).
 *
 * Deliberately NOT part of SyncSettings. That object describes how a workout is
 * turned into a Garmin activity, and this decides which workouts are offered at
 * all. Mixing them would push a candidate-selection concern into the engine,
 * which would then need a package release to change.
 */
export async function loadSyncStartDate(sql: Sql): Promise<string | null> {
  const cfg = await readConfig(sql, "sync_window");
  const v = cfg?.start_date;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
