/**
 * Strength-training FIT generation — TS port of hevy2garmin fit.py::generate_fit.
 * Uses the official @garmin/fitsdk encoder (Phase-0 ST2 proved Garmin accepts its output).
 */
import { Encoder, Profile } from "@garmin/fitsdk";
import { lookupExercise, type CustomMappings } from "./mapper";

const M = Profile.MesgNum;
const MIN_SCALE = 0.3;
const MAX_SCALE = 2.0;
export const DEFAULT_HR_BPM = 90;

// FIT date_time epoch: 1989-12-31 00:00:00 UTC, in Unix seconds. The activity
// localTimestamp field is a plain uint32 of seconds-since-this-epoch in local
// wall-clock time (the SDK takes it as a number, not a Date like timestamp).
export const FIT_EPOCH_S = 631065600;

export interface FitProfile {
  weightKg: number;
  birthYear: number;
  vo2max: number;
  workingSetS: number;
  warmupSetS: number;
  restSetsS: number;
  restExercisesS: number;
  /** Optional IANA zone (e.g. "Europe/Berlin"). Empty = no local_timestamp. */
  timezone: string;
}
export const DEFAULT_PROFILE: FitProfile = {
  weightKg: 80.0, birthYear: 1990, vo2max: 45.0,
  workingSetS: 40, warmupSetS: 25, restSetsS: 75, restExercisesS: 120,
  timezone: "",
};

/**
 * UTC offset (seconds) for an IANA zone at a given instant, DST-correct.
 * Returns null for an empty or unrecognised zone — a bad timezone must never
 * crash a sync, it just means no local_timestamp is written. Uses Intl (no
 * zoneinfo in JS): format the instant in the zone, read it back as if UTC,
 * and diff against the real instant.
 */
export function tzOffsetSeconds(tz: string, at: Date): number | null {
  if (!tz) return null;
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const p = Object.fromEntries(dtf.formatToParts(at).map((x) => [x.type, x.value]));
    const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    return Math.round((asUTC - at.getTime()) / 1000);
  } catch {
    return null; // invalid IANA name → RangeError
  }
}

export interface HevySet {
  type?: string; reps?: number | null; weight_kg?: number | null;
  duration_seconds?: number | null; distance_meters?: number | null;
}
export interface HevyExercise { title: string; exercise_template_id?: string | null; sets: HevySet[]; }
export interface HevyWorkout { title?: string; start_time?: string; end_time?: string; exercises: HevyExercise[]; }
export type HrSample = number | { time?: number; hr: number };

export interface FitResult {
  fit: Uint8Array;
  exercises: number; total_sets: number; hr_samples: number;
  calories: number; avg_hr: number | null; duration_s: number;
}

function parseTs(raw?: string | null): Date | null {
  if (!raw || typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  const iso = s.includes("T") ? s.replace("Z", "+00:00") : s.replace(" ", "T") + "Z";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

/** Keytel-with-VO2max calorie estimate, summed over evenly-spaced HR samples. */
export function calcCalories(hrBpm: number[], durationS: number, workoutYear: number, p: FitProfile): number {
  const age = workoutYear - p.birthYear;
  const samples = hrBpm.length ? hrBpm : [DEFAULT_HR_BPM];
  const intervalMin = durationS / samples.length / 60.0;
  let total = 0;
  for (const hr of samples) {
    const kcalPerMin = (-95.7735 + 0.634 * hr + 0.404 * p.vo2max + 0.394 * p.weightKg + 0.271 * age) / 4.184;
    total += Math.max(0, kcalPerMin) * intervalMin;
  }
  return Math.round(total);
}

export function generateFit(
  workout: HevyWorkout,
  hrSamples: HrSample[] | null,
  opts: { profile?: Partial<FitProfile>; custom?: CustomMappings } = {},
): FitResult {
  const p: FitProfile = { ...DEFAULT_PROFILE, ...opts.profile };

  // Normalize HR: bpm ints (even distribution) or {time,hr} (real offsets).
  let hrTimed: Array<[number, number]> | null = null;
  let hrBpm: number[] = [];
  if (hrSamples && hrSamples.length) {
    if (typeof hrSamples[0] === "object") {
      hrTimed = (hrSamples as Array<{ time?: number; hr: number }>)
        .filter((s) => s.hr != null)
        .map((s) => [Math.max(0, s.time ?? 0), Math.round(s.hr)] as [number, number]);
      hrBpm = hrTimed.map(([, b]) => b);
    } else {
      hrBpm = (hrSamples as number[]).map((x) => Math.round(x));
    }
  }

  const startDt = parseTs(workout.start_time);
  const endDt = parseTs(workout.end_time);
  if (!startDt || !endDt) {
    throw new Error(`Workout '${workout.title ?? "?"}' missing valid start/end time`);
  }
  const durationS = (endDt.getTime() - startDt.getTime()) / 1000;
  const endMs = startDt.getTime() + Math.round(durationS * 1000);
  const workoutYear = startDt.getUTCFullYear();
  const calories = calcCalories(hrBpm, durationS, workoutYear, p);

  const exercises = workout.exercises ?? [];
  let totalDistanceM = 0;

  // Flatten sets with durations + rest.
  interface SetInfo { exIdx: number; set: HevySet; setDur: number; restDur: number; startOffsetS: number; endOffsetS: number; }
  const allSets: SetInfo[] = [];
  exercises.forEach((ex, exIdx) => {
    const sets = ex.sets ?? [];
    sets.forEach((s, sIdx) => {
      const isWarmup = (s.type ?? "normal") === "warmup";
      const explicit = s.duration_seconds;
      const setDur = explicit && explicit > 0 ? Number(explicit) : isWarmup ? p.warmupSetS : p.workingSetS;
      const isLastSet = sIdx === sets.length - 1;
      const isLastEx = exIdx === exercises.length - 1;
      const restDur = isLastSet && isLastEx ? 0 : isLastSet ? p.restExercisesS : p.restSetsS;
      allSets.push({ exIdx, set: s, setDur, restDur, startOffsetS: 0, endOffsetS: 0 });
    });
  });
  const totalSets = allSets.length;

  // Scale timing to fit the real workout duration.
  const idealTotal = allSets.reduce((a, si) => a + si.setDur + si.restDur, 0);
  const scale = idealTotal > 0 ? Math.max(MIN_SCALE, Math.min(MAX_SCALE, durationS / idealTotal)) : 1.0;
  let cursor = 0;
  for (const si of allSets) {
    si.startOffsetS = cursor;
    si.endOffsetS = cursor + si.setDur * scale;
    cursor = si.endOffsetS + si.restDur * scale;
  }

  const enc = new Encoder();
  // SDK runtime accepts flat {mesgNum,...fields} (ST2-proven); its TS types are stricter, so cast.
  const wm = (m: Record<string, unknown>) => (enc.writeMesg as (x: unknown) => void)(m);
  wm({ mesgNum: M.FILE_ID, type: "activity", manufacturer: "development", serialNumber: 12345, timeCreated: startDt });
  wm({ mesgNum: M.SPORT, sport: "training", subSport: "strengthTraining" });

  exercises.forEach((ex, exIdx) => {
    const { category, subcategory, displayName } = lookupExercise(ex.title, ex.exercise_template_id, opts.custom);
    wm({ mesgNum: M.EXERCISE_TITLE, messageIndex: exIdx, exerciseCategory: category, exerciseName: subcategory, wktStepName: displayName });
  });

  wm({ mesgNum: M.EVENT, timestamp: startDt, event: "timer", eventType: "start" });

  // Timeline: HR records + set messages, chronological (records before sets at same ms).
  type Item = { ms: number; kind: 0 | 1; mesg: Record<string, unknown> };
  const timeline: Item[] = [];
  if (hrTimed) {
    for (const [off, hr] of hrTimed) {
      const ms = startDt.getTime() + Math.round(off * 1000);
      timeline.push({ ms, kind: 0, mesg: { mesgNum: M.RECORD, timestamp: new Date(ms), heartRate: hr } });
    }
  } else if (hrBpm.length) {
    const stepMs = hrBpm.length > 1 ? Math.round((durationS * 1000) / (hrBpm.length - 1)) : 0;
    hrBpm.forEach((hr, i) => {
      const ms = startDt.getTime() + (hrBpm.length > 1 ? i * stepMs : 0);
      timeline.push({ ms, kind: 0, mesg: { mesgNum: M.RECORD, timestamp: new Date(ms), heartRate: hr } });
    });
  }

  let msgIndex = 0;
  for (const si of allSets) {
    const { category, subcategory } = lookupExercise(exercises[si.exIdx].title, exercises[si.exIdx].exercise_template_id, opts.custom);
    const setStartMs = startDt.getTime() + Math.round(si.startOffsetS * 1000);
    const setEndMs = startDt.getTime() + Math.round(si.endOffsetS * 1000);
    const active: Record<string, unknown> = {
      mesgNum: M.SET, timestamp: new Date(setEndMs), startTime: new Date(setStartMs),
      duration: si.endOffsetS - si.startOffsetS, setType: "active",
      category: [category], categorySubtype: [subcategory], messageIndex: msgIndex, wktStepIndex: si.exIdx,
    };
    if (si.set.reps != null) active.repetitions = Math.round(Number(si.set.reps));
    if (si.set.weight_kg != null) active.weight = Math.max(0, Number(si.set.weight_kg));
    const dist = si.set.distance_meters;
    if (dist != null && Number(dist) > 0) {
      totalDistanceM += Number(dist);
      timeline.push({ ms: setEndMs, kind: 0, mesg: { mesgNum: M.RECORD, timestamp: new Date(setEndMs), distance: Number(dist) } });
    }
    timeline.push({ ms: setEndMs, kind: 1, mesg: active });
    msgIndex++;

    if (si.restDur > 0) {
      const restEndMs = setEndMs + Math.round(si.restDur * scale * 1000);
      timeline.push({ ms: restEndMs, kind: 1, mesg: {
        mesgNum: M.SET, timestamp: new Date(restEndMs), startTime: new Date(setEndMs),
        duration: si.restDur * scale, setType: "rest", messageIndex: msgIndex, wktStepIndex: si.exIdx,
      } });
      msgIndex++;
    }
  }
  timeline.sort((a, b) => a.ms - b.ms || a.kind - b.kind);
  for (const it of timeline) wm(it.mesg);

  wm({ mesgNum: M.EVENT, timestamp: new Date(endMs), event: "timer", eventType: "stopAll" });

  const avgHr = hrBpm.length ? Math.round(hrBpm.reduce((a, b) => a + b, 0) / hrBpm.length) : null;
  const maxHr = hrBpm.length ? Math.max(...hrBpm) : null;
  const lap: Record<string, unknown> = {
    mesgNum: M.LAP, timestamp: new Date(endMs), startTime: startDt, totalElapsedTime: durationS, totalTimerTime: durationS,
    sport: "training", subSport: "strengthTraining", messageIndex: 0, event: "lap", eventType: "stop", totalCalories: calories,
  };
  const session: Record<string, unknown> = {
    mesgNum: M.SESSION, timestamp: new Date(endMs), startTime: startDt, totalElapsedTime: durationS, totalTimerTime: durationS,
    sport: "training", subSport: "strengthTraining", messageIndex: 0, firstLapIndex: 0, numLaps: 1,
    event: "lap", eventType: "stop", totalCalories: calories,
  };
  if (avgHr != null) { lap.avgHeartRate = avgHr; lap.maxHeartRate = maxHr; session.avgHeartRate = avgHr; session.maxHeartRate = maxHr; }
  if (totalDistanceM > 0) { lap.totalDistance = totalDistanceM; session.totalDistance = totalDistanceM; }
  wm(lap);
  wm(session);
  const activity: Record<string, unknown> = {
    mesgNum: M.ACTIVITY, timestamp: new Date(endMs), totalTimerTime: durationS,
    numSessions: 1, type: "manual", event: "activity", eventType: "stop",
  };
  // Stamp local wall-clock time when a timezone is configured. Hevy gives us
  // UTC only, so without this the activity carries no offset and Garmin can
  // forward it to Strava as raw UTC (a 6am workout showing up as 3am). The SDK
  // takes localTimestamp as a number of FIT-epoch seconds, not a Date.
  const tzOffset = tzOffsetSeconds(p.timezone ?? "", startDt);
  if (tzOffset != null) activity.localTimestamp = Math.round(endMs / 1000) + tzOffset - FIT_EPOCH_S;
  wm(activity);

  return {
    fit: new Uint8Array(enc.close()),
    exercises: exercises.length, total_sets: totalSets, hr_samples: hrBpm.length,
    calories, avg_hr: avgHr, duration_s: durationS,
  };
}
