/**
 * Garmin upload — TS port of hevy2garmin garmin.py (upload_fit, rename, set_description, delete).
 * Uses garmin-auth's GarminClient for DI auth. Upload endpoint proven in Phase-0 ST2.
 */
import { GarminClient, NATIVE_API_USER_AGENT, NATIVE_X_GARMIN_USER_AGENT } from "garmin-auth";

function nativeHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    "User-Agent": NATIVE_API_USER_AGENT,
    "X-Garmin-User-Agent": NATIVE_X_GARMIN_USER_AGENT,
    "X-Garmin-Paired-App-Version": "10861",
    "X-Garmin-Client-Platform": "Android",
    "X-App-Ver": "10861",
    "Authorization": `Bearer ${token}`,
    ...extra,
  };
}

function sanitizeActivityId(v: unknown): number | null {
  if (v == null) return null;
  const n = parseInt(String(v).replace(/['"]/g, ""), 10);
  return Number.isNaN(n) ? null : n;
}

const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));

export interface UploadResult { uploadId: number | null; activityId: number | null; }

/** Upload a FIT (bytes) to Garmin; resolve the activity id (by start time if needed). */
export async function uploadFit(
  client: GarminClient,
  fit: Uint8Array,
  workoutStart?: string,
): Promise<UploadResult> {
  const url = `https://connectapi.${client.domain}/upload-service/upload/.fit`;
  const fd = new FormData();
  fd.append("file", new Blob([fit as unknown as BlobPart], { type: "application/octet-stream" }), "workout.fit");

  const doPost = () => fetch(url, { method: "POST", headers: nativeHeaders(client.di_token!, { NK: "NT" }), body: fd });
  let res = await doPost();
  if (res.status === 401) { await client.refreshDiToken(); res = await doPost(); }
  // 200/201/202 are all accepted (202 = async, per ST2)
  if (![200, 201, 202].includes(res.status)) {
    throw new Error(`Garmin upload failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  let uploadId: number | null = null;
  let activityId: number | null = null;
  try {
    const j = (await res.json()) as { detailedImportResult?: { uploadId?: number; successes?: Array<{ internalId?: unknown }> } };
    const d = j.detailedImportResult ?? {};
    uploadId = d.uploadId ?? null;
    if (d.successes?.length) activityId = sanitizeActivityId(d.successes[0].internalId);
  } catch { /* async 202 may have no JSON body */ }

  // Resolve activity id by start time (never grab "most recent" — wrong-activity risk).
  if (!activityId && workoutStart) {
    for (const wait of [3, 5, 10]) {
      await sleep(wait);
      activityId = await findActivityByStartTime(client, workoutStart);
      if (activityId) break;
    }
  }
  return { uploadId, activityId };
}

/** Find an activity by its start time (matches the uploaded FIT). */
export interface ActivityLookupOptions {
  /** IDs already present before an upload; never adopt one as the new activity. */
  excludeActivityIds?: Iterable<number | string>;
}

const DEDUP_ACTIVITY_TYPES = new Set([
  "strength_training",
  "other",
]);

/** Find a likely matching activity without adopting an unrelated recent run/ride. */
export async function findActivityByStartTime(
  client: GarminClient,
  targetStart: string,
  options: ActivityLookupOptions = {},
): Promise<number | null> {
  const target = new Date(withUtcIfMissing(targetStart)).getTime();
  if (Number.isNaN(target)) return null;
  const acts = await client.connectapi<Array<{
    activityId: number;
    startTimeGMT?: string;
    startTimeLocal?: string;
    activityTypeKey?: string;
    activityType?: { typeKey?: string; parentTypeKey?: string };
  }>>(
    "/activitylist-service/activities/search/activities?limit=100",
  );
  const excluded = new Set([...options.excludeActivityIds ?? []].map(String));
  for (const a of acts) {
    if (excluded.has(String(a.activityId))) continue;
    const typeKey = a.activityTypeKey ?? a.activityType?.typeKey ?? a.activityType?.parentTypeKey;
    if (typeKey && !DEDUP_ACTIVITY_TYPES.has(typeKey)) continue;
    const t = a.startTimeGMT ?? a.startTimeLocal;
    if (t && Math.abs(new Date(withUtcIfMissing(t)).getTime() - target) < 10 * 60 * 1000) {
      return a.activityId;
    }
  }
  return null;
}

function withUtcIfMissing(raw: string): string {
  const value = raw.trim().replace(" ", "T");
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}Z`;
}

/** Rename an activity. */
export async function renameActivity(client: GarminClient, activityId: number, name: string): Promise<void> {
  await postJson(client, `/activity-service/activity/${activityId}`, { activityId, activityName: name });
}

/** Set an activity's description. */
export async function setDescription(client: GarminClient, activityId: number, description: string): Promise<void> {
  await postJson(client, `/activity-service/activity/${activityId}`, { activityId, description });
}

/** Delete an activity. */
export async function deleteActivity(client: GarminClient, activityId: number): Promise<void> {
  const url = `https://connectapi.${client.domain}/activity-service/activity/${activityId}`;
  const req = () => fetch(url, { method: "DELETE", headers: nativeHeaders(client.di_token!, { NK: "NT" }) });
  let res = await req();
  if (res.status === 401) { await client.refreshDiToken(); res = await req(); }
  if (![200, 204].includes(res.status)) throw new Error(`delete activity ${activityId} → ${res.status}`);
}

async function postJson(client: GarminClient, path: string, body: unknown): Promise<void> {
  const url = `https://connectapi.${client.domain}${path}`;
  const req = () => fetch(url, {
    method: "POST",
    headers: nativeHeaders(client.di_token!, { "Content-Type": "application/json", "X-HTTP-Method-Override": "PUT", NK: "NT" }),
    body: JSON.stringify(body),
  });
  let res = await req();
  if (res.status === 401) { await client.refreshDiToken(); res = await req(); }
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}`);
}
