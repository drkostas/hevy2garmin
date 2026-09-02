import { describe, it, expect } from "vitest";
import {
  initialLoopState,
  stepLoop,
  classifyError,
  loopPercent,
  errorHint,
  type LoopState,
} from "./sync-loop";

function ok(result: Record<string, unknown>) {
  return { httpStatus: 200, result };
}

/** Drive a full sequence of responses through the reducer. */
function drive(seq: Array<{ httpStatus: number; result: Record<string, unknown> }>): LoopState {
  let s = { ...initialLoopState };
  for (const step of seq) {
    const { state, cont } = stepLoop(s, step);
    s = state;
    if (!cont) break;
  }
  return s;
}

describe("classifyError", () => {
  it("maps error strings to branches", () => {
    expect(classifyError("Garmin requires upload consent")).toBe("consent");
    expect(classifyError("Your Hevy API key is invalid")).toBe("hevy_key");
    expect(classifyError("Login failed: bad token")).toBe("garmin_auth");
    expect(classifyError("OAuth expired")).toBe("garmin_auth");
    expect(classifyError("kaboom")).toBe("generic");
  });
});

describe("stepLoop — clean 3-workout run", () => {
  it("counts 3 synced, seeds total, ends caught-up at 100%", () => {
    const final = drive([
      ok({ status: "synced", remaining: 2, workout: { title: "Push A" } }),
      ok({ status: "synced", remaining: 1, workout: { title: "Pull B" } }),
      ok({ status: "synced", remaining: 0, workout: { title: "Legs C" } }),
      ok({ status: "none", remaining: 0, dedupDecision: "no_candidates" }),
    ]);
    expect(final.synced).toBe(3);
    expect(final.total).toBe(3);
    expect(final.remaining).toBe(0);
    expect(final.done).toBe(true);
    expect(final.message).toBe("All caught up.");
    expect(loopPercent(final)).toBe(100);
  });

  it("finishes without a trailing none when remaining hits 0", () => {
    const final = drive([
      ok({ status: "synced", remaining: 1, workout: { title: "A" } }),
      ok({ status: "synced", remaining: 0, workout: { title: "B" } }),
    ]);
    expect(final.synced).toBe(2);
    expect(final.done).toBe(true);
  });
});

describe("stepLoop — termination branches", () => {
  it("busy (claim_lost) stops immediately", () => {
    const { state, cont } = stepLoop(initialLoopState, ok({ status: "deferred", dedupDecision: "claim_lost", remaining: 5 }));
    expect(cont).toBe(false);
    expect(state.message).toMatch(/already running/);
  });

  it("error stops and classifies the branch", () => {
    const { state, cont } = stepLoop(initialLoopState, ok({ status: "error", error: "Garmin requires upload consent" }));
    expect(cont).toBe(false);
    expect(state.errorKind).toBe("consent");
    expect(errorHint(state.errorKind!)).toMatch(/consent/i);
  });

  it("401 stops with an unauthorized prompt before any work", () => {
    const { state, cont } = stepLoop(initialLoopState, { httpStatus: 401, result: {} });
    expect(cont).toBe(false);
    expect(state.errorKind).toBe("unauthorized");
    expect(state.message).toMatch(/Sign in/);
  });

  it("nothing to sync (immediate none) → caught up, 0 synced", () => {
    const { state, cont } = stepLoop(initialLoopState, ok({ status: "none", remaining: 0, dedupDecision: "no_candidates" }));
    expect(cont).toBe(false);
    expect(state.synced).toBe(0);
    expect(state.message).toBe("All caught up.");
  });

  it("a mid-run error after one synced keeps the synced count", () => {
    const final = drive([
      ok({ status: "synced", remaining: 2, workout: { title: "A" } }),
      ok({ status: "error", error: "Login failed" }),
      ok({ status: "synced", remaining: 0 }), // never reached
    ]);
    expect(final.synced).toBe(1);
    expect(final.errorKind).toBe("garmin_auth");
  });
});

describe("loopPercent", () => {
  it("is 0 before the total is known", () => {
    expect(loopPercent(initialLoopState)).toBe(0);
  });
});
