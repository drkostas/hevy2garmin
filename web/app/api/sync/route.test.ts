import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Safety + behaviour tests for POST /api/sync (batch).
 *
 * The engine, auth, cookies and (for the dispatch path) global fetch are all
 * mocked, so no network/DB/Garmin is touched. We assert the dry-run/auth gate,
 * the GitHub-Actions dispatch path, and the inline loop's aggregation + cap.
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

function req(url: string, body: unknown = {}, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const DRY = { status: "dry_run", dryRun: true, remaining: 4, wouldUpload: true, dedupDecision: "would_upload" };

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CRON_SECRET;
  delete process.env.GITHUB_PAT;
  delete process.env.GITHUB_REPO;
  authEnabled.mockReturnValue(true);
  verifySession.mockReturnValue(false);
  cookieGet.mockReturnValue(undefined);
  syncOneWorkout.mockResolvedValue(DRY);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/sync — batch", () => {
  it("no live → dry-run preview with the candidate count", async () => {
    const res = await POST(req("http://h/api/sync", {}));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.dryRun).toBe(true);
    expect(json.mode).toBe("preview");
    expect(json.candidates).toBe(4);
    expect(syncOneWorkout).toHaveBeenCalledWith(expect.anything(), { dryRun: true });
  });

  it("live but unauthorized → 401, engine never called", async () => {
    const res = await POST(req("http://h/api/sync", { live: 1 }));
    expect(res.status).toBe(401);
    expect(syncOneWorkout).not.toHaveBeenCalled();
  });

  it("live + authorized + GITHUB_PAT/REPO → dispatches to Actions, no engine loop", async () => {
    authEnabled.mockReturnValue(false); // authorized
    process.env.GITHUB_PAT = "pat";
    process.env.GITHUB_REPO = "drkostas/hevy2garmin";
    const fetchMock = vi.fn(async (..._a: unknown[]) => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req("http://h/api/sync?live=1", {}));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.mode).toBe("dispatch");
    expect(json.triggered).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/repos/drkostas/hevy2garmin/dispatches");
    expect(syncOneWorkout).not.toHaveBeenCalled();
  });

  it("live + authorized + no PAT → inline loop until 'none', aggregates", async () => {
    authEnabled.mockReturnValue(false); // authorized
    syncOneWorkout
      .mockResolvedValueOnce({ status: "synced", remaining: 1 })
      .mockResolvedValueOnce({ status: "synced", remaining: 0 })
      .mockResolvedValueOnce({ status: "none", remaining: 0 });
    const res = await POST(req("http://h/api/sync?live=1", {}));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.mode).toBe("inline");
    expect(json.ran).toBe(2);
    expect(json.totalSynced).toBe(2);
    expect(syncOneWorkout).toHaveBeenCalledTimes(3); // 2 synced + the terminating 'none'
    expect(syncOneWorkout).toHaveBeenCalledWith(expect.anything(), { dryRun: false });
  });

  it("inline loop stops on a hard error", async () => {
    authEnabled.mockReturnValue(false);
    syncOneWorkout
      .mockResolvedValueOnce({ status: "synced", remaining: 2 })
      .mockResolvedValueOnce({ status: "error", remaining: 1, error: "boom" });
    const res = await POST(req("http://h/api/sync?live=1", {}));
    const json = await res.json();
    expect(json.mode).toBe("inline");
    expect(json.totalSynced).toBe(1);
    expect(json.totalError).toBe(1);
    expect(syncOneWorkout).toHaveBeenCalledTimes(2); // stopped after the error
  });

  it("invalid JSON → 400", async () => {
    const bad = new Request("http://h/api/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{nope",
    });
    const res = await POST(bad);
    expect(res.status).toBe(400);
    expect(syncOneWorkout).not.toHaveBeenCalled();
  });
});
