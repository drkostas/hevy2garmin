/**
 * HR fusion — merge HR data from multiple sources (Hevy, Garmin, watch).
 * Ported from Python src/hevy2garmin/hr.py.
 */

import type { HRFusionConfig } from "./sync-types";

export interface HRDataPoint {
  source: "hevy" | "garmin" | "watch";
  avgHr?: number;
  minHr?: number;
  maxHr?: number;
  confidence: number; // 0-1
  timestamp?: Date;
}

export interface FusedHRResult {
  avgHr?: number;
  minHr?: number;
  maxHr?: number;
  source: "hevy" | "garmin" | "watch";
  fusedFrom: ("hevy" | "garmin" | "watch")[];
}

/**
 * HR fusion engine — selects best HR data based on config + confidence scores.
 */
export class HRFusionEngine {
  private config: HRFusionConfig;

  constructor(config: HRFusionConfig) {
    this.config = config;
  }

  /**
   * Fuse HR data from multiple sources using fallback strategy.
   * Python: attempt_merge() uses merge_mode to pick primary + fallback.
   */
  fuse(dataPoints: HRDataPoint[]): FusedHRResult | null {
    if (!this.config.enableFusion || dataPoints.length === 0) {
      return null;
    }

    // Try each source in fallback order
    for (const fallbackSource of this.config.fallbackOrder) {
      const candidate = dataPoints.find((dp) => dp.source === fallbackSource);
      if (candidate && candidate.avgHr) {
        return {
          avgHr: candidate.avgHr,
          minHr: candidate.minHr,
          maxHr: candidate.maxHr,
          source: fallbackSource,
          fusedFrom: [fallbackSource],
        };
      }
    }

    // No valid source found
    return null;
  }

  /**
   * Score HR quality (0-1) based on source + confidence.
   * Garmin/watch data more reliable than Hevy (user-entered).
   */
  scoreHRQuality(dataPoint: HRDataPoint): number {
    const sourceWeight =
      {
        garmin: 0.9,
        watch: 0.85,
        hevy: 0.6,
      }[dataPoint.source] || 0.5;

    return Math.min(1, sourceWeight * dataPoint.confidence);
  }

  /**
   * Merge HR data from two sources (used when both are available).
   * Selects highest-confidence source, falls back to second if first insufficient.
   */
  mergeTwo(primary: HRDataPoint, fallback: HRDataPoint): FusedHRResult {
    const primaryScore = this.scoreHRQuality(primary);
    const fallbackScore = this.scoreHRQuality(fallback);

    const winner = primaryScore >= fallbackScore ? primary : fallback;
    const loser = primaryScore >= fallbackScore ? fallback : primary;

    return {
      avgHr: winner.avgHr,
      minHr: winner.minHr,
      maxHr: winner.maxHr,
      source: winner.source,
      fusedFrom: [winner.source, loser.source],
    };
  }
}

/**
 * Extract HR data from Hevy workout payload.
 * Hevy provides optional avg_hr + user's perceived exertion, not min/max.
 */
export function extractHevyHR(
  workout: Record<string, unknown>
): HRDataPoint | null {
  const avgHr = (workout.avg_hr as number) || (workout.avgHr as number);
  if (!avgHr || avgHr <= 0) return null;

  return {
    source: "hevy",
    avgHr,
    confidence: 0.7, // Hevy HR is estimated/optional; lower confidence
  };
}

/**
 * Extract HR data from Garmin activity.
 * Garmin provides detailed min/avg/max from watch recording.
 */
export function extractGarminHR(
  activity: Record<string, unknown>
): HRDataPoint | null {
  const avgHr = (activity.avgHr || activity.avg_heart_rate) as number;
  if (!avgHr) return null;

  return {
    source: "garmin",
    avgHr,
    minHr: (activity.minHr || activity.min_heart_rate) as number | undefined,
    maxHr: (activity.maxHr || activity.max_heart_rate) as number | undefined,
    confidence: 0.95, // Garmin HR from watch is authoritative
    timestamp: activity.startTime
      ? new Date(activity.startTime as string)
      : undefined,
  };
}

/**
 * Extract HR data from watch profile (typical profile HR, not per-workout).
 * Used as fallback when no real HR data available.
 */
export function extractWatchProfileHR(
  watchProfile: Record<string, unknown>
): HRDataPoint | null {
  const rhr =
    (watchProfile.restingHeartRate as number) ||
    (watchProfile.resting_hr as number);
  if (!rhr || rhr <= 0) return null;

  return {
    source: "watch",
    avgHr: rhr,
    confidence: 0.3, // Profile HR is generic, very low confidence
  };
}
