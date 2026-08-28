import { useCallback, useEffect, useState } from "react";

/**
 * hevy2garmin universal data, exposed at /api/hevy/status. Override the host
 * with EXPO_PUBLIC_API_URL for device/prod.
 */
const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:8123";

/** Personal API token for a hosted deployment whose API is session-gated.
    Empty in local development. */
const API_TOKEN = process.env.EXPO_PUBLIC_API_TOKEN;
const AUTH_HEADERS: Record<string, string> = API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {};

export interface HevyWorkout {
  hevy_id: string;
  title: string;
  synced_at: string | null;
  calories: number | null;
  avg_hr: number | null;
  garmin_activity_id: string | null;
  status: string;
}

export interface HevyStatus {
  hevyConnected: boolean;
  garminConnected: boolean;
  totalSynced: number;
  syncedThisWeek: number;
  recent: HevyWorkout[];
}

/**
 * Small GET-JSON hook shared by every screen. Fetches `path` off API_BASE with
 * the auth header, exposes { data, error, refetch }, and cancels in-flight state
 * updates on unmount so a late response can't set state on a dead screen.
 */
function useApiGet<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let alive = true;
    fetch(`${API_BASE}${path}`, { headers: AUTH_HEADERS })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: T) => alive && (setData(d), setError(null)))
      .catch((e) => alive && setError(String(e.message ?? e)));
    return () => { alive = false; };
  }, [path, reload]);
  return { data, error, refetch: () => setReload((n) => n + 1) };
}

export function useHevyStatus() {
  return useApiGet<HevyStatus>("/api/hevy/status");
}

/** One custom exercise mapping (overrides the built-in map for that name). */
export interface CustomMapping {
  hevy_name: string;
  category: number;
  subcategory: number;
}

/** A sampled entry from the built-in HEVY_TO_GARMIN map. */
export interface BuiltinMappingSample {
  name: string;
  category: number;
  categoryName: string;
}

export interface MappingsData {
  dbConfigured: boolean;
  customCount: number;
  builtinCount: number;
  custom: CustomMapping[];
  sample: BuiltinMappingSample[];
}

/** Exercise-mapping summary — custom overrides + built-in map, from /api/mappings. */
export function useMappings() {
  return useApiGet<MappingsData>("/api/mappings");
}

/** One synced (terminal) or in-flight (pending) workout row. */
export interface WorkoutItem {
  hevy_id: string;
  title: string;
  synced_at: string | null;
  calories: number | null;
  avg_hr: number | null;
  garmin_activity_id: string | null;
  /** Terminal status (success/manual/skipped) or a pending phase. */
  status: string;
  kind: "terminal" | "pending";
  detail: string | null;
}

export interface WorkoutsData {
  dbConfigured: boolean;
  workouts: WorkoutItem[];
}

/** Synced + pending workouts, newest-first, from /api/workouts. */
export function useWorkouts() {
  return useApiGet<WorkoutsData>("/api/workouts");
}

/**
 * Pull-to-refresh helper: wraps refetch callbacks in a spinner-friendly
 * `refreshing` flag that drops after a short beat so the control settles.
 */
export function usePullRefresh(...refetchers: Array<() => void>) {
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    refetchers.forEach((r) => r());
    setTimeout(() => setRefreshing(false), 900);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, refetchers);
  return { refreshing, onRefresh };
}
