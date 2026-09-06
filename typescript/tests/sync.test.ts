import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  SyncStateMachine,
  SyncLock,
  SyncRunAggregator,
  isWorkoutWithinGracePeriod,
  type SyncStore,
  type PendingWorkout,
} from "../src/sync";
import type { SyncConfig } from "../src/sync-types";

// Mock store for testing
class MockStore implements SyncStore {
  private pending = new Map<string, PendingWorkout>();

  async getPending(hevyId: string): Promise<PendingWorkout | null> {
    return this.pending.get(hevyId) || null;
  }

  async updatePending(pending: PendingWorkout): Promise<void> {
    this.pending.set(pending.hevyId, { ...pending });
  }

  async completePending(
    hevyId: string,
    terminal: Record<string, unknown>
  ): Promise<void> {
    const pending = this.pending.get(hevyId);
    if (pending) {
      this.pending.set(hevyId, {
        ...pending,
        phase: "synced",
        payload: { ...pending.payload, ...terminal },
      });
    }
  }

  async recordSyncLog(): Promise<void> {}
  async markSyncTime(): Promise<void> {}
  async getLastSyncTime(): Promise<Date | null> {
    return null;
  }
}

const defaultConfig: SyncConfig = {
  gracePeriod: { minutes: 60 },
  cooldown: { minIntervalSeconds: 1 },
  hrFusion: {
    enableFusion: true,
    sources: ["hevy", "garmin", "watch"],
    fallbackOrder: ["garmin", "hevy", "watch"],
  },
  mergeMode: "merge",
  dryRun: false,
};

describe("SyncStateMachine", () => {
  let store: MockStore;
  let sm: SyncStateMachine;

  beforeEach(() => {
    store = new MockStore();
    sm = new SyncStateMachine("workout-123", store, defaultConfig);
  });

  it("should initialize pending state", async () => {
    const result = await sm.initiate({
      title: "Chest Day",
      workoutId: "h-456",
      calories: 250,
      avgHr: 130,
    });

    expect(result.status).toBe("processing");
    const state = sm.getState();
    expect(state.phase).toBe("processing");
    expect(state.attemptCount).toBe(1);
  });

  it("should restore from persisted checkpoint", async () => {
    const checkpointWorkout: PendingWorkout = {
      hevyId: "workout-789",
      phase: "finalizing",
      nextStep: "description",
      garminActivityId: "g-999",
      payload: { title: "Back Day", avgHr: 125 },
    };

    await store.updatePending(checkpointWorkout);
    const sm2 = new SyncStateMachine("workout-789", store, defaultConfig);
    await sm2.restore("workout-789");

    const state = sm2.getState();
    expect(state.phase).toBe("finalizing");
    expect(state.nextStep).toBe("description");
    expect(state.garminActivityId).toBe("g-999");
  });

  it("should finalize sync through all steps (rename → commit)", async () => {
    await sm.initiate({
      title: "Leg Day",
      descriptionEnabled: false,
      calories: 350,
      avgHr: 140,
    });

    const result = await sm.finalize("111");
    expect(result.status).toBe("synced");
    expect(result.activityId).toBe(111);
    expect(result.calories).toBe(350);
  });

  it("should handle watch activity deletion step", async () => {
    await sm.initiate({
      title: "Arms",
      descriptionEnabled: true,
      description: "Biceps + Triceps",
      calories: 180,
      avgHr: 110,
      watchActivityId: undefined, // No watch activity to delete
    });

    // Simulate upload
    const result = await sm.finalize("222");
    expect(result.status).toBe("synced");
    expect(result.activityId).toBe(222);

    // Get state to verify finalization reached synced
    const state = sm.getState();
    expect(state.phase).toBe("synced");
  });

  it("should record error and mark needs_review", async () => {
    await sm.initiate({ title: "Push" });
    const result = await sm.needsReview("Ambiguous activity match");

    expect(result.status).toBe("needs_review");
    const state = sm.getState();
    expect(state.phase).toBe("needs_review");
  });

  it("should record error and mark failed", async () => {
    await sm.initiate({ title: "Pull" });
    const result = await sm.fail("Garmin API timeout (3 retries exhausted)");

    expect(result.status).toBe("failed");
    const state = sm.getState();
    expect(state.phase).toBe("failed");
  });
});

describe("Grace period guard", () => {
  it("should return false when grace period is 0 or negative", () => {
    const workout = {
      endTime: new Date(Date.now() - 30000).toISOString(),
    };
    expect(isWorkoutWithinGracePeriod(workout, 0)).toBe(false);
    expect(isWorkoutWithinGracePeriod(workout, -1)).toBe(false);
  });

  it("should return true when workout ended within grace period", () => {
    const recentEnd = new Date(Date.now() - 30 * 60 * 1000); // 30 minutes ago
    const workout = { end_time: recentEnd.toISOString() };
    expect(isWorkoutWithinGracePeriod(workout, 60)).toBe(true); // 60-minute grace
  });

  it("should return false when workout ended before grace period", () => {
    const oldEnd = new Date(Date.now() - 120 * 60 * 1000); // 2 hours ago
    const workout = { endTime: oldEnd.toISOString() };
    expect(isWorkoutWithinGracePeriod(workout, 60)).toBe(false);
  });

  it("should handle missing or invalid timestamp", () => {
    expect(isWorkoutWithinGracePeriod({}, 60)).toBe(false);
    expect(isWorkoutWithinGracePeriod({ endTime: "invalid" }, 60)).toBe(false);
  });
});

describe("SyncLock", () => {
  it("should acquire and release lock", () => {
    const lock = new SyncLock();
    expect(lock.acquire()).toBe(true);
    expect(lock.isHeld()).toBe(true);

    lock.release();
    expect(lock.isHeld()).toBe(false);
  });

  it("should reject acquire when already held", () => {
    const lock = new SyncLock();
    expect(lock.acquire()).toBe(true);
    expect(lock.acquire()).toBe(false);
  });

  it("should throw on release when not held", () => {
    const lock = new SyncLock();
    expect(() => lock.release()).toThrow("SyncLock not held");
  });

  it("should force-release after timeout", () => {
    const lock = new SyncLock(100); // 100ms timeout
    expect(lock.acquire()).toBe(true);

    // Wait for timeout
    vi.useFakeTimers();
    vi.advanceTimersByTime(200);

    expect(lock.acquire()).toBe(true); // Should re-acquire
    vi.useRealTimers();
  });
});

describe("SyncRunAggregator", () => {
  it("should aggregate results by status", () => {
    const agg = new SyncRunAggregator();
    agg.add({ status: "synced", activityId: 1 });
    agg.add({ status: "synced", activityId: 2 });
    agg.add({ status: "processing", activityId: 3 });
    agg.add({ status: "needs_review", activityId: 4 });
    agg.add({ status: "failed" });

    const result = agg.aggregate();
    expect(result.synced).toBe(2);
    expect(result.processing).toBe(1);
    expect(result.needsReview).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.deferred).toBe(0);
  });
});
