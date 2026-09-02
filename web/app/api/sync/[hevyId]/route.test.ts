import { describe, it, expect, vi, beforeEach } from "vitest";

/** Gating + targetHevyId passthrough for POST /api/sync/[hevyId]. */

const syncOneWorkout = vi.fn();
vi.mock("@/lib/sync-one", () => ({ syncOneWorkout: (...a: unknown[]) => syncOneWorkout(...a) }));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));

const authEnabled = vi.fn();
const verifySession = vi.fn();
vi.mock("@/lib/auth", () => ({
  authEnabled: (...a: unknown[]) => authEnabled(...a),
  verifySession: (...a: unknown[]) => verifySession(...a),
  SESSION_COOKIE: "h2g_session",
}));
const cookieGet = vi.fn();
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (...a: unknown[]) => cookieGet(...a) }) }));

import { POST } from "./route";

const params = (id: string) => ({ params: Promise.resolve({ hevyId: id }) });
function req(url: string, body: unknown = {}): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CRON_SECRET;
  authEnabled.mockReturnValue(true);
  verifySession.mockReturnValue(false);
  cookieGet.mockReturnValue(undefined);
  syncOneWorkout.mockResolvedValue({ status: "dry_run", dryRun: true, dedupDecision: "would_upload" });
});

describe("POST /api/sync/[hevyId]", () => {
  it("no live → dry-run for the TARGET workout", async () => {
    const res = await POST(req("http://h/api/sync/w9", {}), params("w9"));
    expect(res.status).toBe(200);
    expect(syncOneWorkout).toHaveBeenCalledWith(expect.anything(), {
      dryRun: true,
      targetHevyId: "w9",
    });
  });

  it("live but unauthorized → 401, engine not called", async () => {
    const res = await POST(req("http://h/api/sync/w9", { live: 1 }), params("w9"));
    expect(res.status).toBe(401);
    expect(syncOneWorkout).not.toHaveBeenCalled();
  });

  it("live + session → live sync of the target", async () => {
    cookieGet.mockReturnValue({ value: "c" });
    verifySession.mockReturnValue(true);
    syncOneWorkout.mockResolvedValue({ status: "synced", dryRun: false, garminActivityId: 5 });
    const res = await POST(req("http://h/api/sync/w9?live=1", {}), params("w9"));
    expect(res.status).toBe(200);
    expect(syncOneWorkout).toHaveBeenCalledWith(expect.anything(), {
      dryRun: false,
      targetHevyId: "w9",
    });
  });

  it("invalid JSON → 400", async () => {
    const bad = new Request("http://h/api/sync/w9", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{no",
    });
    const res = await POST(bad, params("w9"));
    expect(res.status).toBe(400);
  });
});
