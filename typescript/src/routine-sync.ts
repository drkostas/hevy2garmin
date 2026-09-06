/**
 * Routine scheduling — sync Hevy routines to Garmin on-device workouts.
 * Ported from Python src/hevy2garmin/routine.py.
 */

export interface HevyRoutine {
  id: string;
  name: string;
  description?: string;
  exercises: HevyExercise[];
  createdAt?: Date;
}

export interface HevyExercise {
  id: string;
  name: string;
  sets?: number;
  reps?: number;
  weight?: number;
  unit?: "lb" | "kg";
}

export interface GarminWorkout {
  id: string;
  name: string;
  description?: string;
  workoutSteps: GarminWorkoutStep[];
  createdAt?: Date;
}

export interface GarminWorkoutStep {
  stepNumber: number;
  exerciseName: string;
  sets?: number;
  reps?: number;
  weight?: number;
  unit?: "lb" | "kg";
}

/**
 * Hash routine content for change detection (skip sync if unchanged).
 * Python: workout_content_hash(routine) for dedup.
 */
export function hashRoutineContent(routine: HevyRoutine): string {
  const content = JSON.stringify({
    name: routine.name,
    exercises: routine.exercises.map((e) => ({
      name: e.name,
      sets: e.sets,
      reps: e.reps,
      weight: e.weight,
      unit: e.unit,
    })),
  });

  // Simple hash; production would use crypto.createHash('sha256')
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash.toString(16);
}

/**
 * Convert Hevy routine to Garmin workout format.
 */
export function routineToGarminWorkout(routine: HevyRoutine): GarminWorkout {
  return {
    id: `routine-${routine.id}`,
    name: routine.name,
    description: routine.description,
    workoutSteps: routine.exercises.map((e, idx) => ({
      stepNumber: idx + 1,
      exerciseName: e.name,
      sets: e.sets,
      reps: e.reps,
      weight: e.weight,
      unit: e.unit,
    })),
    createdAt: routine.createdAt,
  };
}

/**
 * Routine sync tracker — records which routines have been synced.
 */
export interface RoutineSyncRecord {
  hevyRoutineId: string;
  garminWorkoutId?: string;
  contentHash: string;
  lastSyncedAt: Date;
  syncStatus: "synced" | "pending" | "failed";
  lastError?: string;
}

/**
 * Manager for routine syncing.
 */
export class RoutineSyncManager {
  private syncedRoutines = new Map<string, RoutineSyncRecord>();

  /**
   * Check if routine needs syncing (content changed or never synced).
   */
  needsSync(routine: HevyRoutine): boolean {
    const record = this.syncedRoutines.get(routine.id);
    if (!record) {
      return true; // Never synced
    }

    const currentHash = hashRoutineContent(routine);
    return currentHash !== record.contentHash;
  }

  /**
   * Record successful routine sync.
   */
  recordSync(
    routine: HevyRoutine,
    garminWorkoutId: string
  ): RoutineSyncRecord {
    const record: RoutineSyncRecord = {
      hevyRoutineId: routine.id,
      garminWorkoutId,
      contentHash: hashRoutineContent(routine),
      lastSyncedAt: new Date(),
      syncStatus: "synced",
    };
    this.syncedRoutines.set(routine.id, record);
    return record;
  }

  /**
   * Record failed routine sync.
   */
  recordFailure(routine: HevyRoutine, error: string): RoutineSyncRecord {
    const record: RoutineSyncRecord = {
      hevyRoutineId: routine.id,
      contentHash: hashRoutineContent(routine),
      lastSyncedAt: new Date(),
      syncStatus: "failed",
      lastError: error,
    };
    this.syncedRoutines.set(routine.id, record);
    return record;
  }

  /**
   * Get sync record for a routine.
   */
  getRecord(hevyRoutineId: string): RoutineSyncRecord | undefined {
    return this.syncedRoutines.get(hevyRoutineId);
  }

  /**
   * Get all sync records.
   */
  getAllRecords(): RoutineSyncRecord[] {
    return Array.from(this.syncedRoutines.values());
  }

  /**
   * Restore from persisted records (e.g., from DB).
   */
  loadRecords(records: RoutineSyncRecord[]): void {
    this.syncedRoutines.clear();
    records.forEach((r) => {
      this.syncedRoutines.set(r.hevyRoutineId, r);
    });
  }
}
