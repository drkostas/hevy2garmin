import { describe, it, expect, beforeEach, vi } from "vitest";
import { ensureSchema, resetSchemaForTests, SCHEMA_STATEMENTS, SCHEMA_TABLES } from "./schema";

function runner(failOn?: string) {
  const ran: string[] = [];
  return {
    ran,
    db: {
      unsafe: vi.fn(async (text: string) => {
        ran.push(text);
        if (failOn && text.includes(failOn)) throw new Error(`boom on ${failOn}`);
        return [];
      }),
    },
  };
}

beforeEach(() => resetSchemaForTests());

describe("ensureSchema (#475)", () => {
  it("creates the nine Python tables, every statement IF NOT EXISTS", () => {
    const creates = SCHEMA_STATEMENTS.filter((s) => s.startsWith("CREATE TABLE"));
    expect(creates).toHaveLength(9);
    for (const t of SCHEMA_TABLES) expect(creates.some((s) => s.includes(`IF NOT EXISTS ${t} (`))).toBe(true);
    for (const s of SCHEMA_STATEMENTS) expect(s).toMatch(/IF NOT EXISTS/);
  });

  it("runs every statement in order, once", async () => {
    const { db, ran } = runner();
    expect(await ensureSchema(db)).toBe(true);
    expect(ran).toEqual([...SCHEMA_STATEMENTS]);
  });

  it("is memoised per process: concurrent and later callers share one run", async () => {
    const { db } = runner();
    await Promise.all([ensureSchema(db), ensureSchema(db), ensureSchema(db)]);
    await ensureSchema(db);
    expect(db.unsafe).toHaveBeenCalledTimes(SCHEMA_STATEMENTS.length);
  });

  it("runs migrations for a second profile's connection too", async () => {
    const first = runner();
    const second = runner();
    await Promise.all([ensureSchema(first.db), ensureSchema(second.db)]);
    expect(first.db.unsafe).toHaveBeenCalledTimes(SCHEMA_STATEMENTS.length);
    expect(second.db.unsafe).toHaveBeenCalledTimes(SCHEMA_STATEMENTS.length);
  });

  it("never rejects: a failing statement logs, resolves false, and does not block queries", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = runner("app_cache");
    await expect(ensureSchema(db)).resolves.toBe(false);
    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0][0])).toContain("app_cache");
    spy.mockRestore();
  });
});
