import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GarminClient } from "garmin-auth";

/**
 * The engine (dedup layers, dry-run default, claim→upload→finalize) is tested
 * in the hevy2garmin package. These tests cover THIS app's wiring of it: the
 * store is bound to the route's `sql`, the Garmin client is built lazily and
 * once, the Hevy fetch is the app's, and options reach the engine untouched.
 */
const h = vi.hoisted(() => ({
  engine: {
    syncOneWorkout: vi.fn(async (_deps: unknown, _opts: unknown) => ({ status: "dry_run" })),
    listCandidates: vi.fn(async (_deps: unknown) => [] as unknown[]),
    garminGateway: vi.fn((client: unknown) => ({ client, kind: "gateway" })),
  },
  ps: { isSynced: vi.fn(async (_id: string, _sql: unknown) => false) },
  getGarminClient: vi.fn(async () => ({ name: "healed-client" }) as unknown as GarminClient),
  fetchAllWorkouts: vi.fn(async () => [{ id: "hevy-1" }]),
}));
vi.mock("hevy2garmin", async (importOriginal) => ({ ...(await importOriginal<object>()), ...h.engine }));
vi.mock("./pending-store", () => h.ps);
vi.mock("./db", () => ({ getDb: () => ({}) }));
vi.mock("./garmin-upload", () => ({ getGarminClient: () => h.getGarminClient() }));
vi.mock("./hevy-sync", () => ({ fetchAllWorkouts: () => h.fetchAllWorkouts() }));

import { syncOneWorkout, listCandidates, type buildSyncDeps } from "./sync-one";

type Deps = ReturnType<typeof buildSyncDeps>;
const SQL = { tag: "sql" } as never;
const lastDeps = () => h.engine.syncOneWorkout.mock.calls.at(-1)![0] as Deps;

beforeEach(() => {
  h.engine.syncOneWorkout.mockClear();
  h.engine.listCandidates.mockClear();
  h.engine.garminGateway.mockClear();
  h.getGarminClient.mockClear();
  h.fetchAllWorkouts.mockClear();
  h.ps.isSynced.mockClear();
});

describe("syncOneWorkout (route shim)", () => {
  it("forwards options to the engine untouched — no dryRun is injected", async () => {
    await syncOneWorkout(SQL);
    expect(h.engine.syncOneWorkout).toHaveBeenCalledTimes(1);
    expect(h.engine.syncOneWorkout.mock.calls[0][1]).toEqual({});
    await syncOneWorkout(SQL, { dryRun: false, targetHevyId: "hevy-1", descriptionEnabled: false });
    expect(h.engine.syncOneWorkout.mock.calls[1][1]).toEqual({ dryRun: false, targetHevyId: "hevy-1", descriptionEnabled: false });
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
    expect(h.engine.syncOneWorkout.mock.calls[0][1]).toEqual({ dryRun: true });
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
