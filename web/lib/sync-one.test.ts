import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GarminClient } from "garmin-auth";

/**
 * The engine (dedup layers, dry-run default, merge, HR fusion,
 * claim→upload→finalize) is tested in the hevy2garmin package. These tests
 * cover THIS app's wiring of it: the store is bound to the route's `sql`, the
 * Garmin client is built lazily and once, the Hevy fetch is the app's, and the
 * settings the user saved actually reach the engine.
 */
const h = vi.hoisted(() => ({
  engine: {
    syncOneWorkout: vi.fn(async (_deps: unknown, _opts: unknown) => ({ status: "dry_run" })),
    listCandidates: vi.fn(async (_deps: unknown) => [] as unknown[]),
    garminGateway: vi.fn((client: unknown) => ({ client, kind: "gateway" })),
  },
  ps: { isSynced: vi.fn(async (_id: string, _sql: unknown) => false) },
  getGarminClient: vi.fn(async () => ({ name: "healed-client" }) as unknown as GarminClient),
  fetchAllWorkouts: vi.fn(async () => [{ id: "hevy-1" }] as unknown[]),
  syncWorkoutPhotos: vi.fn(async (_o: unknown) => ({ uploaded: 0, skipped: 0 })),
}));
vi.mock("hevy2garmin", async (importOriginal) => ({ ...(await importOriginal<object>()), ...h.engine }));
vi.mock("./pending-store", () => h.ps);
vi.mock("./db", () => ({ getDb: () => ({}) }));
vi.mock("./garmin-upload", () => ({ getGarminClient: () => h.getGarminClient() }));
vi.mock("./hevy-sync", () => ({ fetchAllWorkouts: () => h.fetchAllWorkouts() }));
vi.mock("./workout-photos", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  syncWorkoutPhotos: (o: unknown) => h.syncWorkoutPhotos(o),
}));

import { syncOneWorkout, listCandidates, buildSyncDeps } from "./sync-one";

type Deps = ReturnType<typeof buildSyncDeps>;

/**
 * A tagged-template `sql` that answers the settings reads.
 *
 * The shim loads the user's settings before every sync now, so a plain object
 * is no longer a usable stand-in for the connection.
 */
function makeSql(rows: Record<string, unknown> = {}) {
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    const key = String(values[0] ?? "");
    let result: unknown[] = [];
    if (text.includes("app_cache") && key in rows) result = [{ value: rows[key] }];
    const p = Promise.resolve(result);
    return Object.assign(p, { catch: p.catch.bind(p) });
  }) as never as ReturnType<typeof import("./db").getDb>;
  return fn;
}
const SQL = makeSql() as never;
const lastDeps = () => h.engine.syncOneWorkout.mock.calls.at(-1)![0] as Deps;

beforeEach(() => {
  h.engine.syncOneWorkout.mockClear();
  h.engine.listCandidates.mockClear();
  h.engine.garminGateway.mockClear();
  h.getGarminClient.mockClear();
  h.fetchAllWorkouts.mockClear();
  h.ps.isSynced.mockClear();
  h.syncWorkoutPhotos.mockClear();
});

describe("syncOneWorkout (route shim)", () => {
  it("pads the Garmin adapter's date listing for the engine's merge lookup", async () => {
    const list = vi.fn(async () => []);
    h.engine.garminGateway.mockReturnValueOnce(Object.assign({ client: {}, kind: "gateway" }, { activitiesByDate: list }));
    const gateway = await buildSyncDeps(SQL).gateway();
    await gateway.activitiesByDate("2026-06-15", "2026-06-15");
    expect(list).toHaveBeenCalledWith("2026-06-14", "2026-06-16");
  });
  it("never injects a dryRun, and passes the caller's options through", async () => {
    await syncOneWorkout(SQL);
    expect(h.engine.syncOneWorkout).toHaveBeenCalledTimes(1);
    expect(h.engine.syncOneWorkout.mock.calls[0][1]).not.toHaveProperty("dryRun");
    await syncOneWorkout(SQL, { dryRun: false, targetHevyId: "hevy-1" });
    expect(h.engine.syncOneWorkout.mock.calls[1][1]).toMatchObject({
      dryRun: false,
      targetHevyId: "hevy-1",
    });
  });

  it("carries the saved merge and HR settings to the engine, which is the whole point", async () => {
    const sql = makeSql({
      merge_settings: {
        merge_mode: true,
        merge_watch_strategy: "replace",
        merge_activity_types: ["strength_training", "indoor_cardio"],
        merge_overlap_pct: 85,
        merge_max_drift_min: 12,
      },
      hr_fusion: { enabled: false },
    }) as never;
    await syncOneWorkout(sql, { dryRun: false });
    expect(h.engine.syncOneWorkout.mock.calls[0][1]).toMatchObject({
      hrFusion: false,
      merge: {
        enabled: true,
        watchStrategy: "replace",
        activityTypes: ["strength_training", "indoor_cardio"],
        overlapThreshold: 0.85,
        maxDriftMinutes: 12,
      },
    });
  });

  it("an explicit option still beats the saved setting", async () => {
    const sql = makeSql({ hr_fusion: { enabled: true } }) as never;
    await syncOneWorkout(sql, { dryRun: true, hrFusion: false });
    expect(h.engine.syncOneWorkout.mock.calls[0][1]).toMatchObject({ hrFusion: false });
  });

  it("binds the store to the route's sql", async () => {
    await syncOneWorkout(SQL);
    await lastDeps().store.isSynced("w1");
    expect(h.ps.isSynced).toHaveBeenCalledWith("w1", SQL);
  });

  it("the Hevy fetch is the app's fetchAllWorkouts", async () => {
    await syncOneWorkout(SQL);
    expect(await lastDeps().fetchWorkouts()).toEqual([{ id: "hevy-1" }]);
    expect(h.fetchAllWorkouts).toHaveBeenCalledTimes(1);
  });

  it("the Garmin gateway is LAZY and built once from the healed client", async () => {
    await syncOneWorkout(SQL);
    expect(h.getGarminClient).not.toHaveBeenCalled(); // nothing logged in yet
    const deps = lastDeps();
    const [g1, g2] = await Promise.all([deps.gateway(), deps.gateway()]);
    expect(h.getGarminClient).toHaveBeenCalledTimes(1);
    expect(h.engine.garminGateway).toHaveBeenCalledWith({ name: "healed-client" });
    expect(g1).toBe(g2);
  });

  it("test seams: fetchWorkouts and garminClientFactory override the defaults and are NOT forwarded", async () => {
    const fetchWorkouts = vi.fn(async () => []);
    const garminClientFactory = vi.fn(async () => ({ name: "injected" }) as unknown as GarminClient);
    await syncOneWorkout(SQL, { dryRun: true, fetchWorkouts, garminClientFactory });
    const deps = lastDeps();
    await deps.fetchWorkouts();
    await deps.gateway();
    expect(fetchWorkouts).toHaveBeenCalledTimes(1);
    expect(h.fetchAllWorkouts).not.toHaveBeenCalled();
    expect(garminClientFactory).toHaveBeenCalledTimes(1);
    expect(h.getGarminClient).not.toHaveBeenCalled();
    expect(h.engine.syncOneWorkout.mock.calls[0][1]).toMatchObject({ dryRun: true });
    expect(h.engine.syncOneWorkout.mock.calls[0][1]).not.toHaveProperty("fetchWorkouts");
    expect(h.engine.syncOneWorkout.mock.calls[0][1]).not.toHaveProperty("garminClientFactory");
  });
});

describe("listCandidates (route shim)", () => {
  it("forwards sql-bound deps to the engine", async () => {
    await listCandidates(SQL);
    expect(h.engine.listCandidates).toHaveBeenCalledTimes(1);
    const deps = h.engine.listCandidates.mock.calls[0][0] as Deps;
    await deps.store.isSynced("w9");
    expect(h.ps.isSynced).toHaveBeenCalledWith("w9", SQL);
  });
});

/**
 * The start date is applied in THIS app's fetch, before the engine sees the
 * list (#647), so every path that reads candidates honours it without being
 * told and the engine needs no release.
 *
 * Requested by a user whose whole Hevy back catalogue showed as pending,
 * because he had entered those sessions into Garmin by hand before finding the
 * tool.
 */
describe("sync start date", () => {
  const OLD = { id: "old", title: "Before he installed it", start_time: "2025-06-01T10:00:00Z" };
  const NEW = { id: "new", title: "After", start_time: "2026-09-15T18:00:00Z" };

  async function fetchWith(startDate: string | null) {
    const sql = makeSql(startDate ? { sync_window: { start_date: startDate } } : {}) as never;
    const deps = buildSyncDeps(sql, { fetchWorkouts: async () => [OLD, NEW] as never });
    return (await deps.fetchWorkouts()) as Array<{ id: string }>;
  }

  it("hides workouts from before the date", async () => {
    expect((await fetchWith("2026-09-01")).map((w) => w.id)).toEqual(["new"]);
  });

  it("keeps everything when no date is set", async () => {
    expect((await fetchWith(null)).map((w) => w.id)).toEqual(["old", "new"]);
  });

  it("does not limit a resync, whose workout is synced and may be older than the date", async () => {
    const sql = makeSql({ sync_window: { start_date: "2026-09-01" } }) as never;
    const deps = buildSyncDeps(sql, { fetchWorkouts: async () => [OLD] as never, targetActivityId: 4242 });
    expect(((await deps.fetchWorkouts()) as Array<{ id: string }>).map((w) => w.id)).toEqual(["old"]);
  });

  it("keeps everything when the stored value is not a date", async () => {
    // A bad value must never mean "hide everything": the user would see an
    // empty list with nothing to explain it.
    expect((await fetchWith("last tuesday")).map((w) => w.id)).toEqual(["old", "new"]);
  });
});

describe("workout photos (#237)", () => {
  const WORKOUT = { id: "hevy-1", title: "Push", media: [{ type: "image", url: "https://cdn.example/a.jpg" }] };
  const OTHER = { id: "hevy-2", title: "Pull", media: [] };
  const result = (over: Record<string, unknown> = {}) => ({
    status: "synced",
    dryRun: false,
    garminActivityId: 777,
    workout: { hevy_id: "hevy-1", title: "Push", start_time: null },
    syncMethod: "upload",
    error: null,
    ...over,
  });
  /** The engine fetches the workouts, then answers `r`, as the real one does. */
  const engineAnswers = (r: unknown) =>
    h.engine.syncOneWorkout.mockImplementationOnce(async (deps: unknown) => {
      await (deps as Deps).fetchWorkouts();
      return r as never;
    });
  const photoCall = () => h.syncWorkoutPhotos.mock.calls[0]![0] as {
    sql: unknown;
    hevyId: string;
    activityId: number;
    workout: unknown;
    client: () => Promise<GarminClient>;
  };

  beforeEach(() => {
    h.fetchAllWorkouts.mockResolvedValue([OTHER, WORKOUT]);
  });

  it.each([
    ["a fresh upload, or replace's named upload", { syncMethod: "upload" }, {}],
    ["a match or upload_fallback", { syncMethod: "match" }, {}],
    ["a merge into the watch activity", { syncMethod: "merge" }, {}],
    ["a Resync", { syncMethod: "merge" }, { targetHevyId: "hevy-1", targetActivityId: 777 }],
  ])("%s: the workout's photos go to its activity", async (_name, over, options) => {
    engineAnswers(result(over));
    await syncOneWorkout(SQL, { dryRun: false, ...options });
    expect(h.syncWorkoutPhotos).toHaveBeenCalledTimes(1);
    expect(photoCall()).toMatchObject({ sql: SQL, hevyId: "hevy-1", activityId: 777, workout: WORKOUT });
  });

  it.each([
    ["a dry run", { status: "dry_run", dryRun: true, garminActivityId: null }],
    ["merge_pending", { status: "merge_pending", garminActivityId: null }],
    ["deferred", { status: "deferred", garminActivityId: null }],
    ["failed", { status: "failed", garminActivityId: null }],
    ["an error", { status: "error", garminActivityId: null, error: "boom" }],
  ])("%s: no photos", async (_name, over) => {
    engineAnswers(result(over));
    await syncOneWorkout(SQL, { dryRun: false });
    expect(h.syncWorkoutPhotos).not.toHaveBeenCalled();
  });

  it("the setting off: no photos", async () => {
    engineAnswers(result());
    await syncOneWorkout(makeSql({ workout_photos: { enabled: false } }) as never, { dryRun: false });
    expect(h.syncWorkoutPhotos).not.toHaveBeenCalled();
  });

  it("returns the engine's result as it was", async () => {
    const r = result();
    engineAnswers(r);
    expect(await syncOneWorkout(SQL, { dryRun: false })).toBe(r);
  });

  it("uses the sync's own Garmin client, so the photos need no second login", async () => {
    h.engine.syncOneWorkout.mockImplementationOnce(async (deps: unknown) => {
      await (deps as Deps).fetchWorkouts();
      await (deps as Deps).gateway();
      return result() as never;
    });
    await syncOneWorkout(SQL, { dryRun: false });
    expect(await photoCall().client()).toEqual({ name: "healed-client" });
    expect(h.getGarminClient).toHaveBeenCalledTimes(1);
  });

  it("a workout the sync did not fetch: no photos", async () => {
    engineAnswers(result({ workout: { hevy_id: "hevy-9", title: null, start_time: null } }));
    await syncOneWorkout(SQL, { dryRun: false });
    expect(h.syncWorkoutPhotos).not.toHaveBeenCalled();
  });

  it("a photo step that throws still leaves the sync a success, and says why", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      h.syncWorkoutPhotos.mockRejectedValueOnce(new Error("unexpected"));
      const r = result();
      engineAnswers(r);
      expect(await syncOneWorkout(SQL, { dryRun: false })).toBe(r);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/\[photos\] workout hevy-1.*unexpected/);
    } finally {
      warn.mockRestore();
    }
  });
});
