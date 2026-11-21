import { describe, it, expect, vi, beforeEach } from "vitest";

/** Auth disabled (no session needed); DB captured via a fake sql tag. */
vi.mock("@/lib/auth", () => ({
  authEnabled: () => false,
  verifySession: async () => true,
  SESSION_COOKIE: "h2g_session",
}));

const writes: Array<{ key: string; value: Record<string, unknown> }> = [];
const persisted = new Map<string, Record<string, unknown>>();
vi.mock("@/lib/db", () => {
  const tag = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join("?");
    if (q.startsWith("SELECT key, value FROM app_cache")) return []; // no existing config
    if (q.startsWith("SELECT value FROM app_cache")) return persisted.has(String(values[0])) ? [{ value: persisted.get(String(values[0])) }] : [];
    if (q.includes("INSERT INTO app_cache")) {
      writes.push({ key: values[0] as string, value: values[1] as Record<string, unknown> });
      persisted.set(String(values[0]), values[1] as Record<string, unknown>);
      return [];
    }
    throw new Error("unexpected query: " + q);
  }) as unknown as { (): unknown; json: <T>(v: T) => T };
  tag.json = (v) => v;
  return { getDb: () => tag };
});

import { POST } from "./route";
import { getDb } from "@/lib/db";
import { loadWeightUnit } from "@/lib/weight-unit-settings";

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
  persisted.clear();
});

describe("POST /api/settings — extended config surface", () => {
  it("round-trips the saved unit without rewriting the canonical profile", async () => {
    persisted.set("user_profile", { weight_kg: 80 });
    expect(await loadWeightUnit(getDb())).toBe("kg");
    await POST(req({ display_units: { weight: "lb" } }));
    expect(await loadWeightUnit(getDb())).toBe("lb");
    await POST(req({ display_units: { weight: "kg" } }));
    expect(await loadWeightUnit(getDb())).toBe("kg");
    expect(persisted.get("user_profile")).toEqual({ weight_kg: 80 });
  });
  it.each(["lb", "kg"])("saves %s separately from canonical profile weights", async (unit) => {
    expect((await POST(req({ display_units: { weight: unit } }))).status).toBe(200);
    expect(saved("display_units")).toEqual({ weight: unit });
    expect(saved("user_profile")).toBeUndefined();
  });
  it("rejects unsupported weight units without writing settings", async () => {
    expect((await POST(req({ display_units: { weight: "stones" } }))).status).toBe(400);
    expect(writes).toEqual([]);
  });
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

/**
 * A mistyped timezone must be refused, not stored (#640).
 *
 * It used to be saved verbatim, and a zone that is not real produces no local
 * timestamp in the FIT. The user then sees a setting that appears to do nothing,
 * which is worse than an error, because there is nothing to search for.
 */
describe("timezone validation", () => {
  beforeEach(() => {
    writes.length = 0;
  });

  it("refuses a typo with a 400 that names the value", async () => {
    const res = await POST(req({ user_profile: { timezone: "Europe/Athnes" } }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("Europe/Athnes");
    expect(writes).toEqual([]);
  });

  it("stores a real zone", async () => {
    const res = await POST(req({ user_profile: { timezone: "Europe/Athens" } }));
    expect(res.status).toBe(200);
    expect(writes.find((w) => w.key === "user_profile")?.value.timezone).toBe("Europe/Athens");
  });

  it("stores the runtime's own spelling rather than the one typed", async () => {
    const res = await POST(req({ user_profile: { timezone: "europe/athens" } }));
    expect(res.status).toBe(200);
    expect(writes.find((w) => w.key === "user_profile")?.value.timezone).toBe("Europe/Athens");
  });

  it("still allows blank, which means keep the previous UTC behaviour", async () => {
    // The README offers blank as a real choice, so it is not a validation
    // failure. Refusing it here would take away a documented option.
    const res = await POST(req({ user_profile: { timezone: "", weight_kg: 80 } }));
    expect(res.status).toBe(200);
    expect(writes.find((w) => w.key === "user_profile")?.value.timezone).toBe("");
  });

  it("does not reject a save that never mentions a timezone", async () => {
    const res = await POST(req({ user_profile: { weight_kg: 82 } }));
    expect(res.status).toBe(200);
  });
});

/**
 * The sync start date (#647).
 *
 * Requested by a user whose whole Hevy back catalogue showed as pending,
 * because he had entered those workouts into Garmin by hand before finding the
 * tool. A typo must be refused rather than stored, or it filters nothing and
 * looks like the setting does not work.
 */
describe("sync start date", () => {
  beforeEach(() => {
    writes.length = 0;
  });

  it("stores a real date", async () => {
    const res = await POST(req({ sync_window: { start_date: "2026-09-01" } }));
    expect(res.status).toBe(200);
    expect(writes.find((w) => w.key === "sync_window")?.value.start_date).toBe("2026-09-01");
  });

  it("refuses a malformed date with a 400 that names the value", async () => {
    const res = await POST(req({ sync_window: { start_date: "01/09/2026" } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("01/09/2026");
    expect(writes).toEqual([]);
  });

  it("allows blank, which clears the window", async () => {
    // Clearing it brings the older workouts back as candidates. Nothing was
    // deleted, so this has to remain possible.
    const res = await POST(req({ sync_window: { start_date: "" }, hr_fusion: { enabled: true } }));
    expect(res.status).toBe(200);
    expect(writes.find((w) => w.key === "sync_window")?.value.start_date).toBe("");
  });
});
