import { describe, it, expect, vi, beforeEach } from "vitest";

/** Auth disabled (no session needed); DB captured via a fake sql tag. */
vi.mock("@/lib/auth", () => ({
  authEnabled: () => false,
  verifySession: async () => true,
  SESSION_COOKIE: "h2g_session",
}));

const writes: Array<{ key: string; value: Record<string, unknown> }> = [];
vi.mock("@/lib/db", () => {
  const tag = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join("?");
    if (q.startsWith("SELECT key, value FROM app_cache")) return []; // no existing config
    if (q.includes("INSERT INTO app_cache")) {
      writes.push({ key: values[0] as string, value: values[1] as Record<string, unknown> });
      return [];
    }
    throw new Error("unexpected query: " + q);
  }) as unknown as { (): unknown; json: <T>(v: T) => T };
  tag.json = (v) => v;
  return { getDb: () => tag };
});

import { POST } from "./route";

function req(body: unknown): Request {
  return new Request("http://h/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function saved(key: string): Record<string, unknown> | undefined {
  return writes.find((w) => w.key === key)?.value;
}

beforeEach(() => {
  writes.length = 0;
});

describe("POST /api/settings — extended config surface", () => {
  it("saves profile fields with validation (sex whitelist, vo2max)", async () => {
    const res = await POST(
      req({ user_profile: { birth_year: 1994, sex: "FEMALE", vo2max: 52.34, timezone: " Europe/Athens " } }),
    );
    expect(res.status).toBe(200);
    const p = saved("user_profile")!;
    expect(p.birth_year).toBe(1994);
    expect(p.sex).toBe("female");
    expect(p.vo2max).toBe(52.3);
    expect(p.timezone).toBe("Europe/Athens");
  });

  it("drops an out-of-whitelist sex but keeps valid siblings", async () => {
    await POST(req({ user_profile: { sex: "other", weight_kg: 82 } }));
    const p = saved("user_profile")!;
    expect(p.sex).toBeUndefined();
    expect(p.weight_kg).toBe(82);
  });

  it("clamps merge_overlap_pct to [50,95] and merge_max_drift_min to [5,60]", async () => {
    await POST(req({ merge_settings: { merge_overlap_pct: 999, merge_max_drift_min: 1, merge_mode: true } }));
    const m = saved("merge_settings")!;
    expect(m.merge_overlap_pct).toBe(95);
    expect(m.merge_max_drift_min).toBe(5);
    expect(m.merge_mode).toBe(true);
  });

  it("normalizes merge_activity_types: strength_training first, deduped, snake_cased", async () => {
    await POST(req({ merge_settings: { merge_activity_types: ["Indoor Cardio", "strength_training", "yoga", "yoga"] } }));
    const m = saved("merge_settings")!;
    expect(m.merge_activity_types).toEqual(["strength_training", "indoor_cardio", "yoga"]);
  });

  it("saves the timing key with rounded ints", async () => {
    await POST(
      req({ timing: { working_set_seconds: 45.6, warmup_set_seconds: 20, rest_between_sets_seconds: 90, rest_between_exercises_seconds: 150 } }),
    );
    const t = saved("timing")!;
    expect(t.working_set_seconds).toBe(46);
    expect(t.rest_between_exercises_seconds).toBe(150);
  });

  it("400 when nothing editable is provided", async () => {
    const res = await POST(req({ nonsense: { x: 1 } }));
    expect(res.status).toBe(400);
    expect(writes).toHaveLength(0);
  });
});
