import { describe, it, expect, vi, beforeEach } from "vitest";

let stored: Record<string, unknown> | null = null;
const captured: Array<Record<string, unknown>> = [];
vi.mock("@/lib/db", () => {
  const tag = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join("?");
    if (q.startsWith("SELECT value FROM app_cache")) return stored ? [{ value: stored }] : [];
    if (q.includes("INSERT INTO app_cache")) {
      stored = values[1] as Record<string, unknown>;
      captured.push(stored);
      return [];
    }
    throw new Error("unexpected query: " + q);
  }) as unknown as { (): unknown; json: <T>(v: T) => T };
  tag.json = (v) => v;
  return { getDb: () => tag };
});

import { POST } from "./route";

beforeEach(() => {
  stored = null;
  captured.length = 0;
});

describe("POST /api/garmin-rate-limited", () => {
  it("first hit → 2h cooldown", async () => {
    const res = await POST();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.cooldown_seconds).toBe(2 * 3600);
    expect((captured[0].hits as number)).toBe(1);
    expect(typeof captured[0].until).toBe("string");
  });

  it("backs off exponentially: 2h → 4h → 8h", async () => {
    await POST();
    await POST();
    const res = await POST();
    expect((await res.json()).cooldown_seconds).toBe(8 * 3600);
  });

  it("caps at 24h", async () => {
    for (let i = 0; i < 10; i++) await POST();
    const res = await POST();
    expect((await res.json()).cooldown_seconds).toBe(24 * 3600);
  });
});
