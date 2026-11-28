/**
 * Hevy workout photos on the Garmin activity they synced to (#237).
 *
 * The workout the sync already fetched carries `media`: images and videos, in
 * display order. Each image goes up to the activity through garmin-auth's
 * `uploadActivityImage`; videos never do, and neither does a video's
 * thumbnail. `synced_media` records what went up, per workout, photo URL and
 * activity, so a sync or a Resync only adds what is new, and a Resync adds
 * photos to workouts synced before this existed.
 *
 * Only Hevy's own photo hosts are fetched, over https, without following a
 * redirect. The URLs come from Hevy, but the server fetching them may sit in
 * a network where a planted URL (a cloud metadata address, localhost) would
 * reach something it should not; a refused URL is logged with its host.
 *
 * A photo never fails a sync, the same contract as the intervals.icu cleanup
 * hook: a failed download or upload is logged and skipped, and since it is
 * not recorded, the next sync or Resync tries it again. Nothing here throws.
 */
import { uploadActivityImage, type GarminClient } from "garmin-auth";
import { createRateLimiter, isRateLimited, type SyncOneResult } from "hevy2garmin";
import { demoMode } from "./demo";
import type { Sql } from "./pending-store";

/** Larger than any phone photo; anything bigger is skipped rather than held in memory. */
export const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 20_000;

/**
 * The hosts a photo is fetched from: Hevy's own domains and the CloudFront
 * CDN its API returns photo URLs on. An entry starting with "." matches any
 * subdomain, by whole labels, so `evilcloudfront.net` does not match
 * `.cloudfront.net`; the others match exactly.
 */
export const PHOTO_HOSTS = ["hevy.com", "hevyapp.com", ".hevy.com", ".hevyapp.com", ".cloudfront.net"] as const;

/** Types a CDN may send for an image without naming it; treated as JPEG, which Hevy photos are. */
const GENERIC_TYPES = new Set(["", "application/octet-stream", "binary/octet-stream"]);

export interface PhotoSyncOptions {
  sql: Sql;
  hevyId: string;
  activityId: number;
  /** The Hevy workout as fetched for the sync; its `media` is read. */
  workout: unknown;
  /** The sync's Garmin client, built only when there is something to upload. */
  client: () => Promise<GarminClient>;
  fetchImpl?: typeof fetch;
  upload?: typeof uploadActivityImage;
  /**
   * Paces the uploads like the engine's gateway paces its calls: a pause
   * after each one. It does not wait out a rate limit, which would hold a
   * serverless request for up to 90 s over a photo; a rate-limited photo stops
   * the rest instead, and the next sync tries them.
   */
  limit?: <T>(fn: () => Promise<T>) => Promise<T>;
  log?: (message: string) => void;
}

export interface PhotoSyncSummary {
  uploaded: number;
  skipped: number;
}

/** The workout's image URLs in display order: videos, thumbnails and unusable items left out. */
export function imageMediaUrls(workout: unknown): string[] {
  const media = (workout as { media?: unknown } | null)?.media;
  if (!Array.isArray(media)) return [];
  const urls: string[] = [];
  for (const item of media) {
    if (!item || typeof item !== "object") continue;
    const { type, url } = item as { type?: unknown; url?: unknown };
    if (type !== "image" || typeof url !== "string" || !url) continue;
    if (!urls.includes(url)) urls.push(url);
  }
  return urls;
}

/**
 * The Garmin activity a sync outcome's photos belong on, or null for none.
 *
 * Every live outcome that ends on an activity is `synced` with its id: a fresh
 * upload (and the replace strategy's named one), a match or upload_fallback, a
 * merge into the watch activity, and a Resync. A dry run, merge_pending,
 * deferred, failed or any other result gets nothing.
 */
export function photoActivityId(result: SyncOneResult): number | null {
  if (result.status !== "synced" || result.dryRun) return null;
  return result.garminActivityId ?? null;
}

function isPhotoHost(host: string): boolean {
  return PHOTO_HOSTS.some((h) => (h.startsWith(".") ? host.endsWith(h) : host === h));
}

/** Why a photo URL may not be fetched, or null when it may: https, the default port, a Hevy photo host. */
export function photoUrlRefusal(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "not a valid URL";
  }
  if (u.protocol !== "https:") return `not https (${u.protocol} on host ${u.hostname || "none"})`;
  if (u.port) return `port ${u.port} on host ${u.hostname}, not the https default`;
  if (!isPhotoHost(u.hostname)) return `host ${u.hostname} is not a Hevy photo host`;
  return null;
}

/** The host a redirect points at, for the log. */
function redirectHost(location: string | null, from: URL): string {
  if (!location) return "unknown";
  try {
    return new URL(location, from).hostname || "unknown";
  } catch {
    return "unknown";
  }
}

async function uploadedUrls(sql: Sql, hevyId: string, activityId: number): Promise<Set<string>> {
  const rows = (await sql`
    SELECT media_url FROM synced_media
    WHERE hevy_id = ${hevyId} AND garmin_activity_id = ${String(activityId)}
  `) as Array<{ media_url: string }>;
  return new Set(rows.map((r) => r.media_url));
}

/** One row per workout and photo URL; a photo put on another activity moves its row there. */
async function recordUploaded(sql: Sql, hevyId: string, mediaUrl: string, activityId: number): Promise<void> {
  await sql`
    INSERT INTO synced_media (hevy_id, media_url, garmin_activity_id, uploaded_at)
    VALUES (${hevyId}, ${mediaUrl}, ${String(activityId)}, NOW())
    ON CONFLICT (hevy_id, media_url)
    DO UPDATE SET garmin_activity_id = EXCLUDED.garmin_activity_id, uploaded_at = NOW()
  `;
}

/** The photo, or why not: `skip` is the whole outcome, "skipped, …" or "refused, …". */
type Download = { bytes: Uint8Array; contentType: string } | { skip: string };

async function download(url: string, fetchImpl: typeof fetch): Promise<Download> {
  // Not followed: where a redirect leads was never checked against PHOTO_HOSTS.
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), redirect: "manual" });
  if ((res.status >= 300 && res.status < 400) || res.type === "opaqueredirect") {
    await res.body?.cancel().catch(() => {});
    const from = new URL(url);
    return {
      skip: `refused, redirect (HTTP ${res.status}) from host ${from.hostname} to host ${redirectHost(res.headers.get("location"), from)}`,
    };
  }
  if (!res.ok) return { skip: `skipped, download failed: HTTP ${res.status}` };
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!type.startsWith("image/") && !GENERIC_TYPES.has(type)) return { skip: `skipped, not an image (${type})` };
  if (Number(res.headers.get("content-length")) > MAX_PHOTO_BYTES) {
    await res.body?.cancel().catch(() => {});
    return { skip: "skipped, too large" };
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length === 0) return { skip: "skipped, empty" };
  if (bytes.length > MAX_PHOTO_BYTES) return { skip: "skipped, too large" };
  return { bytes, contentType: type.startsWith("image/") ? type : "image/jpeg" };
}

function filenameFor(contentType: string): string {
  const subtype = contentType.slice("image/".length).replace(/[^a-z0-9]/g, "");
  return `photo.${subtype === "jpeg" || !subtype ? "jpg" : subtype}`;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Upload the workout's images that this activity does not have yet. Never throws. */
export async function syncWorkoutPhotos(options: PhotoSyncOptions): Promise<PhotoSyncSummary> {
  const summary: PhotoSyncSummary = { uploaded: 0, skipped: 0 };
  // The demo's Garmin and Hevy are placeholders, and the demo writes nothing.
  if (demoMode()) return summary;

  const {
    sql,
    hevyId,
    activityId,
    fetchImpl = fetch,
    upload = uploadActivityImage,
    limit = createRateLimiter({ maxAttempts: 1 }),
    log = (m: string) => console.warn(m),
  } = options;
  const say = (m: string) => log(`[photos] workout ${hevyId}: ${m}`);

  const urls = imageMediaUrls(options.workout);
  if (!urls.length) return summary;

  let done: Set<string>;
  try {
    done = await uploadedUrls(sql, hevyId, activityId);
  } catch (err) {
    // Without the record every photo looks new, and uploading them all again
    // is how an activity ends up with each photo twice.
    say(`photos skipped, the record could not be read: ${message(err)}`);
    return { uploaded: 0, skipped: urls.length };
  }
  // Checked before anything is fetched, and before signing in to Garmin, so a
  // workout whose photos are all refused never logs in.
  const pending: string[] = [];
  for (const url of urls.filter((u) => !done.has(u))) {
    const refusal = photoUrlRefusal(url);
    if (refusal) {
      say(`${url} refused, ${refusal}`);
      summary.skipped++;
    } else {
      pending.push(url);
    }
  }
  if (!pending.length) return summary;

  let client: GarminClient;
  try {
    client = await options.client();
  } catch (err) {
    say(`photos skipped, no Garmin client: ${message(err)}`);
    summary.skipped += pending.length;
    return summary;
  }

  for (const [i, url] of pending.entries()) {
    let photo: Download;
    try {
      photo = await download(url, fetchImpl);
    } catch (err) {
      photo = { skip: `skipped, download failed: ${message(err)}` };
    }
    if ("skip" in photo) {
      say(`${url} ${photo.skip}`);
      summary.skipped++;
      continue;
    }

    const { bytes, contentType } = photo;
    try {
      await limit(() => upload(client, activityId, bytes, { filename: filenameFor(contentType), contentType }));
    } catch (err) {
      if (isRateLimited(err)) {
        say(`Garmin rate limit, ${pending.length - i} photo(s) left for the next sync: ${message(err)}`);
        summary.skipped += pending.length - i;
        return summary;
      }
      say(`${url} upload failed: ${message(err)}`);
      summary.skipped++;
      continue;
    }
    summary.uploaded++;

    try {
      await recordUploaded(sql, hevyId, url, activityId);
    } catch (err) {
      // The photo is on Garmin. Unrecorded, the next sync uploads it again;
      // logging it is all that is left to do.
      say(`${url} uploaded but could not be recorded, so it may be uploaded again: ${message(err)}`);
    }
  }
  return summary;
}
