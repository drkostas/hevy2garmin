import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  lockoutRemaining,
  recordFailure,
  clearFailures,
  formatCooldown,
} from "./login-ratelimit";

/**
 * In-memory app_cache stub with the sql tag shape lib/db exposes. Handles the
 * two statements the limiter uses: SELECT value ... WHERE key = $ and the
 * INSERT ... ON CONFLICT upsert. `json` is a passthrough.
 */
function fakeSql() {
  const store = new Map<string, unknown>();
  const tag = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join("?");
    if (q.startsWith("SELECT value FROM app_cache")) {
      const key = values[0] as string;
      return store.has(key) ? [{ value: store.get(key) }] : [];
    }
    if (q.includes("INSERT INTO app_cache")) {
      const key = values[0] as string;
      const value = values[1];
      store.set(key, value);
      return [];
    }
    throw new Error("unexpected query: " + q);
  }) as unknown as ReturnType<typeof import("./db").getDb>;
  (tag as unknown as { json: <T>(v: T) => T }).json = (v) => v;
  return { tag, store };
}

const IP = "1.2.3.4";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-31T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("login-ratelimit", () => {
  it("allows attempts until 5 failures, then locks out with backoff", async () => {
    const { tag } = fakeSql();
    expect(await lockoutRemaining(tag, IP)).toBe(0);
    for (let i = 0; i < 4; i++) await recordFailure(tag, IP);
    expect(await lockoutRemaining(tag, IP)).toBe(0); // 4 fails: still allowed
    await recordFailure(tag, IP); // 5th → first lockout (60s)
    const r = await lockoutRemaining(tag, IP);
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThanOrEqual(60);
  });

  it("backs off exponentially on repeated lockouts, capped at 15 min", async () => {
    const { tag } = fakeSql();
    for (let i = 0; i < 5; i++) await recordFailure(tag, IP); // 60s
    for (let i = 0; i < 5; i++) await recordFailure(tag, IP); // more fails → longer
    const r = await lockoutRemaining(tag, IP);
    expect(r).toBeGreaterThan(60);
    expect(r).toBeLessThanOrEqual(15 * 60);
  });

  it("clearFailures resets the counter", async () => {
    const { tag } = fakeSql();
    for (let i = 0; i < 5; i++) await recordFailure(tag, IP);
    expect(await lockoutRemaining(tag, IP)).toBeGreaterThan(0);
    await clearFailures(tag, IP);
    expect(await lockoutRemaining(tag, IP)).toBe(0);
  });

  it("the rolling window resets stale counters", async () => {
    const { tag } = fakeSql();
    for (let i = 0; i < 4; i++) await recordFailure(tag, IP);
    vi.setSystemTime(new Date("2026-08-31T12:20:00Z")); // 20 min later > 15 min window
    await recordFailure(tag, IP); // counts as the 1st in a fresh window
    expect(await lockoutRemaining(tag, IP)).toBe(0);
  });

  it("never throws when storage fails (best-effort)", async () => {
    const broken = (async () => {
      throw new Error("db down");
    }) as unknown as ReturnType<typeof import("./db").getDb>;
    (broken as unknown as { json: <T>(v: T) => T }).json = (v) => v;
    await expect(recordFailure(broken, IP)).resolves.toBeUndefined();
    expect(await lockoutRemaining(broken, IP)).toBe(0);
  });
});

describe("formatCooldown", () => {
  it("formats minutes and seconds", () => {
    expect(formatCooldown(0)).toBe("0 sec");
    expect(formatCooldown(45)).toBe("45 sec");
    expect(formatCooldown(60)).toBe("1 min");
    expect(formatCooldown(90)).toBe("1 min 30 sec");
  });
});
