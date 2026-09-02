/**
 * Read-only Garmin activity queries + duplicate detection. Ports
 * reconcile.detect_duplicates from the Python: a past sync race can leave TWO
 * Garmin activities for one workout (a tool-uploaded one + the watch's own), and
 * this flags those pairs. Log/report only — nothing is deleted.
 *
 * The activity listing uses the GarminClient's generic `connectapi`, so it needs
 * no new package surface. The exact activitylist endpoint + field names are the
 * well-known garth ones; a live smoke-test confirms them.
 */
import type { GarminClient } from "garmin-auth";
import { getGarminClient } from "./garmin-upload";

export interface GarminActivity {
  activityId?: number;
  startTimeGMT?: string;
  startTimeLocal?: string;
  duration?: number;
  manufacturer?: string;
}

/** Garmin activities on a given YYYY-MM-DD (activitylist-service search). */
export async function getActivitiesByDate(
  client: GarminClient,
  date: string,
): Promise<GarminActivity[]> {
  const path = `/activitylist-service/activities/search/activities?startDate=${date}&endDate=${date}&start=0&limit=20`;
  const res = await client.connectapi<GarminActivity[]>(path);
  return Array.isArray(res) ? res : [];
}

export interface DuplicateDescriptor {
  workout_id: string;
  workout_title: string | null;
  tool_activity_id: number;
  watch_activity_id: number;
}

export interface WorkoutWindow {
  id: string;
  title?: string | null;
  start_time?: string | null;
  end_time?: string | null;
}

/** Parse an ISO/GMT timestamp to epoch ms, treating a bare (naive) string as UTC. */
function parseMs(s?: string | null): number | null {
  if (!s) return null;
  const iso = /[TZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(" ", "T")}Z`;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * Detect duplicate Garmin activities: for each workout window, a tool activity
 * (manufacturer DEVELOPMENT) AND a watch activity (any other manufacturer) that
 * both overlap the window. Best-effort — a per-workout failure is skipped, never
 * thrown. `getActivities` is injectable for tests.
 */
export async function detectDuplicates(
  client: GarminClient,
  workouts: WorkoutWindow[],
  opts: { getActivities?: (c: GarminClient, date: string) => Promise<GarminActivity[]> } = {},
): Promise<DuplicateDescriptor[]> {
  const getActs = opts.getActivities ?? getActivitiesByDate;
  const dups: DuplicateDescriptor[] = [];
  for (const w of workouts) {
    try {
      const start = parseMs(w.start_time);
      const end = parseMs(w.end_time);
      if (start == null || end == null) continue;
      const date = String(w.start_time).slice(0, 10);
      const acts = await getActs(client, date);
      let toolId: number | null = null;
      let watchId: number | null = null;
      for (const a of acts) {
        const aStart = parseMs(a.startTimeGMT || a.startTimeLocal);
        const aDurMs = (a.duration ?? 0) * 1000;
        if (aStart == null || aDurMs <= 0) continue;
        const aEnd = aStart + aDurMs;
        if (aStart > end || aEnd < start) continue; // no overlap
        const manufacturer = String(a.manufacturer ?? "").toUpperCase();
        if (manufacturer === "DEVELOPMENT") toolId = a.activityId ?? null;
        else if (manufacturer) watchId = a.activityId ?? null;
      }
      if (toolId != null && watchId != null) {
        dups.push({
          workout_id: w.id,
          workout_title: w.title ?? null,
          tool_activity_id: toolId,
          watch_activity_id: watchId,
        });
      }
    } catch {
      // best-effort: skip a workout whose scan fails
    }
  }
  return dups;
}

/** Convenience: build a live Garmin client (used by the route). */
export async function garminClient(): Promise<GarminClient> {
  return getGarminClient();
}
