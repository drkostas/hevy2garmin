import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

import { SettingsForm } from "./settings-form";

/** The Settings form's "Sync workout photos" toggle (#237). */
const props = (photosEnabled: boolean): Parameters<typeof SettingsForm>[0] => ({
  autoSyncEnabled: false,
  autoSyncInterval: 120,
  hrFusionEnabled: true,
  photosEnabled,
  mergeWatchStrategy: "merge",
  weightKg: null,
  birthYear: null,
  sex: null,
  vo2max: null,
  timezone: null,
  mergeMode: true,
  descriptionEnabled: true,
  mergeOverlapPct: null,
  mergeMaxDriftMin: null,
  mergeActivityTypes: ["strength_training"],
  workingSetSeconds: null,
  warmupSetSeconds: null,
  restBetweenSetsSeconds: null,
  restBetweenExercisesSeconds: null,
  syncStartDate: null,
});

/** The checkbox that belongs to the label `text`. */
function checkbox(html: string, text: string): string {
  const at = html.indexOf(`>${text}<`);
  expect(at).toBeGreaterThan(-1);
  return html.slice(at).match(/<input type="checkbox"[^>]*>/)![0];
}

describe("SettingsForm: Sync workout photos", () => {
  it("shows the toggle, on, with what it does", () => {
    const html = renderToStaticMarkup(<SettingsForm {...props(true)} />);
    expect(checkbox(html, "Sync workout photos")).toMatch(/checked=""/);
    expect(html).toContain("Videos are not synced.");
  });

  it("shows it off when the user turned it off", () => {
    const html = renderToStaticMarkup(<SettingsForm {...props(false)} />);
    expect(checkbox(html, "Sync workout photos")).not.toMatch(/checked/);
  });
});
