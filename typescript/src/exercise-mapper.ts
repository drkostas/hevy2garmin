/**
 * Exercise mapper — manages Hevy ↔ Garmin exercise ID mappings.
 * Ported from Python src/hevy2garmin/mapper.py.
 */

export interface ExerciseMapping {
  hevyExerciseId: string;
  hevyExerciseName: string;
  garminExerciseId?: string;
  garminExerciseName?: string;
  confidence: number; // 0-1, user confidence in this mapping
  isCustom: boolean; // user-created mapping vs. auto-matched
  createdAt: Date;
  updatedAt: Date;
}

export interface UnmappedExercise {
  hevyExerciseId: string;
  hevyExerciseName: string;
  occurrences: number; // how many workouts use this
  lastSeen: Date;
}

/**
 * Exercise mapper — tracks Hevy ↔ Garmin mappings, suggests matches.
 */
export class ExerciseMapper {
  private mappings = new Map<string, ExerciseMapping>();
  private unmapped: UnmappedExercise[] = [];

  /**
   * Look up Garmin exercise for a Hevy exercise.
   */
  lookup(hevyExerciseId: string): ExerciseMapping | null {
    return this.mappings.get(hevyExerciseId) || null;
  }

  /**
   * Create or update a custom mapping.
   */
  setMapping(
    hevyExerciseId: string,
    hevyExerciseName: string,
    garminExerciseId: string,
    garminExerciseName: string,
    confidence: number = 1.0
  ): ExerciseMapping {
    const mapping: ExerciseMapping = {
      hevyExerciseId,
      hevyExerciseName,
      garminExerciseId,
      garminExerciseName,
      confidence,
      isCustom: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.mappings.set(hevyExerciseId, mapping);
    return mapping;
  }

  /**
   * Record an unmapped exercise.
   */
  recordUnmapped(hevyExerciseId: string, hevyExerciseName: string): void {
    let entry = this.unmapped.find((e) => e.hevyExerciseId === hevyExerciseId);
    if (!entry) {
      entry = {
        hevyExerciseId,
        hevyExerciseName,
        occurrences: 0,
        lastSeen: new Date(),
      };
      this.unmapped.push(entry);
    }
    entry.occurrences++;
    entry.lastSeen = new Date();
  }

  /**
   * Get all unmapped exercises (sorted by frequency).
   */
  getUnmapped(): UnmappedExercise[] {
    return this.unmapped.sort((a, b) => b.occurrences - a.occurrences);
  }

  /**
   * Suggest Garmin exercises for a Hevy exercise (fuzzy match).
   * Simple substring matching; production would use Levenshtein distance.
   */
  suggestGarminExercises(
    hevyExerciseName: string,
    garminExercises: Array<{ id: string; name: string }>
  ): Array<{ id: string; name: string; score: number }> {
    return garminExercises
      .map((ge) => ({
        ...ge,
        score: this.nameSimilarity(hevyExerciseName, ge.name),
      }))
      .filter((s) => s.score > 0.3) // Only reasonable matches
      .sort((a, b) => b.score - a.score)
      .slice(0, 5); // Top 5 suggestions
  }

  /**
   * Simple string similarity (0-1).
   */
  private nameSimilarity(a: string, b: string): number {
    const aLower = a.toLowerCase();
    const bLower = b.toLowerCase();

    if (aLower === bLower) return 1.0;
    if (aLower.includes(bLower) || bLower.includes(aLower)) return 0.8;

    // Levenshtein-lite: count matching words
    const aWords = aLower.split(/\s+/);
    const bWords = bLower.split(/\s+/);
    const matching = aWords.filter((w) => bWords.includes(w)).length;
    return Math.min(1, matching / Math.max(aWords.length, bWords.length));
  }

  /**
   * Get all mappings (for persistence).
   */
  getAllMappings(): ExerciseMapping[] {
    return Array.from(this.mappings.values());
  }

  /**
   * Load mappings from DB.
   */
  loadMappings(mappings: ExerciseMapping[]): void {
    this.mappings.clear();
    mappings.forEach((m) => {
      this.mappings.set(m.hevyExerciseId, m);
    });
  }

  /**
   * Delete a mapping.
   */
  deleteMapping(hevyExerciseId: string): boolean {
    return this.mappings.delete(hevyExerciseId);
  }

  /**
   * Get mapping count.
   */
  getMappingCount(): number {
    return this.mappings.size;
  }

  /**
   * Get unmapped count.
   */
  getUnmappedCount(): number {
    return this.unmapped.length;
  }
}
