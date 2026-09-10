/**
 * The Garmin boundary of the sync engine — the ONLY way the engine reaches
 * Garmin Connect. `findExistingActivity` is a READ (dedup layer 2, the
 * 409-prevention lookup). `upload`, `rename` and `describe` are WRITES, reached
 * only on the live path (dryRun === false). Nothing here decides WHETHER to
 * upload; the engine does.
 *
 * `garminGateway(client)` is the default over this package's own Garmin ops. A
 * test supplies spies instead.
 */
import type { GarminClient } from "garmin-auth";
import { findActivityByStartTime, renameActivity, setDescription, uploadFit, type UploadResult } from "../garmin";

export interface GarminGateway {
  /** READ: the id of an activity already at this start time, or null. */
  findExistingActivity(startTime: string): Promise<number | null>;
  /** WRITE: upload a FIT (bytes); resolve the activity id. */
  upload(fit: Uint8Array, workoutStart?: string): Promise<UploadResult>;
  /** WRITE: rename an activity. */
  rename(activityId: number, name: string): Promise<void>;
  /** WRITE: set an activity's description. */
  describe(activityId: number, description: string): Promise<void>;
}

/** The default gateway: thin passthroughs to the package's Garmin functions. */
export function garminGateway(client: GarminClient): GarminGateway {
  return {
    findExistingActivity: (startTime) => findActivityByStartTime(client, startTime),
    upload: (fit, workoutStart) => uploadFit(client, fit, workoutStart),
    rename: (activityId, name) => renameActivity(client, activityId, name),
    describe: (activityId, description) => setDescription(client, activityId, description),
  };
}

/** What the engine needs from its host. All IO goes through these three. */
export interface SyncDeps {
  store: import("./store").SyncStore;
  /** Lazily built: only called once a Garmin read/write is actually needed. */
  gateway: () => Promise<GarminGateway>;
  /** The Hevy workout list, newest first (the order the engine picks in). */
  fetchWorkouts: () => Promise<import("./types").DedupWorkout[]>;
}
