import { describe, it, expect } from "vitest";
import {
  agoIso,
  demoDashboard,
  demoStatus,
  demoHistory,
  demoWorkouts,
  demoMappings,
  demoSettings,
  demoSetup,
} from "./demo-data";

const DAY = 86_400_000;

describe("agoIso", () => {
  it("returns a timestamp the given number of days before now", () => {
    const delta = Date.now() - new Date(agoIso(3)).getTime();
    expect(delta).toBeGreaterThan(3 * DAY - 60_000);
    expect(delta).toBeLessThan(3 * DAY + 60_000);
  });
});

describe("demo data reads as current whenever it is read", () => {
  it("the newest dashboard workout is within two days of now", () => {
    const d = demoDashboard();
    const newest = Math.min(
      ...d.recent.map((r) => Date.now() - new Date(r.synced_at!).getTime()),
    );
    expect(newest).toBeLessThan(2 * DAY);
  });

  it("dashboard counts match the seed and the week is never empty", () => {
    const d = demoDashboard();
    expect(d.totalSynced).toBe(25);
    expect(d.syncedThisWeek).toBe(6);
    expect(d.recent).toHaveLength(10);
    expect(d.syncLog).toHaveLength(10);
    expect(d.hevyConnected).toBe(true);
    expect(d.garminConnected).toBe(true);
  });

  it("status holds 8 recent and a non-zero week", () => {
    const s = demoStatus();
    expect(s.recent).toHaveLength(8);
    expect(s.totalSynced).toBe(25);
    expect(s.syncedThisWeek).toBeGreaterThan(0);
  });

  it("history holds all 25 rows, newest first", () => {
    const h = demoHistory();
    expect(h.total).toBe(25);
    expect(h.rows).toHaveLength(25);
    const times = h.rows.map((r) => new Date(r.synced_at!).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("every workout item is terminal", () => {
    const w = demoWorkouts();
    expect(w.items).toHaveLength(25);
    expect(w.items.every((i) => i.kind === "terminal")).toBe(true);
  });

  it("mappings are the five custom rows, sorted by name", () => {
    const m = demoMappings();
    expect(m).toHaveLength(5);
    expect(m[0].hevy_name).toBe("Cable Lateral Raise");
  });

  it("settings shows both platforms active with config", () => {
    const s = demoSettings();
    expect(s.platforms.map((p) => p.platform)).toEqual(["garmin", "hevy"]);
    expect(s.platforms.every((p) => p.status === "active")).toBe(true);
    expect(s.config.length).toBeGreaterThanOrEqual(4);
    expect(s.syncedCount).toBe(25);
  });

  it("setup reads as connected", () => {
    const s = demoSetup();
    expect(s.hevy.connected).toBe(true);
    expect(s.garmin.connected).toBe(true);
  });
});
