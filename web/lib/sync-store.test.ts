import { describe, it, expect, vi, beforeEach } from "vitest";

const ps = vi.hoisted(() => ({
  isSynced: vi.fn(async (_id: string, _sql: unknown) => true),
  loadSyncedIds: vi.fn(async (_sql: unknown) => new Set(["a"])),
  loadPendingIds: vi.fn(async (_sql: unknown) => new Set(["b"])),
  getPending: vi.fn(async (_id: string, _sql: unknown) => null),
  claimPending: vi.fn(async (_id: string, _payload: unknown, _sql: unknown) => true),
  updatePending: vi.fn(async (_id: string, _fields: unknown, _sql: unknown) => {}),
  deletePending: vi.fn(async (_id: string, _sql: unknown) => true),
  completePending: vi.fn(async (_id: string, _opts: unknown, _sql: unknown) => {}),
  markSynced: vi.fn(async (_id: string, _opts: unknown, _sql: unknown) => {}),
}));
vi.mock("./pending-store", () => ps);
vi.mock("./db", () => ({ getDb: () => ({}) }));

import { postgresSyncStore } from "./sync-store";

/** Every SyncStore method must reach its pending-store twin with `sql` LAST. */
const SQL = { tag: "the-sql-connection" } as never;

beforeEach(() => Object.values(ps).forEach((f) => f.mockClear()));

describe("postgresSyncStore binds the engine's SyncStore to pending-store for one connection", () => {
  const store = postgresSyncStore(SQL);

  it("isSynced", async () => {
    expect(await store.isSynced("w1")).toBe(true);
    expect(ps.isSynced).toHaveBeenCalledWith("w1", SQL);
  });
  it("loadSyncedIds / loadPendingIds", async () => {
    expect(await store.loadSyncedIds()).toEqual(new Set(["a"]));
    expect(await store.loadPendingIds()).toEqual(new Set(["b"]));
    expect(ps.loadSyncedIds).toHaveBeenCalledWith(SQL);
    expect(ps.loadPendingIds).toHaveBeenCalledWith(SQL);
  });
  it("getPending", async () => {
    await store.getPending("w1");
    expect(ps.getPending).toHaveBeenCalledWith("w1", SQL);
  });
  it("claimPending passes the payload through", async () => {
    const payload = { workout: { id: "w1" } };
    expect(await store.claimPending("w1", payload)).toBe(true);
    expect(ps.claimPending).toHaveBeenCalledWith("w1", payload, SQL);
  });
  it("updatePending passes the fields through", async () => {
    await store.updatePending("w1", { phase: "processing", last_error: "x" });
    expect(ps.updatePending).toHaveBeenCalledWith("w1", { phase: "processing", last_error: "x" }, SQL);
  });
  it("deletePending", async () => {
    expect(await store.deletePending("w1")).toBe(true);
    expect(ps.deletePending).toHaveBeenCalledWith("w1", SQL);
  });
  it("completePending / markSynced pass the opts through", async () => {
    const opts = { garminActivityId: "555", title: "Push Day", syncMethod: "upload" };
    await store.completePending("w1", opts);
    await store.markSynced("w2", opts);
    expect(ps.completePending).toHaveBeenCalledWith("w1", opts, SQL);
    expect(ps.markSynced).toHaveBeenCalledWith("w2", opts, SQL);
  });
  it("exposes exactly the SyncStore surface (bookkeeping only, no Garmin/Hevy)", () => {
    expect(Object.keys(store).sort()).toEqual([
      "claimPending", "completePending", "deletePending", "getPending", "isSynced",
      "loadPendingIds", "loadSyncedIds", "markSynced", "updatePending",
    ]);
  });
});
