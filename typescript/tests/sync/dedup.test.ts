import { describe, it, expect } from "vitest";
import { isUnsynced, filterUnsynced, pickNextUnsynced, summarizeDedup, type DedupWorkout } from "../../src/sync";

const w = (id: string, title?: string): DedupWorkout => ({ id, title: title ?? id });

describe("isUnsynced — the skip-if-synced-OR-pending rule", () => {
  it("a fresh workout (neither synced nor pending) is a candidate", () => {
    expect(isUnsynced(w("fresh"), new Set(), new Set())).toBe(true);
  });
  it("a workout with a terminal synced_workouts row is excluded (layer 1)", () => {
    expect(isUnsynced(w("done"), new Set(["done"]), new Set())).toBe(false);
  });
  it("a workout with an in-flight pending_uploads row is excluded (layer 2)", () => {
    expect(isUnsynced(w("mid"), new Set(), new Set(["mid"]))).toBe(false);
  });
  it("excluded when it is BOTH synced and pending", () => {
    expect(isUnsynced(w("both"), new Set(["both"]), new Set(["both"]))).toBe(false);
  });
  it("a workout with no id is never a candidate", () => {
    expect(isUnsynced({ id: "" }, new Set(), new Set())).toBe(false);
  });
});

describe("filterUnsynced — combined dedup over a list", () => {
  const workouts = [w("a"), w("b"), w("c"), w("d")];
  it("keeps only fresh workouts, excluding synced and pending", () => {
    expect(filterUnsynced(workouts, new Set(["a"]), new Set(["c"])).map((x) => x.id)).toEqual(["b", "d"]);
  });
  it("preserves input order of the survivors", () => {
    expect(filterUnsynced([w("z"), w("y"), w("x")], new Set(["y"]), new Set()).map((x) => x.id)).toEqual(["z", "x"]);
  });
  it("returns empty when every workout is synced", () => {
    expect(filterUnsynced(workouts, new Set(["a", "b", "c", "d"]), new Set())).toEqual([]);
  });
  it("returns empty when every workout is pending", () => {
    expect(filterUnsynced(workouts, new Set(), new Set(["a", "b", "c", "d"]))).toEqual([]);
  });
  it("returns empty when synced and pending together cover everything", () => {
    expect(filterUnsynced(workouts, new Set(["a", "b"]), new Set(["c", "d"]))).toEqual([]);
  });
  it("empty input → empty output", () => {
    expect(filterUnsynced([], new Set(), new Set())).toEqual([]);
  });
});

describe("pickNextUnsynced — the next workout to sync", () => {
  const workouts = [w("first"), w("second"), w("third")];
  it("picks the first unsynced workout in list order", () => {
    expect(pickNextUnsynced(workouts, new Set(), new Set())?.id).toBe("first");
  });
  it("skips synced/pending and picks the next eligible one", () => {
    expect(pickNextUnsynced(workouts, new Set(["first"]), new Set(["second"]))?.id).toBe("third");
  });
  it("returns null when all are synced", () => {
    expect(pickNextUnsynced(workouts, new Set(["first", "second", "third"]), new Set())).toBeNull();
  });
  it("returns null when all are pending", () => {
    expect(pickNextUnsynced(workouts, new Set(), new Set(["first", "second", "third"]))).toBeNull();
  });
  it("returns null on empty input", () => {
    expect(pickNextUnsynced([], new Set(), new Set())).toBeNull();
  });
});

describe("summarizeDedup — the preview shape", () => {
  const workouts = [w("a"), w("b"), w("c"), w("d"), w("e")];
  it("tallies synced, pending and remaining, and picks the next", () => {
    const s = summarizeDedup(workouts, new Set(["a", "b"]), new Set(["c"]));
    expect(s.totalHevy).toBe(5);
    expect(s.syncedCount).toBe(2);
    expect(s.pendingCount).toBe(1);
    expect(s.remaining).toBe(2);
    expect(s.candidates.map((x) => x.id)).toEqual(["d", "e"]);
    expect(s.nextUnsynced?.id).toBe("d");
  });
  it("all synced → zero remaining, null next", () => {
    const s = summarizeDedup(workouts, new Set(["a", "b", "c", "d", "e"]), new Set());
    expect(s.syncedCount).toBe(5);
    expect(s.remaining).toBe(0);
    expect(s.candidates).toEqual([]);
    expect(s.nextUnsynced).toBeNull();
  });
  it("all pending → zero remaining, counted as pending not synced", () => {
    const s = summarizeDedup(workouts, new Set(), new Set(["a", "b", "c", "d", "e"]));
    expect(s.syncedCount).toBe(0);
    expect(s.pendingCount).toBe(5);
    expect(s.remaining).toBe(0);
  });
  it("nothing synced or pending → everything remains", () => {
    const s = summarizeDedup(workouts, new Set(), new Set());
    expect(s.remaining).toBe(5);
    expect(s.nextUnsynced?.id).toBe("a");
  });
  it("a workout that is both synced and pending counts once (synced wins)", () => {
    const s = summarizeDedup([w("x")], new Set(["x"]), new Set(["x"]));
    expect(s.syncedCount).toBe(1);
    expect(s.pendingCount).toBe(0);
  });
  it("empty workout list → zeroed summary", () => {
    expect(summarizeDedup([], new Set(["a"]), new Set(["b"]))).toEqual({
      totalHevy: 0, syncedCount: 0, pendingCount: 0, remaining: 0, candidates: [], nextUnsynced: null,
    });
  });
});
