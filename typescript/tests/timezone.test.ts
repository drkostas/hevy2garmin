import { describe, it, expect } from "vitest";
import { generateFit, tzOffsetSeconds, FIT_EPOCH_S } from "../src/fit";
import { Decoder, Stream } from "@garmin/fitsdk";

function workout(startIso: string, endIso: string) {
  return {
    id: "tz-test",
    title: "Push",
    start_time: startIso,
    end_time: endIso,
    exercises: [
      {
        index: 0,
        title: "Bench Press (Barbell)",
        exercise_template_id: "79D0BB3A",
        sets: [{ index: 0, type: "normal", weight_kg: 60, reps: 5 }],
      },
    ],
  };
}

function activityMesg(fit: Uint8Array): any {
  const { messages } = new Decoder(Stream.fromByteArray(Buffer.from(fit))).read();
  return messages.activityMesgs[0];
}

/** UTC offset (seconds) implied by localTimestamp vs the UTC timestamp. */
function embeddedOffset(a: any): number {
  const tsUnixS = Math.round((a.timestamp as Date).getTime() / 1000);
  return (a.localTimestamp as number) - (tsUnixS - FIT_EPOCH_S);
}

describe("tzOffsetSeconds", () => {
  const summer = new Date(Date.UTC(2026, 6, 1));
  const winter = new Date(Date.UTC(2026, 0, 1));
  it("summer offset (Europe/Berlin = CEST +2h)", () => {
    expect(tzOffsetSeconds("Europe/Berlin", summer)).toBe(7200);
  });
  it("winter offset (Europe/Berlin = CET +1h) — DST aware", () => {
    expect(tzOffsetSeconds("Europe/Berlin", winter)).toBe(3600);
  });
  it("negative offset (America/New_York = EDT -4h)", () => {
    expect(tzOffsetSeconds("America/New_York", summer)).toBe(-4 * 3600);
  });
  it("empty zone → null", () => {
    expect(tzOffsetSeconds("", summer)).toBeNull();
  });
  it("invalid zone → null (no throw)", () => {
    expect(tzOffsetSeconds("Not/AZone", summer)).toBeNull();
  });
});

describe("generateFit — activity localTimestamp", () => {
  it("absent without a timezone", () => {
    const r = generateFit(workout("2026-07-01T12:00:00+00:00", "2026-07-01T12:45:00+00:00"), null);
    expect(activityMesg(r.fit).localTimestamp).toBeUndefined();
  });
  it("set with the correct summer offset", () => {
    const r = generateFit(workout("2026-07-01T12:00:00+00:00", "2026-07-01T12:45:00+00:00"), null, {
      profile: { timezone: "Europe/Berlin" },
    });
    expect(embeddedOffset(activityMesg(r.fit))).toBe(7200);
  });
  it("uses the winter offset in winter (DST aware)", () => {
    const r = generateFit(workout("2026-01-01T12:00:00+00:00", "2026-01-01T12:45:00+00:00"), null, {
      profile: { timezone: "Europe/Berlin" },
    });
    expect(embeddedOffset(activityMesg(r.fit))).toBe(3600);
  });
  it("invalid timezone is ignored (no crash, no stamp)", () => {
    const r = generateFit(workout("2026-07-01T12:00:00+00:00", "2026-07-01T12:45:00+00:00"), null, {
      profile: { timezone: "Not/AZone" },
    });
    expect(activityMesg(r.fit).localTimestamp).toBeUndefined();
  });
});
