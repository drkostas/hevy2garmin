import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Simulate a deployment with no DATABASE_URL: getDb throws exactly as lib/db
// does when no connection string is configured. A demo read path that still
// opened the database would throw here and fail the test, rather than the live
// site.
import { vi } from "vitest";
vi.mock("@/lib/db", () => ({
  getDb: () => {
    throw new Error("No Postgres connection string.");
  },
}));

// The data pages include interactive client components that read the Next
// router. In demo mode they render read-only, so give them a router whose
// methods do nothing, the same way the other page render tests here do.
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: () => {},
    replace: () => {},
    refresh: () => {},
    back: () => {},
    forward: () => {},
    prefetch: () => {},
  }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

import DashboardPage from "./dashboard/page";
import HistoryPage from "./history/page";
import WorkoutsPage from "./workouts/page";
import MappingsPage from "./mappings/page";
import SettingsPage from "./settings/page";
import SetupPage from "./setup/page";
import { GET as statusGET } from "./api/hevy/status/route";
import { GET as cronGET } from "./api/cron/sync/route";
import { GET as unmappedGET } from "./api/unmapped-exercises/route";

const previousDemo = process.env.DEMO_MODE;
beforeEach(() => {
  process.env.DEMO_MODE = "true";
});
afterEach(() => {
  process.env.DEMO_MODE = previousDemo;
});

describe("demo mode renders every data page with no database", () => {
  it("dashboard shows synced workouts, not the empty or no-database state", async () => {
    const html = renderToStaticMarkup(await DashboardPage());
    expect(html).toContain("Push Day A");
    expect(html).not.toContain("No database is configured");
    expect(html).not.toContain("No synced workouts yet");
  });

  it("history lists the workouts", async () => {
    const html = renderToStaticMarkup(await HistoryPage());
    expect(html).toContain("Push Day A");
    expect(html).not.toContain("No workouts synced yet");
    expect(html).not.toContain("No database is configured");
  });

  it("workouts lists the terminal workouts", async () => {
    const html = renderToStaticMarkup(await WorkoutsPage());
    expect(html).toContain("Push Day A");
    expect(html).not.toContain("No database is configured");
  });

  it("mappings shows the custom mappings", async () => {
    const html = renderToStaticMarkup(await MappingsPage());
    expect(html).toContain("Cable Lateral Raise");
    expect(html).not.toContain("No database is configured");
  });

  it("settings shows the connections and config", async () => {
    const html = renderToStaticMarkup(await SettingsPage());
    expect(html).toContain("garmin");
    expect(html).toContain("hevy");
    expect(html).not.toContain("No database is configured");
  });

  it("setup reads as connected", async () => {
    const html = renderToStaticMarkup(await SetupPage());
    const connected = (html.match(/Connected/g) ?? []).length;
    expect(connected).toBeGreaterThanOrEqual(2);
  });
});

describe("demo endpoints with no database", () => {
  it("status returns populated counts", async () => {
    const res = await statusGET();
    const body = (await res.json()) as {
      totalSynced: number;
      syncedThisWeek: number;
      recent: unknown[];
      hevyConnected: boolean;
    };
    expect(body.totalSynced).toBe(25);
    expect(body.syncedThisWeek).toBe(6);
    expect(body.recent).toHaveLength(8);
    expect(body.hevyConnected).toBe(true);
  });

  it("the daily cron is a no-op in demo mode", async () => {
    const req = new Request("https://example.test/api/cron/sync", {
      headers: { authorization: "Bearer test-secret" },
    });
    process.env.CRON_SECRET = "test-secret";
    const res = await cronGET(req);
    const body = (await res.json()) as { ok: boolean; mode: string };
    expect(res.status).toBe(200);
    expect(body.mode).toBe("demo");
    delete process.env.CRON_SECRET;
  });

  it("unmapped-exercises answers empty without calling the Hevy API", async () => {
    const res = await unmappedGET();
    const body = (await res.json()) as { unmapped: unknown[]; total: number };
    expect(res.status).toBe(200);
    expect(body.unmapped).toEqual([]);
    expect(body.total).toBe(0);
  });
});
