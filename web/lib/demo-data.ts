/**
 * Static demo data for the public read-only demo (DEMO_MODE), so the demo needs
 * no database.
 *
 * Every date is stored as an offset in days from the current day and turned into
 * a real timestamp at read time by `agoIso`. The newest workout is therefore
 * always recent and the weekly counts are never empty, however old the running
 * deployment is, with no scheduled job to keep the data current.
 *
 * The rows mirror scripts/seed-demo.sql, which the live app loads into Postgres.
 * The only change is that the `NOW() - INTERVAL 'N days'` the seed evaluates once
 * at load time is evaluated here per request instead.
 *
 * The live (non-demo) app never reaches this module. Each read path consults it
 * only when `demoMode()` is true, before it would open the database.
 */

/** A real ISO timestamp `days` (and optional `hours`) before this moment. */
export function agoIso(days: number, hours = 0): string {
  return new Date(Date.now() - days * 86_400_000 - hours * 3_600_000).toISOString();
}

const DEMO_HEVY_ID_PREFIX = "demo_a1b2c3d4-1111-4000-8000-0000000000";

interface WorkoutSeed {
  n: number;
  garmin_activity_id: string;
  title: string;
  offsetDays: number;
  calories: number;
  avg_hr: number;
  status: string;
}

/** synced_workouts, newest first (ascending offset), matching seed-demo.sql. */
const WORKOUTS: WorkoutSeed[] = [
  { n: 1, garmin_activity_id: "18234567890", title: "Push Day A — Chest & Triceps", offsetDays: 1, calories: 412, avg_hr: 118, status: "success" },
  { n: 2, garmin_activity_id: "18234567891", title: "Pull Day B — Back & Biceps", offsetDays: 2, calories: 387, avg_hr: 122, status: "success" },
  { n: 3, garmin_activity_id: "18234567892", title: "Leg Day — Squats & RDL", offsetDays: 3, calories: 524, avg_hr: 135, status: "success" },
  { n: 4, garmin_activity_id: "18234567893", title: "Full Body Hypertrophy", offsetDays: 4, calories: 478, avg_hr: 128, status: "success" },
  { n: 5, garmin_activity_id: "18234567894", title: "Upper Body Strength", offsetDays: 5, calories: 356, avg_hr: 115, status: "success" },
  { n: 6, garmin_activity_id: "18234567895", title: "Shoulder & Arms", offsetDays: 6, calories: 298, avg_hr: 108, status: "success" },
  { n: 7, garmin_activity_id: "18234567896", title: "Push Day B — Incline Focus", offsetDays: 8, calories: 425, avg_hr: 121, status: "success" },
  { n: 8, garmin_activity_id: "18234567897", title: "Pull Day A — Deadlift & Rows", offsetDays: 9, calories: 512, avg_hr: 138, status: "success" },
  { n: 9, garmin_activity_id: "18234567898", title: "Leg Day — Front Squats & Lunges", offsetDays: 10, calories: 498, avg_hr: 132, status: "success" },
  { n: 10, garmin_activity_id: "18234567899", title: "Push Day A — Chest & Triceps", offsetDays: 11, calories: 405, avg_hr: 119, status: "success" },
  { n: 11, garmin_activity_id: "18234567900", title: "Full Body Power", offsetDays: 12, calories: 562, avg_hr: 142, status: "success" },
  { n: 12, garmin_activity_id: "18234567901", title: "Pull Day B — Back & Biceps", offsetDays: 14, calories: 374, avg_hr: 120, status: "success" },
  { n: 13, garmin_activity_id: "18234567902", title: "Upper Body Hypertrophy", offsetDays: 15, calories: 345, avg_hr: 113, status: "success" },
  { n: 14, garmin_activity_id: "18234567903", title: "Leg Day — Squats & RDL", offsetDays: 16, calories: 531, avg_hr: 137, status: "success" },
  { n: 15, garmin_activity_id: "18234567904", title: "Shoulder & Arms", offsetDays: 17, calories: 287, avg_hr: 105, status: "success" },
  { n: 16, garmin_activity_id: "18234567905", title: "Push Day B — Incline Focus", offsetDays: 18, calories: 418, avg_hr: 120, status: "success" },
  { n: 17, garmin_activity_id: "18234567906", title: "Pull Day A — Deadlift & Rows", offsetDays: 20, calories: 495, avg_hr: 134, status: "success" },
  { n: 18, garmin_activity_id: "18234567907", title: "Full Body Hypertrophy", offsetDays: 21, calories: 467, avg_hr: 126, status: "success" },
  { n: 19, garmin_activity_id: "18234567908", title: "Leg Day — Front Squats & Lunges", offsetDays: 22, calories: 515, avg_hr: 133, status: "success" },
  { n: 20, garmin_activity_id: "18234567909", title: "Push Day A — Chest & Triceps", offsetDays: 23, calories: 398, avg_hr: 117, status: "success" },
  { n: 21, garmin_activity_id: "18234567910", title: "Upper Body Strength", offsetDays: 24, calories: 362, avg_hr: 114, status: "success" },
  { n: 22, garmin_activity_id: "18234567911", title: "Shoulder & Arms", offsetDays: 25, calories: 275, avg_hr: 102, status: "success" },
  { n: 23, garmin_activity_id: "18234567912", title: "Pull Day B — Back & Biceps", offsetDays: 27, calories: 381, avg_hr: 121, status: "success" },
  { n: 24, garmin_activity_id: "18234567913", title: "Leg Day — Squats & RDL", offsetDays: 28, calories: 542, avg_hr: 139, status: "success" },
  { n: 25, garmin_activity_id: "18234567914", title: "Full Body Power", offsetDays: 30, calories: 578, avg_hr: 145, status: "success" },
];

interface LogSeed {
  id: number;
  offsetDays: number;
  synced: number;
  skipped: number;
  failed: number;
  trigger: string;
}

/** sync_log, in insert order (id ascending), matching seed-demo.sql. */
const SYNC_LOG: LogSeed[] = [
  { id: 1, offsetDays: 1, synced: 1, skipped: 0, failed: 0, trigger: "cron" },
  { id: 2, offsetDays: 2, synced: 1, skipped: 0, failed: 0, trigger: "cron" },
  { id: 3, offsetDays: 3, synced: 2, skipped: 0, failed: 0, trigger: "manual" },
  { id: 4, offsetDays: 4, synced: 1, skipped: 0, failed: 0, trigger: "cron" },
  { id: 5, offsetDays: 5, synced: 1, skipped: 1, failed: 0, trigger: "cron" },
  { id: 6, offsetDays: 6, synced: 1, skipped: 0, failed: 0, trigger: "auto" },
  { id: 7, offsetDays: 8, synced: 1, skipped: 0, failed: 0, trigger: "cron" },
  { id: 8, offsetDays: 9, synced: 2, skipped: 0, failed: 1, trigger: "manual" },
  { id: 9, offsetDays: 10, synced: 1, skipped: 0, failed: 0, trigger: "cron" },
  { id: 10, offsetDays: 12, synced: 3, skipped: 0, failed: 0, trigger: "manual" },
  { id: 11, offsetDays: 14, synced: 1, skipped: 0, failed: 0, trigger: "cron" },
  { id: 12, offsetDays: 16, synced: 2, skipped: 1, failed: 0, trigger: "auto" },
  { id: 13, offsetDays: 20, synced: 1, skipped: 0, failed: 0, trigger: "cron" },
  { id: 14, offsetDays: 24, synced: 3, skipped: 0, failed: 1, trigger: "manual" },
  { id: 15, offsetDays: 28, synced: 2, skipped: 0, failed: 0, trigger: "cron" },
];

/** custom_mappings, matching seed-demo.sql. */
const MAPPINGS: Array<{ hevy_name: string; category: number; subcategory: number }> = [
  { hevy_name: "Cable Lateral Raise", category: 14, subcategory: 6 },
  { hevy_name: "Rope Pushdown", category: 30, subcategory: 5 },
  { hevy_name: "Incline Smith Machine Press", category: 0, subcategory: 12 },
  { hevy_name: "Hack Squat (Machine)", category: 28, subcategory: 15 },
  { hevy_name: "Single Arm Cable Row", category: 23, subcategory: 8 },
];

/** app_cache config blobs, matching seed-demo.sql. */
const CONFIG: Record<string, Record<string, unknown>> = {
  user_profile: { weight_kg: 82, birth_year: 1993, sex: "male", vo2max: 44 },
  timing: { working_set_seconds: 40, warmup_set_seconds: 25, rest_between_sets_seconds: 75, rest_between_exercises_seconds: 120 },
  hr_fusion: { enabled: true },
  merge_settings: { merge_mode: true, description_enabled: true, merge_overlap_pct: 70, merge_max_drift_min: 20 },
};

/** When the two demo connections read as having been set up. */
const CONNECTED_OFFSET_DAYS = 35;

function hevyId(n: number): string {
  return `${DEMO_HEVY_ID_PREFIX}${String(n).padStart(2, "0")}`;
}

function workoutsNewestFirst(): WorkoutSeed[] {
  return [...WORKOUTS].sort((a, b) => a.offsetDays - b.offsetDays);
}

function totalSuccess(): number {
  return WORKOUTS.filter((w) => w.status === "success").length;
}

function syncedThisWeek(): number {
  return WORKOUTS.filter((w) => w.status === "success" && w.offsetDays <= 7).length;
}

function countStatus(status: string): number {
  return WORKOUTS.filter((w) => w.status === status).length;
}

// ── Per read-site builders. Each returns exactly the shape its read path builds. ──

export interface DemoRecent {
  hevy_id: string;
  title: string;
  synced_at: string | null;
  calories: number;
  avg_hr: number | null;
  garmin_activity_id: string | null;
  status: string;
}

export interface DemoSyncLogEntry {
  id: number;
  time: string | null;
  synced: number;
  skipped: number;
  failed: number;
  trigger: string;
}

export interface DemoDashboard {
  dbConfigured: boolean;
  hevyConnected: boolean;
  garminConnected: boolean;
  totalSynced: number;
  syncedThisWeek: number;
  markedSynced: number;
  skipped: number;
  pending: number;
  routinesSynced: number;
  routinesScheduled: number;
  recent: DemoRecent[];
  syncLog: DemoSyncLogEntry[];
  autoSyncEnabled: boolean;
  autoSyncInterval: number;
}

export function demoDashboard(): DemoDashboard {
  const rows = workoutsNewestFirst();
  return {
    dbConfigured: true,
    hevyConnected: true,
    garminConnected: true,
    totalSynced: totalSuccess(),
    syncedThisWeek: syncedThisWeek(),
    markedSynced: countStatus("manual"),
    skipped: countStatus("skipped"),
    pending: 0,
    routinesSynced: 0,
    routinesScheduled: 0,
    recent: rows.slice(0, 10).map((w) => ({
      hevy_id: hevyId(w.n),
      title: w.title,
      synced_at: agoIso(w.offsetDays),
      calories: w.calories,
      avg_hr: w.avg_hr,
      garmin_activity_id: w.garmin_activity_id,
      status: w.status,
    })),
    syncLog: [...SYNC_LOG]
      .sort((a, b) => b.id - a.id)
      .slice(0, 10)
      .map((e) => ({
        id: e.id,
        time: agoIso(e.offsetDays),
        synced: e.synced,
        skipped: e.skipped,
        failed: e.failed,
        trigger: e.trigger,
      })),
    autoSyncEnabled: false,
    autoSyncInterval: 120,
  };
}

export interface DemoStatus {
  hevyConnected: boolean;
  garminConnected: boolean;
  totalSynced: number;
  syncedThisWeek: number;
  recent: Array<{ hevy_id: string; title: string; synced_at: string | null; calories: number; status: string }>;
}

export function demoStatus(): DemoStatus {
  const rows = workoutsNewestFirst();
  return {
    hevyConnected: true,
    garminConnected: true,
    totalSynced: totalSuccess(),
    syncedThisWeek: syncedThisWeek(),
    recent: rows.slice(0, 8).map((w) => ({
      hevy_id: hevyId(w.n),
      title: w.title,
      synced_at: agoIso(w.offsetDays),
      calories: w.calories,
      status: w.status,
    })),
  };
}

export interface DemoHistoryRow {
  hevy_id: string;
  title: string;
  synced_at: string | null;
  resynced_at: string | null;
  calories: number | null;
  avg_hr: number | null;
  garmin_activity_id: string | null;
  status: string;
}

export interface DemoHistory {
  dbConfigured: boolean;
  total: number;
  rows: DemoHistoryRow[];
}

export function demoHistory(): DemoHistory {
  const rows = workoutsNewestFirst();
  return {
    dbConfigured: true,
    total: totalSuccess(),
    rows: rows.map((w) => ({
      hevy_id: hevyId(w.n),
      title: w.title,
      synced_at: agoIso(w.offsetDays),
      resynced_at: null,
      calories: w.calories,
      avg_hr: w.avg_hr,
      garmin_activity_id: w.garmin_activity_id,
      status: w.status,
    })),
  };
}

export interface DemoWorkoutItem {
  hevy_id: string;
  title: string;
  when: string | null;
  state: string;
  detail: string | null;
  garmin_activity_id: string | null;
  resynced_at: string | null;
  kind: "terminal" | "pending";
}

export interface DemoWorkouts {
  dbConfigured: boolean;
  items: DemoWorkoutItem[];
}

export function demoWorkouts(): DemoWorkouts {
  const rows = workoutsNewestFirst();
  return {
    dbConfigured: true,
    items: rows.map((w) => ({
      hevy_id: hevyId(w.n),
      title: w.title,
      when: agoIso(w.offsetDays),
      state: w.status,
      detail: null,
      garmin_activity_id: w.garmin_activity_id,
      resynced_at: null,
      kind: "terminal" as const,
    })),
  };
}

export interface DemoCustomMapping {
  hevy_name: string;
  category: number;
  subcategory: number;
}

export function demoMappings(): DemoCustomMapping[] {
  return [...MAPPINGS].sort((a, b) => a.hevy_name.localeCompare(b.hevy_name));
}

export interface DemoPlatformRow {
  platform: string;
  auth_type: string;
  status: string;
  connected_at: string | null;
  expires_at: string | null;
}

export interface DemoConfigEntry {
  key: string;
  value: Record<string, unknown>;
  updated_at: string | null;
}

export interface DemoSettings {
  dbConfigured: boolean;
  platforms: DemoPlatformRow[];
  config: DemoConfigEntry[];
  syncedCount: number;
}

export function demoSettings(): DemoSettings {
  const platforms: DemoPlatformRow[] = [
    { platform: "garmin", auth_type: "password", status: "active", connected_at: agoIso(CONNECTED_OFFSET_DAYS), expires_at: null },
    { platform: "hevy", auth_type: "api_key", status: "active", connected_at: agoIso(CONNECTED_OFFSET_DAYS), expires_at: null },
  ];
  const config: DemoConfigEntry[] = Object.keys(CONFIG)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => ({ key, value: CONFIG[key], updated_at: agoIso(CONNECTED_OFFSET_DAYS) }));
  return { dbConfigured: true, platforms, config, syncedCount: totalSuccess() };
}

export interface DemoConnection {
  connected: boolean;
  connectedAt: string | null;
}

export interface DemoSetup {
  dbConfigured: boolean;
  hevy: DemoConnection;
  garmin: DemoConnection;
  timezone: string | null;
}

export function demoSetup(): DemoSetup {
  return {
    dbConfigured: true,
    hevy: { connected: true, connectedAt: agoIso(CONNECTED_OFFSET_DAYS) },
    garmin: { connected: true, connectedAt: agoIso(CONNECTED_OFFSET_DAYS) },
    timezone: null,
  };
}
