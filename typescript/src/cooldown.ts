/**
 * Cooldown — batches uploads + rate-limits API calls.
 * Ported from Python src/hevy2garmin/ratelimit.py.
 */

import type { CooldownConfig } from "./sync-types";

export interface CooldownState {
  lastUploadTime?: Date;
  pendingBatch: string[]; // hevyIds queued for upload
  uploadInProgress: boolean;
}

/**
 * Cooldown manager — enforces minimum interval between sync runs,
 * batches pending workouts, prevents rate-limit exhaustion.
 */
export class CooldownManager {
  private config: CooldownConfig;
  private state: CooldownState = {
    pendingBatch: [],
    uploadInProgress: false,
  };

  constructor(config: CooldownConfig) {
    this.config = config;
  }

  /**
   * Check if ready to upload (cooldown elapsed).
   * Returns time remaining (ms) if not ready; 0 if ready.
   */
  getTimeUntilReady(): number {
    if (!this.state.lastUploadTime) {
      return 0; // First upload, ready immediately
    }

    const elapsedMs = Date.now() - this.state.lastUploadTime.getTime();
    const requiredMs = this.config.minIntervalSeconds * 1000;

    return Math.max(0, requiredMs - elapsedMs);
  }

  /**
   * Check if ready to upload (cooldown elapsed).
   */
  isReady(): boolean {
    return this.getTimeUntilReady() === 0;
  }

  /**
   * Queue a workout for batch upload.
   */
  enqueue(hevyId: string): void {
    if (!this.state.pendingBatch.includes(hevyId)) {
      this.state.pendingBatch.push(hevyId);
    }
  }

  /**
   * Dequeue batch for upload (up to maxBatchSize).
   * Returns empty if cooldown not elapsed.
   */
  dequeueBatch(): string[] {
    if (!this.isReady()) {
      return [];
    }

    const batchSize = this.config.maxBatchSize || 10;
    const batch = this.state.pendingBatch.splice(0, batchSize);
    return batch;
  }

  /**
   * Mark upload as started (prevent concurrent uploads).
   */
  startUpload(): void {
    this.state.uploadInProgress = true;
  }

  /**
   * Mark upload as finished; stamp cooldown timestamp.
   */
  finishUpload(): void {
    this.state.uploadInProgress = false;
    this.state.lastUploadTime = new Date();
  }

  /**
   * Check if upload is already in progress.
   */
  isUploading(): boolean {
    return this.state.uploadInProgress;
  }

  /**
   * Get pending batch size.
   */
  getPendingCount(): number {
    return this.state.pendingBatch.length;
  }

  /**
   * Get current state (for persistence).
   */
  getState(): CooldownState {
    return { ...this.state, pendingBatch: [...this.state.pendingBatch] };
  }

  /**
   * Restore from persisted state (e.g., from DB).
   */
  setState(state: CooldownState): void {
    this.state = {
      ...state,
      pendingBatch: [...state.pendingBatch],
    };
  }
}

/**
 * Rate limiter — tracks API call counts, applies backoff.
 * Python: RateLimiter(delay=1.0) from garmin_auth.
 */
export class RateLimiter {
  private delay: number; // seconds between calls
  private lastCallTime = 0;

  constructor(delay: number = 1.0) {
    this.delay = delay;
  }

  /**
   * Wait until it's safe to make the next API call.
   */
  async wait(): Promise<void> {
    const elapsedMs = Date.now() - this.lastCallTime * 1000;
    const requiredMs = this.delay * 1000;

    if (elapsedMs < requiredMs) {
      const waitMs = requiredMs - elapsedMs;
      await new Promise((r) => setTimeout(r, waitMs));
    }

    this.lastCallTime = Date.now() / 1000;
  }

  /**
   * Record a call without waiting (used when calling in sequence).
   */
  recordCall(): void {
    this.lastCallTime = Date.now() / 1000;
  }

  /**
   * Reset the limiter.
   */
  reset(): void {
    this.lastCallTime = 0;
  }
}
