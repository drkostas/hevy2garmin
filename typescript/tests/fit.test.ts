import { describe, it, expect } from "vitest";
import { generateFit } from "../src/fit";
import { lookupExercise } from "../src/mapper";
import { Decoder, Stream } from "@garmin/fitsdk";
import workout from "./fixtures/workout.json";

describe("generateFit — Python parity + valid FIT", () => {
  it("matches Python fit.py stats and produces a decodable FIT", () => {
    const r = generateFit(workout as any, [110, 115, 120, 118, 122, 119]);
    // Python-verified stats
    expect(r.exercises).toBe(3);
    expect(r.total_sets).toBe(10);
    expect(r.calories).toBe(622);
    expect(r.avg_hr).toBe(117);
    expect(r.duration_s).toBe(4102);
    // Valid Garmin FIT
    const stream = Stream.fromByteArray(Buffer.from(r.fit));
    expect(Decoder.isFIT(stream)).toBe(true);
    const dec = new Decoder(stream);
    expect(dec.checkIntegrity()).toBe(true);
    const { messages, errors } = dec.read();
    expect(errors.length).toBe(0);
    expect(messages.setMesgs.length).toBe(19); // 10 active + 9 rest
    expect(messages.sessionMesgs[0].totalCalories).toBe(622);
    expect(messages.sessionMesgs[0].subSport).toBe("strengthTraining");
    expect(messages.exerciseTitleMesgs.length).toBe(3);
  });
});

describe("lookupExercise — exercise map", () => {
  it("resolves template-id + name; sentinel for unknown", () => {
    expect(lookupExercise("Incline Bench Press (Dumbbell)", "07B38369").category).not.toBe(65534);
    expect(lookupExercise("Totally Made Up Exercise", null).category).toBe(65534);
  });
});

describe("generateFit — training load (hevy2garmin#523)", () => {
  const readSession = (fit: Uint8Array) => {
    const { messages } = new Decoder(Stream.fromByteArray(Buffer.from(fit))).read();
    return messages.sessionMesgs[0] as Record<string, unknown>;
  };
  it("writes training_load_peak only when asked", () => {
    const off = generateFit(workout as any, null);
    expect(readSession(off.fit).trainingLoadPeak).toBeUndefined();
    const on = generateFit(workout as any, null, { trainingLoad: 87.5 });
    expect(readSession(on.fit).trainingLoadPeak).toBeCloseTo(87.5, 1);
  });
  it("ignores a non-positive load", () => {
    expect(readSession(generateFit(workout as any, null, { trainingLoad: 0 }).fit).trainingLoadPeak).toBeUndefined();
  });
});
