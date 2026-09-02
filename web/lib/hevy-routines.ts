/**
 * Fetch the user's Hevy routines. The TS HevyClient has no getRoutines, so this
 * calls the Hevy REST API directly (GET /v1/routines) with the resolved key.
 * READ-ONLY.
 */
import { resolveHevyKey } from "./hevy-sync";
import type { HevyRoutine } from "./garmin-workout";

const HEVY_BASE = "https://api.hevyapp.com/v1";
const MAX_PAGES = 5;

export async function fetchHevyRoutines(
  key?: string | null,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<HevyRoutine[]> {
  const apiKey = await resolveHevyKey(key);
  if (!apiKey) throw new Error("No Hevy API key available.");
  const f = opts.fetchImpl ?? fetch;
  const routines: HevyRoutine[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await f(`${HEVY_BASE}/routines?page=${page}&pageSize=10`, {
      headers: { "api-key": apiKey, accept: "application/json" },
    });
    if (!res.ok) {
      if (page === 1) throw new Error(`Hevy routines request failed (${res.status}).`);
      break;
    }
    const data = (await res.json()) as { routines?: HevyRoutine[]; page_count?: number };
    const batch = Array.isArray(data.routines) ? data.routines : [];
    routines.push(...batch);
    if (batch.length === 0 || (typeof data.page_count === "number" && page >= data.page_count)) break;
  }
  return routines;
}
