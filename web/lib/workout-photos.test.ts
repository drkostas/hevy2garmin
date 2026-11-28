import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { GarminClient } from "garmin-auth";
import type { SyncOneResult } from "./sync-one";
import {
  imageMediaUrls,
  photoActivityId,
  syncWorkoutPhotos,
  MAX_PHOTO_BYTES,
  type PhotoSyncOptions,
} from "./workout-photos";

/**
 * Hevy workout photos on the Garmin activity (#237).
 *
 * A workout's `media` (images and videos, in display order) is read from the
 * workout the sync already fetched. Images go up to the activity; videos never
 * do. What went up is recorded per workout, photo URL and activity, so a sync
 * or a Resync only adds what is new. A photo never fails a sync: a failed
 * download or upload is logged, skipped and left unrecorded, so the next sync
 * or Resync tries it again.
 */

const IMG1 = "https://d2l9nsnmtah87f.cloudfront.net/workout-images/a.jpg";
const IMG2 = "https://d2l9nsnmtah87f.cloudfront.net/workout-images/b.jpg";
const VIDEO = "https://d2l9nsnmtah87f.cloudfront.net/workout-videos/v.mp4";
const THUMB = "https://d2l9nsnmtah87f.cloudfront.net/workout-videos/v.jpg";
const ACTIVITY = 22_100_200_300;

const workout = (media: unknown) => ({ id: "w1", title: "Push", media });
const image = (url: string) => ({ type: "image", url });
const video = (url: string) => ({ type: "video", url, thumbnail_url: THUMB });

/** A fake `synced_media` table: `rows` are (hevy_id, media_url, garmin_activity_id). */
function fakeSql(initial: Array<[string, string, string]> = [], fail: { read?: boolean; write?: boolean } = {}) {
  const rows = initial.map(([hevy_id, media_url, garmin_activity_id]) => ({ hevy_id, media_url, garmin_activity_id }));
  const queries: string[] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    queries.push(text);
    if (/^\s*SELECT media_url FROM synced_media/.test(text)) {
      if (fail.read) return Promise.reject(new Error("relation synced_media does not exist"));
      const [hevyId, activityId] = values as [string, string];
      return Promise.resolve(
        rows.filter((r) => r.hevy_id === hevyId && r.garmin_activity_id === activityId).map((r) => ({ media_url: r.media_url })),
      );
    }
    if (/^\s*INSERT INTO synced_media/.test(text)) {
      if (fail.write) return Promise.reject(new Error("connection reset"));
      const [hevy_id, media_url, garmin_activity_id] = values as [string, string, string];
      const existing = rows.find((r) => r.hevy_id === hevy_id && r.media_url === media_url);
      if (existing) existing.garmin_activity_id = garmin_activity_id;
      else rows.push({ hevy_id, media_url, garmin_activity_id });
      return Promise.resolve([]);
    }
    return Promise.reject(new Error("unexpected query: " + text));
  }) as never;
  return { sql, rows, queries };
}

const jpeg = (bytes = [0xff, 0xd8, 0xff, 0xe0], headers: Record<string, string> = { "content-type": "image/jpeg" }) =>
  new Response(new Uint8Array(bytes), { status: 200, headers });

/** Answers each URL from `routes`; anything else is a 404. Records the URLs asked for. */
function fakeFetch(routes: Record<string, () => Response | Promise<Response>>) {
  const asked: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    asked.push(String(url));
    const route = routes[String(url)];
    return route ? route() : new Response("", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, asked };
}

const CLIENT = { name: "garmin-client" } as unknown as GarminClient;

function setup(over: Partial<PhotoSyncOptions> & { initial?: Array<[string, string, string]>; failSql?: { read?: boolean; write?: boolean } } = {}) {
  const db = fakeSql(over.initial, over.failSql);
  const upload = vi.fn<NonNullable<PhotoSyncOptions["upload"]>>(async () => {});
  const limitCalls = vi.fn();
  const limit = <T,>(fn: () => Promise<T>): Promise<T> => {
    limitCalls();
    return fn();
  };
  const log = vi.fn((_m: string) => {});
  const client = vi.fn(async () => CLIENT);
  const options: PhotoSyncOptions = {
    sql: db.sql,
    hevyId: "w1",
    activityId: ACTIVITY,
    workout: workout([image(IMG1), image(IMG2)]),
    client,
    fetchImpl: fakeFetch({ [IMG1]: () => jpeg([1, 2, 3]), [IMG2]: () => jpeg([4, 5]) }).fetchImpl,
    upload,
    limit,
    log,
    ...over,
  };
  return { db, upload, limitCalls, log, client, options };
}

describe("imageMediaUrls", () => {
  it("lists image URLs in display order and skips videos, never using a thumbnail", () => {
    expect(imageMediaUrls(workout([image(IMG1), video(VIDEO), image(IMG2)]))).toEqual([IMG1, IMG2]);
  });

  it("is empty for no media, a missing field, or something that is not a list", () => {
    expect(imageMediaUrls(workout([]))).toEqual([]);
    expect(imageMediaUrls({ id: "w1" })).toEqual([]);
    expect(imageMediaUrls(workout("nope"))).toEqual([]);
    expect(imageMediaUrls(null)).toEqual([]);
  });

  it("skips items without a usable http(s) URL, and lists a repeated URL once", () => {
    expect(
      imageMediaUrls(
        workout([
          { type: "image" },
          { type: "image", url: 42 },
          { type: "image", url: "" },
          { type: "image", url: "file:///etc/passwd" },
          null,
          "image",
          image(IMG1),
          image(IMG1),
        ]),
      ),
    ).toEqual([IMG1]);
  });
});

describe("photoActivityId: which sync outcomes get photos", () => {
  const result = (over: Partial<SyncOneResult>): SyncOneResult =>
    ({
      status: "synced",
      dryRun: false,
      wouldUpload: false,
      dedupDecision: "would_upload",
      workout: { hevy_id: "w1", title: "Push", start_time: null },
      fitStats: null,
      existingGarminActivityId: null,
      garminActivityId: ACTIVITY,
      remaining: 0,
      syncMethod: "upload",
      error: null,
      ...over,
    }) as SyncOneResult;

  it.each([
    ["a fresh upload (and replace's named upload)", { syncMethod: "upload" as const }],
    ["a match or upload_fallback", { syncMethod: "match" as const, dedupDecision: "existing_garmin_activity" as const }],
    ["a merge into the watch activity, or a Resync", { syncMethod: "merge" as const }],
  ])("%s: the activity id", (_name, over) => {
    expect(photoActivityId(result(over))).toBe(ACTIVITY);
  });

  it.each(["dry_run", "merge_pending", "deferred", "failed", "error", "skipped", "none", "processing", "needs_review", "target_missing"] as const)(
    "%s: none",
    (status) => {
      expect(photoActivityId(result({ status }))).toBeNull();
    },
  );

  it("a dry run reported as synced, or a sync with no activity id: none", () => {
    expect(photoActivityId(result({ dryRun: true }))).toBeNull();
    expect(photoActivityId(result({ garminActivityId: null }))).toBeNull();
  });
});

describe("syncWorkoutPhotos", () => {
  const saved = process.env.DEMO_MODE;
  beforeEach(() => {
    delete process.env.DEMO_MODE;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.DEMO_MODE;
    else process.env.DEMO_MODE = saved;
  });

  it("uploads each image in order, as its own type, and records it for this activity", async () => {
    const { db, upload, options } = setup();
    expect(await syncWorkoutPhotos(options)).toEqual({ uploaded: 2, skipped: 0 });
    expect(upload.mock.calls.map((c) => [c[0], c[1], Array.from(c[2] as Uint8Array), c[3]])).toEqual([
      [CLIENT, ACTIVITY, [1, 2, 3], { filename: "photo.jpg", contentType: "image/jpeg" }],
      [CLIENT, ACTIVITY, [4, 5], { filename: "photo.jpg", contentType: "image/jpeg" }],
    ]);
    expect(db.rows).toEqual([
      { hevy_id: "w1", media_url: IMG1, garmin_activity_id: String(ACTIVITY) },
      { hevy_id: "w1", media_url: IMG2, garmin_activity_id: String(ACTIVITY) },
    ]);
  });

  it("goes through the rate limiter for every upload", async () => {
    const { limitCalls, upload, options } = setup();
    await syncWorkoutPhotos(options);
    expect(limitCalls).toHaveBeenCalledTimes(2);
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it("never downloads or uploads a video", async () => {
    const f = fakeFetch({ [IMG1]: () => jpeg() });
    const { upload, options } = setup({ workout: workout([video(VIDEO), image(IMG1)]), fetchImpl: f.fetchImpl });
    await syncWorkoutPhotos(options);
    expect(f.asked).toEqual([IMG1]);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("skips a photo already recorded for this activity, without downloading it", async () => {
    const f = fakeFetch({ [IMG1]: () => jpeg(), [IMG2]: () => jpeg() });
    const { upload, options } = setup({ initial: [["w1", IMG1, String(ACTIVITY)]], fetchImpl: f.fetchImpl });
    expect(await syncWorkoutPhotos(options)).toEqual({ uploaded: 1, skipped: 0 });
    expect(f.asked).toEqual([IMG2]);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("a Resync adds only the photo that is new since the last sync", async () => {
    const f = fakeFetch({ [IMG1]: () => jpeg(), [IMG2]: () => jpeg([9]) });
    const { upload, db, options } = setup({ initial: [["w1", IMG1, String(ACTIVITY)]], fetchImpl: f.fetchImpl });
    await syncWorkoutPhotos(options);
    expect(upload.mock.calls.map((c) => Array.from(c[2] as Uint8Array))).toEqual([[9]]);
    expect(db.rows.map((r) => r.media_url)).toEqual([IMG1, IMG2]);
  });

  it("a photo recorded for another activity goes up to this one, and its record moves", async () => {
    const { upload, db, options } = setup({ initial: [["w1", IMG1, "111"], ["w1", IMG2, "111"]] });
    expect(await syncWorkoutPhotos(options)).toEqual({ uploaded: 2, skipped: 0 });
    expect(upload).toHaveBeenCalledTimes(2);
    expect(db.rows).toEqual([
      { hevy_id: "w1", media_url: IMG1, garmin_activity_id: String(ACTIVITY) },
      { hevy_id: "w1", media_url: IMG2, garmin_activity_id: String(ACTIVITY) },
    ]);
  });

  it("nothing to upload: no Garmin client, no download", async () => {
    const f = fakeFetch({});
    const { client, options } = setup({ workout: workout([video(VIDEO)]), fetchImpl: f.fetchImpl });
    expect(await syncWorkoutPhotos(options)).toEqual({ uploaded: 0, skipped: 0 });
    expect(client).not.toHaveBeenCalled();
    expect(f.asked).toEqual([]);

    const all = setup({ initial: [["w1", IMG1, String(ACTIVITY)], ["w1", IMG2, String(ACTIVITY)]] });
    expect(await syncWorkoutPhotos(all.options)).toEqual({ uploaded: 0, skipped: 0 });
    expect(all.client).not.toHaveBeenCalled();
  });

  it.each([
    ["an HTTP error", () => new Response("gone", { status: 403 }), /HTTP 403/],
    ["a network failure", () => Promise.reject(new TypeError("fetch failed")), /fetch failed/],
    ["a non-image response", () => new Response("<html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }), /not an image \(text\/html\)/],
    ["an empty body", () => new Response(new Uint8Array(0), { status: 200, headers: { "content-type": "image/jpeg" } }), /empty/],
  ])("a download that fails with %s: logged, skipped, not recorded, and the next photo still goes up", async (_name, failing, message) => {
    const f = fakeFetch({ [IMG1]: failing, [IMG2]: () => jpeg([7]) });
    const { upload, db, log, options } = setup({ fetchImpl: f.fetchImpl });
    expect(await syncWorkoutPhotos(options)).toEqual({ uploaded: 1, skipped: 1 });
    expect(upload.mock.calls.map((c) => Array.from(c[2] as Uint8Array))).toEqual([[7]]);
    expect(db.rows.map((r) => r.media_url)).toEqual([IMG2]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain(IMG1);
    expect(log.mock.calls[0][0]).toMatch(message);
  });

  it("a photo too large by its Content-Length is skipped without reading the body", async () => {
    let read = false;
    const big = () => {
      // highWaterMark 0: pull runs only when someone reads, not to prefill the queue.
      const body = new ReadableStream(
        {
          pull(controller) {
            read = true;
            controller.enqueue(new Uint8Array([1]));
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(body, { status: 200, headers: { "content-type": "image/jpeg", "content-length": String(MAX_PHOTO_BYTES + 1) } });
    };
    const { upload, log, options } = setup({ fetchImpl: fakeFetch({ [IMG1]: big, [IMG2]: () => jpeg() }).fetchImpl });
    expect(await syncWorkoutPhotos(options)).toEqual({ uploaded: 1, skipped: 1 });
    expect(read).toBe(false);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/too large/);
  });

  it("a photo too large without a Content-Length is skipped once read", async () => {
    const big = () => new Response(new Uint8Array(MAX_PHOTO_BYTES + 1), { status: 200, headers: { "content-type": "image/jpeg" } });
    const { upload, options } = setup({ fetchImpl: fakeFetch({ [IMG1]: big, [IMG2]: () => jpeg() }).fetchImpl });
    expect(await syncWorkoutPhotos(options)).toEqual({ uploaded: 1, skipped: 1 });
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("uses the response's image type, and JPEG when the type is missing or generic", async () => {
    const png = () => new Response(new Uint8Array([0x89, 0x50]), { status: 200, headers: { "content-type": "image/png" } });
    const untyped = () => new Response(new Uint8Array([1]), { status: 200 });
    const IMG3 = IMG2.replace("b.jpg", "c.jpg");
    const generic = () => new Response(new Uint8Array([2]), { status: 200, headers: { "content-type": "application/octet-stream" } });
    const { upload, options } = setup({
      workout: workout([image(IMG1), image(IMG2), image(IMG3)]),
      fetchImpl: fakeFetch({ [IMG1]: png, [IMG2]: untyped, [IMG3]: generic }).fetchImpl,
    });
    await syncWorkoutPhotos(options);
    expect(upload.mock.calls.map((c) => c[3])).toEqual([
      { filename: "photo.png", contentType: "image/png" },
      { filename: "photo.jpg", contentType: "image/jpeg" },
      { filename: "photo.jpg", contentType: "image/jpeg" },
    ]);
  });

  it("an upload that fails: logged, not recorded, and the next photo still goes up", async () => {
    const { upload, db, log, options } = setup();
    upload.mockRejectedValueOnce(new Error("Garmin POST /activity-service/activity/1/image -> 500"));
    expect(await syncWorkoutPhotos(options)).toEqual({ uploaded: 1, skipped: 1 });
    expect(upload).toHaveBeenCalledTimes(2);
    expect(db.rows.map((r) => r.media_url)).toEqual([IMG2]);
    expect(log.mock.calls[0][0]).toMatch(/upload failed.*500/);
  });

  it("Garmin rate limiting stops the rest of the photos, to be tried on the next sync", async () => {
    const { upload, db, log, options } = setup();
    upload.mockRejectedValueOnce(new Error("Garmin returned 429 Too Many Requests"));
    expect(await syncWorkoutPhotos(options)).toEqual({ uploaded: 0, skipped: 2 });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(db.rows).toEqual([]);
    expect(log.mock.calls.at(-1)![0]).toMatch(/rate limit/i);
  });

  it("no Garmin client: nothing uploaded or recorded, logged", async () => {
    const { upload, db, log, options } = setup({ client: vi.fn(async () => { throw new Error("Garmin not connected"); }) });
    expect(await syncWorkoutPhotos(options)).toEqual({ uploaded: 0, skipped: 2 });
    expect(upload).not.toHaveBeenCalled();
    expect(db.rows).toEqual([]);
    expect(log.mock.calls[0][0]).toMatch(/Garmin not connected/);
  });

  it("the record cannot be read: nothing is uploaded, rather than risking duplicates", async () => {
    const f = fakeFetch({ [IMG1]: () => jpeg() });
    const { upload, log, options } = setup({ failSql: { read: true }, fetchImpl: f.fetchImpl });
    expect(await syncWorkoutPhotos(options)).toEqual({ uploaded: 0, skipped: 2 });
    expect(f.asked).toEqual([]);
    expect(upload).not.toHaveBeenCalled();
    expect(log.mock.calls[0][0]).toMatch(/does not exist/);
  });

  it("an upload that cannot be recorded is logged, and the rest carry on", async () => {
    const { upload, log, options } = setup({ failSql: { write: true } });
    expect(await syncWorkoutPhotos(options)).toEqual({ uploaded: 2, skipped: 0 });
    expect(upload).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0][0]).toMatch(/could not be recorded.*connection reset/);
  });

  it("demo mode: no download, no upload, no database", async () => {
    process.env.DEMO_MODE = "true";
    const f = fakeFetch({ [IMG1]: () => jpeg() });
    const { upload, client, db, options } = setup({ fetchImpl: f.fetchImpl });
    expect(await syncWorkoutPhotos(options)).toEqual({ uploaded: 0, skipped: 0 });
    expect(f.asked).toEqual([]);
    expect(upload).not.toHaveBeenCalled();
    expect(client).not.toHaveBeenCalled();
    expect(db.queries).toEqual([]);
  });
});
