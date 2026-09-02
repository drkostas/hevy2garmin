import { describe, it, expect, vi, beforeEach } from "vitest";

const bumpSessionEpoch = vi.fn();
vi.mock("@/lib/session-epoch", () => ({ bumpSessionEpoch: (...a: unknown[]) => bumpSessionEpoch(...a) }));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "h2g_session" }));

import { POST } from "./route";

beforeEach(() => vi.clearAllMocks());

describe("POST /api/logout-all", () => {
  it("bumps the epoch and clears the cookie", async () => {
    bumpSessionEpoch.mockResolvedValue(4);
    const res = await POST();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, epoch: 4 });
    // Cleared cookie: Max-Age=0.
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("h2g_session=");
    expect(setCookie.toLowerCase()).toContain("max-age=0");
  });

  it("surfaces a 500 when the bump fails (revocation did NOT happen)", async () => {
    bumpSessionEpoch.mockRejectedValue(new Error("db down"));
    const res = await POST();
    expect(res.status).toBe(500);
    expect((await res.json()).ok).toBe(false);
  });
});
