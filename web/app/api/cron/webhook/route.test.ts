import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const syncOneWorkout = vi.fn();
vi.mock("@/lib/sync-one", () => ({ syncOneWorkout: (...a: unknown[]) => syncOneWorkout(...a) }));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));

import { POST } from "./route";

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://h/api/cron/webhook", { method: "POST", headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CRON_SECRET;
  delete process.env.GITHUB_PAT;
  delete process.env.GITHUB_REPO;
});
afterEach(() => vi.unstubAllGlobals());

describe("POST /api/cron/webhook", () => {
  it("CRON_SECRET unset → 503 (can't authenticate a webhook)", async () => {
    const res = await POST(req({ authorization: "Bearer x" }));
    expect(res.status).toBe(503);
    expect(syncOneWorkout).not.toHaveBeenCalled();
  });

  it("wrong Bearer → 401", async () => {
    process.env.CRON_SECRET = "s3cret";
    const res = await POST(req({ authorization: "Bearer nope" }));
    expect(res.status).toBe(401);
  });

  it("correct Bearer + GITHUB_PAT/REPO → dispatches", async () => {
    process.env.CRON_SECRET = "s3cret";
    process.env.GITHUB_PAT = "pat";
    process.env.GITHUB_REPO = "drkostas/hevy2garmin";
    vi.stubGlobal("fetch", vi.fn(async (..._a: unknown[]) => new Response(null, { status: 204 })));
    const res = await POST(req({ authorization: "Bearer s3cret" }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.mode).toBe("dispatch");
    expect(syncOneWorkout).not.toHaveBeenCalled();
  });

  it("correct Bearer + no PAT → inline sync", async () => {
    process.env.CRON_SECRET = "s3cret";
    syncOneWorkout.mockResolvedValue({ status: "synced" });
    const res = await POST(req({ authorization: "Bearer s3cret" }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.mode).toBe("inline");
    expect(syncOneWorkout).toHaveBeenCalledWith(expect.anything(), { dryRun: false });
  });
});
