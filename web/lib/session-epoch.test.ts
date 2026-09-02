import { describe, it, expect } from "vitest";
import { getSessionEpoch, bumpSessionEpoch } from "./session-epoch";

function fakeSql(initial?: { n: number }) {
  let stored: unknown = initial;
  const tag = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join("?");
    if (q.startsWith("SELECT value FROM app_cache")) return stored ? [{ value: stored }] : [];
    if (q.includes("INSERT INTO app_cache")) {
      stored = values[1];
      return [];
    }
    throw new Error("unexpected: " + q);
  }) as unknown as ReturnType<typeof import("./db").getDb>;
  (tag as unknown as { json: <T>(v: T) => T }).json = (v) => v;
  return tag;
}

describe("session-epoch", () => {
  it("defaults to 0 when unset", async () => {
    expect(await getSessionEpoch(fakeSql())).toBe(0);
  });

  it("reads the stored n", async () => {
    expect(await getSessionEpoch(fakeSql({ n: 5 }))).toBe(5);
  });

  it("bump increments and persists", async () => {
    const sql = fakeSql({ n: 2 });
    expect(await bumpSessionEpoch(sql)).toBe(3);
    expect(await getSessionEpoch(sql)).toBe(3);
  });

  it("getSessionEpoch is best-effort (0 on read error)", async () => {
    const broken = (async () => {
      throw new Error("db down");
    }) as unknown as ReturnType<typeof import("./db").getDb>;
    (broken as unknown as { json: <T>(v: T) => T }).json = (v) => v;
    expect(await getSessionEpoch(broken)).toBe(0);
  });
});
