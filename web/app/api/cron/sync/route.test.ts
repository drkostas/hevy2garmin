import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const syncOneWorkout = vi.fn();
vi.mock("@/lib/sync-one", () => ({ syncOneWorkout: (...a: unknown[]) => syncOneWorkout(...a) }));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
// The cron run now takes the sync lock, so a scheduled tick and a user
// pressing Sync cannot walk the same backlog at once (#604). Stubbed to
// "nothing in the way" here.
vi.mock("@/lib/sync-lock-store", () => ({ postgresLockBackend: () => ({}) }));
vi.mock("hevy2garmin", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  acquireSyncLock: async () => ({ key: "sync", token: "t", release: async () => {} }),
}));
const profiles = vi.hoisted(() => ({ list: [{ id: "default", name: "Default profile" }] }));
vi.mock("@/lib/profiles", () => ({ listProfiles: async () => profiles.list }));
const hevyKeys = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/hevy-sync", async () => {
  const { activeProfileId } = await import("@/lib/profile-context");
  return { resolveHevyKey: async () => hevyKeys.get(await activeProfileId()) ?? null };
});
import { activeProfileId } from "@/lib/profile-context";

import { GET } from "./route";

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://h/api/cron/sync", { method: "GET", headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  syncOneWorkout.mockReset();
  profiles.list = [{ id: "default", name: "Default profile" }];
  hevyKeys.clear();
  delete process.env.CRON_SECRET;
  delete process.env.GITHUB_PAT;
  delete process.env.GITHUB_REPO;
});
afterEach(() => vi.unstubAllGlobals());

describe("GET /api/cron/sync", () => {
  it("no CRON_SECRET configured → 401", async () => {
    const res = await GET(req({ authorization: "Bearer whatever" }));
    expect(res.status).toBe(401);
    expect(syncOneWorkout).not.toHaveBeenCalled();
  });

  it("wrong Bearer → 401", async () => {
    process.env.CRON_SECRET = "s3cret";
    const res = await GET(req({ authorization: "Bearer nope" }));
    expect(res.status).toBe(401);
  });

  it("correct Bearer + GITHUB_PAT/REPO → dispatches, no engine loop", async () => {
    process.env.CRON_SECRET = "s3cret";
    process.env.GITHUB_PAT = "pat";
    process.env.GITHUB_REPO = "drkostas/hevy2garmin";
    const fetchMock = vi.fn(async (..._a: unknown[]) => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await GET(req({ authorization: "Bearer s3cret" }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.mode).toBe("dispatch");
    expect(json.triggered).toBe(true);
    expect(syncOneWorkout).not.toHaveBeenCalled();
  });

  it("correct Bearer + no PAT → inline loop until none, counts synced", async () => {
    process.env.CRON_SECRET = "s3cret";
    syncOneWorkout
      .mockResolvedValueOnce({ status: "synced" })
      .mockResolvedValueOnce({ status: "skipped" })
      .mockResolvedValueOnce({ status: "none" });
    const res = await GET(req({ authorization: "Bearer s3cret" }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.mode).toBe("inline");
    expect(json.ran).toBe(2);
    expect(json.synced).toBe(1);
    // Unattended, so it waits out the grace period rather than beating the
    // watch's own activity to Garmin.
    expect(syncOneWorkout).toHaveBeenCalledWith(expect.anything(), { dryRun: false, respectGrace: true });
  });

  it("stops when a deferred workout comes back, instead of repeating it up to the cap", async () => {
    process.env.CRON_SECRET = "s3cret";
    // Inside the grace period the engine defers the newest workout and picks it again next call.
    const deferred = { status: "deferred", workout: { hevy_id: "w-new" } };
    syncOneWorkout.mockResolvedValue(deferred);
    const res = await GET(req({ authorization: "Bearer s3cret" }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ran).toBe(1);
    expect(syncOneWorkout).toHaveBeenCalledTimes(2);
  });

  it("keeps going while each call hands back a different workout", async () => {
    process.env.CRON_SECRET = "s3cret";
    syncOneWorkout
      .mockResolvedValueOnce({ status: "synced", workout: { hevy_id: "a" } })
      .mockResolvedValueOnce({ status: "failed", workout: { hevy_id: "b" } })
      .mockResolvedValueOnce({ status: "synced", workout: { hevy_id: "c" } })
      .mockResolvedValueOnce({ status: "none" });
    const json = await (await GET(req({ authorization: "Bearer s3cret" }))).json();
    expect(json.ran).toBe(3);
    expect(json.synced).toBe(2);
  });

  describe("with several profiles", () => {
    const second = { id: "9b1b9af0-ddc8-4e4b-8209-4d436f93bb0e", name: "Second person" };

    beforeEach(() => {
      process.env.CRON_SECRET = "s3cret";
      profiles.list = [{ id: "default", name: "Me" }, second];
      hevyKeys.set(second.id, "second-key");
    });

    it("runs each profile's backlog under that profile and reports each one", async () => {
      const seen: string[] = [];
      syncOneWorkout.mockImplementation(async () => {
        const id = await activeProfileId();
        seen.push(id);
        return seen.filter((s) => s === id).length === 1 ? { status: "synced", workout: { hevy_id: id } } : { status: "none" };
      });
      const res = await GET(req({ authorization: "Bearer s3cret" }));
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(seen).toEqual(["default", "default", second.id, second.id]);
      expect(json).toMatchObject({ ok: true, mode: "inline", ran: 2, synced: 2 });
      expect(json.profiles.map((p: { name: string; kind: string }) => [p.name, p.kind])).toEqual([["Me", "ran"], ["Second person", "ran"]]);
    });

    it("still syncs the second profile when the first one fails", async () => {
      syncOneWorkout.mockImplementation(async () => {
        if ((await activeProfileId()) === "default") throw new Error("Reconnect Garmin");
        return { status: "none" };
      });
      const res = await GET(req({ authorization: "Bearer s3cret" }));
      const json = await res.json();
      expect(res.status).toBe(500);
      expect(json.ok).toBe(false);
      expect(json.profiles[0]).toMatchObject({ kind: "error", error: "Reconnect Garmin" });
      expect(json.profiles[1]).toMatchObject({ kind: "ran", ran: 0 });
    });

    it("skips an added profile that has not connected Hevy yet", async () => {
      hevyKeys.clear();
      syncOneWorkout.mockResolvedValue({ status: "none" });
      const json = await (await GET(req({ authorization: "Bearer s3cret" }))).json();
      expect(json.ok).toBe(true);
      expect(json.profiles[1]).toMatchObject({ kind: "skipped", reason: "Hevy is not connected" });
      expect(syncOneWorkout).toHaveBeenCalledTimes(1);
    });
  });
});
