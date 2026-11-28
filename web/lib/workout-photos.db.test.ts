import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import postgres from "postgres";
import type { GarminClient } from "garmin-auth";
import type { Sql } from "./pending-store";
import { SCHEMA_STATEMENTS } from "./schema";
import { syncWorkoutPhotos } from "./workout-photos";

/**
 * The photo record against a real Postgres (#237), because what is under test
 * is the `synced_media` lookup and upsert: a photo is skipped only when this
 * same activity already has it, and one workout and URL stay one row when the
 * photo goes to another activity.
 *
 * Runs only when TEST_DATABASE_URL names a database it may write to; it
 * creates the schema there and deletes only the rows it made.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("synced_media against Postgres (#237)", () => {
  let db: ReturnType<typeof postgres>;
  let sql: Sql;
  const ids: string[] = [];
  const id = (name: string) => {
    const hevyId = `test-237-${name}-${Date.now()}`;
    ids.push(hevyId);
    return hevyId;
  };
  const IMG1 = "https://d2l9nsnmtah87f.cloudfront.net/workout-images/a.jpg";
  const IMG2 = "https://d2l9nsnmtah87f.cloudfront.net/workout-images/b.jpg";
  const workout = { media: [{ type: "image", url: IMG1 }, { type: "image", url: IMG2 }] };
  const fetchImpl = (async () =>
    new Response(new Uint8Array([0xff, 0xd8]), { status: 200, headers: { "content-type": "image/jpeg" } })) as typeof fetch;

  async function run(hevyId: string, activityId: number) {
    const upload = vi.fn(async () => {});
    const summary = await syncWorkoutPhotos({
      sql,
      hevyId,
      activityId,
      workout,
      client: async () => ({}) as GarminClient,
      fetchImpl,
      upload,
      limit: (fn) => fn(),
      log: () => {},
    });
    return { summary, uploads: upload.mock.calls.length };
  }

  const rows = (hevyId: string) =>
    db`SELECT media_url, garmin_activity_id FROM synced_media WHERE hevy_id = ${hevyId} ORDER BY media_url`;

  beforeAll(async () => {
    db = postgres(url!, { prepare: false, onnotice: () => {} });
    sql = db as unknown as Sql;
    for (const s of SCHEMA_STATEMENTS) await db.unsafe(s);
  });

  afterAll(async () => {
    if (ids.length) await db`DELETE FROM synced_media WHERE hevy_id = ANY(${ids})`;
    await db.end();
  });

  it("records each photo for the activity, and a second sync uploads nothing", async () => {
    const hevyId = id("again");
    expect(await run(hevyId, 501)).toEqual({ summary: { uploaded: 2, skipped: 0 }, uploads: 2 });
    expect(await rows(hevyId)).toEqual([
      { media_url: IMG1, garmin_activity_id: "501" },
      { media_url: IMG2, garmin_activity_id: "501" },
    ]);
    expect(await run(hevyId, 501)).toEqual({ summary: { uploaded: 0, skipped: 0 }, uploads: 0 });
  });

  it("a photo the record has for another activity goes up again, and its one row moves", async () => {
    const hevyId = id("moved");
    await run(hevyId, 601);
    expect(await run(hevyId, 602)).toEqual({ summary: { uploaded: 2, skipped: 0 }, uploads: 2 });
    expect(await rows(hevyId)).toEqual([
      { media_url: IMG1, garmin_activity_id: "602" },
      { media_url: IMG2, garmin_activity_id: "602" },
    ]);
  });

  it("another workout's record does not count", async () => {
    const first = id("first");
    const second = id("second");
    await run(first, 701);
    expect(await run(second, 701)).toEqual({ summary: { uploaded: 2, skipped: 0 }, uploads: 2 });
  });
});
