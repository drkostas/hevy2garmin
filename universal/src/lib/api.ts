import { useCallback, useEffect, useState } from "react";

/**
 * hevy2garmin universal data. The sync state lives in the soma DB
 * (workout_enrichment, populated by the TS hevy-sync cron), exposed at
 * /api/hevy/status. Override the host with EXPO_PUBLIC_API_URL for device/prod.
 */
const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:3456";

/** Personal API token for prod (soma.gkos.dev gates /api/* behind a session;
    the token bypasses that for this native client). Empty in local dev. */
const API_TOKEN = process.env.EXPO_PUBLIC_API_TOKEN;
const AUTH_HEADERS: Record<string, string> = API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {};

export interface HevyWorkout {
  title: string;
  date: string;
  kcal: number;
  exercises: number;
  sets: number;
  synced: boolean;
  status: string;
}

export interface HevyStatus {
  hevyConnected: boolean;
  garminConnected: boolean;
  totalSynced: number;
  syncedThisWeek: number;
  recent: HevyWorkout[];
}

export function useHevyStatus() {
  const [data, setData] = useState<HevyStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let alive = true;
    fetch(`${API_BASE}/api/hevy/status`, { headers: AUTH_HEADERS })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: HevyStatus) => alive && (setData(d), setError(null)))
      .catch((e) => alive && setError(String(e.message ?? e)));
    return () => { alive = false; };
  }, [reload]);
  return { data, error, refetch: () => setReload((n) => n + 1) };
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
