import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const syncOneWorkout = vi.fn();
vi.mock("@/lib/sync-one", () => ({ syncOneWorkout: (...a: unknown[]) => syncOneWorkout(...a) }));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));

import { GET } from "./route";

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://h/api/cron/sync", { method: "GET", headers });
}

beforeEach(() => {
  vi.clearAllMocks();
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
    expect(syncOneWorkout).toHaveBeenCalledWith(expect.anything(), { dryRun: false });
  });
});
