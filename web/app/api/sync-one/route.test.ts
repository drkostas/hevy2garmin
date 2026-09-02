import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Safety-gating tests for POST /api/sync-one.
 *
 * The route's whole reason to exist is that a live Garmin upload must fire ONLY
 * when the caller both (a) explicitly asks for it and (b) is authorized —
 * otherwise it runs the engine in dry-run. We mock the engine + auth + cookies
 * so no network or DB is touched, and assert exactly which (dryRun) the engine
 * is invoked with (or that it is never invoked).
 */

const syncOneWorkout = vi.fn();
vi.mock("@/lib/sync-one", () => ({
  syncOneWorkout: (...a: unknown[]) => syncOneWorkout(...a),
}));

vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));

const authEnabled = vi.fn();
const verifySession = vi.fn();
vi.mock("@/lib/auth", () => ({
  authEnabled: (...a: unknown[]) => authEnabled(...a),
  verifySession: (...a: unknown[]) => verifySession(...a),
  SESSION_COOKIE: "h2g_session",
}));

const cookieGet = vi.fn();
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (...a: unknown[]) => cookieGet(...a) }),
}));

import { POST } from "./route";

const DRY = {
  status: "dry_run",
  dryRun: true,
  wouldUpload: true,
  dedupDecision: "would_upload",
  remaining: 3,
};
const LIVE = {
  status: "synced",
  dryRun: false,
  garminActivityId: 555,
  dedupDecision: "would_upload",
  remaining: 2,
};

function req(
  url: string,
  body: unknown = {},
  headers: Record<string, string> = {},
): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CRON_SECRET;
  syncOneWorkout.mockResolvedValue(DRY);
  authEnabled.mockReturnValue(true);
  verifySession.mockReturnValue(false);
  cookieGet.mockReturnValue(undefined);
});

describe("POST /api/sync-one — dry-run / auth gating", () => {
  it("no live requested → dry-run (engine called with dryRun:true)", async () => {
    const res = await POST(req("http://h/api/sync-one", {}));
    expect(res.status).toBe(200);
    expect(syncOneWorkout).toHaveBeenCalledWith(expect.anything(), { dryRun: true });
  });

  it("live requested but NOT authorized → 401, engine never called", async () => {
    const res = await POST(req("http://h/api/sync-one", { live: 1 }));
    expect(res.status).toBe(401);
    expect(syncOneWorkout).not.toHaveBeenCalled();
  });

  it("live + valid session → live run (engine called with dryRun:false)", async () => {
    cookieGet.mockReturnValue({ value: "cookie" });
    verifySession.mockReturnValue(true);
    syncOneWorkout.mockResolvedValue(LIVE);
    const res = await POST(req("http://h/api/sync-one", { live: true }));
    expect(res.status).toBe(200);
    expect(syncOneWorkout).toHaveBeenCalledWith(expect.anything(), { dryRun: false });
  });

  it("live + auth DISABLED (no password configured) → authorized → live run", async () => {
    authEnabled.mockReturnValue(false);
    syncOneWorkout.mockResolvedValue(LIVE);
    const res = await POST(req("http://h/api/sync-one?live=1", {}));
    expect(res.status).toBe(200);
    expect(syncOneWorkout).toHaveBeenCalledWith(expect.anything(), { dryRun: false });
  });

  it("live via CRON_SECRET bearer token → live run", async () => {
    process.env.CRON_SECRET = "s3cret";
    const res = await POST(
      req("http://h/api/sync-one", { live: 1 }, { authorization: "Bearer s3cret" }),
    );
    expect(res.status).toBe(200);
    expect(syncOneWorkout).toHaveBeenCalledWith(expect.anything(), { dryRun: false });
  });

  it("live with a WRONG CRON_SECRET and no session → 401, engine never called", async () => {
    process.env.CRON_SECRET = "s3cret";
    const res = await POST(
      req("http://h/api/sync-one", { live: 1 }, { authorization: "Bearer nope" }),
    );
    expect(res.status).toBe(401);
    expect(syncOneWorkout).not.toHaveBeenCalled();
  });

  it("invalid JSON body → 400, engine never called", async () => {
    const bad = new Request("http://h/api/sync-one", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const res = await POST(bad);
    expect(res.status).toBe(400);
    expect(syncOneWorkout).not.toHaveBeenCalled();
  });
});
