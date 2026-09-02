import { describe, it, expect, beforeAll } from "vitest";
import { createHmac } from "node:crypto";
import { signSession, verifySession, checkPassword } from "./auth";

/** Build a valid legacy v1 cookie the way the pre-epoch app signed them. */
function makeV1Cookie(secret: string, ts: number): string {
  const sig = createHmac("sha256", secret).update(`v1.${ts}`).digest("hex").slice(0, 32);
  return `v1.${ts}.${sig}`;
}

// A fixed secret so signatures are deterministic across the test.
beforeAll(() => {
  process.env.HEVY2GARMIN_SECRET = "test-secret-abc";
  delete process.env.H2G_PASSWORD;
});

describe("signSession / verifySession — v2 + epoch", () => {
  it("round-trips a v2 cookie at the same epoch", async () => {
    const c = await signSession(3);
    expect(c.startsWith("v2.")).toBe(true);
    expect(await verifySession(c, 3)).toBe(true);
  });

  it("rejects a v2 cookie whose epoch no longer matches (revoked)", async () => {
    const c = await signSession(3);
    expect(await verifySession(c, 4)).toBe(false); // epoch bumped → revoked
    expect(await verifySession(c, 2)).toBe(false);
  });

  it("defaults to epoch 0", async () => {
    const c = await signSession(); // epoch 0
    expect(await verifySession(c, 0)).toBe(true);
    expect(await verifySession(c, 1)).toBe(false);
  });

  it("rejects a tampered signature", async () => {
    const c = await signSession(0);
    const bad = c.slice(0, -1) + (c.endsWith("0") ? "1" : "0");
    expect(await verifySession(bad, 0)).toBe(false);
  });

  it("rejects an expired cookie", async () => {
    const old = Math.floor(Date.now() / 1000) - 40 * 24 * 3600; // 40 days ago > 30d TTL
    const c = await signSession(0, old);
    expect(await verifySession(c, 0)).toBe(false);
  });

  it("rejects a future-dated cookie beyond clock skew", async () => {
    const future = Math.floor(Date.now() / 1000) + 3600; // 1h ahead > 5m skew
    const c = await signSession(0, future);
    expect(await verifySession(c, 0)).toBe(false);
  });
});

describe("verifySession — legacy v1 backward-compat", () => {
  // A v1 cookie is v1.<ts>.<sig(v1.<ts>)>. Recreate the exact shape by hand is
  // hard without the internal hmac; instead assert the acceptance RULES on the
  // format via a known property: v1 is treated as epoch 0.
  it("null / malformed cookies are rejected", async () => {
    expect(await verifySession(null, 0)).toBe(false);
    expect(await verifySession("", 0)).toBe(false);
    expect(await verifySession("garbage", 0)).toBe(false);
    expect(await verifySession("v3.1.2.deadbeef", 0)).toBe(false);
  });

  it("a REAL valid v1 cookie still verifies at epoch 0 (no force-logout on upgrade)", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const v1 = makeV1Cookie("test-secret-abc", ts);
    expect(await verifySession(v1, 0)).toBe(true);
  });

  it("a valid v1 cookie is revoked once the epoch is bumped (>0)", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const v1 = makeV1Cookie("test-secret-abc", ts);
    expect(await verifySession(v1, 1)).toBe(false); // "sign out everywhere" revokes v1 too
  });

  it("a wrongly-signed v1 cookie is rejected", async () => {
    const ts = Math.floor(Date.now() / 1000);
    expect(await verifySession(`v1.${ts}.${"0".repeat(32)}`, 0)).toBe(false);
  });
});

describe("checkPassword", () => {
  it("compares against H2G_PASSWORD constant-time", () => {
    process.env.H2G_PASSWORD = "hunter2xx";
    expect(checkPassword("hunter2xx")).toBe(true);
    expect(checkPassword("hunter2xy")).toBe(false);
    expect(checkPassword("short")).toBe(false);
    delete process.env.H2G_PASSWORD;
  });
});
