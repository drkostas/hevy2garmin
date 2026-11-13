import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ledgerSql } from "@/lib/test-ledger-sql";

const db = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock("@/lib/db", () => ({ getDb: () => db.sql }));
// The page calls connection() off demo to force a dynamic render; it throws
// outside a request scope, so stub it to a no-op for this unit render.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => {},
}));

import HistoryPage from "./page";

/** The History page keeps a resynced row's sync date and notes the resync (#709). */
const row = (over: Record<string, unknown> = {}) => ({
  hevy_id: "w1",
  title: "Push",
  synced_at: new Date("2026-10-07T10:56:00Z"),
  resynced_at: null,
  calories: 300,
  avg_hr: 120,
  garmin_activity_id: "4242",
  status: "success",
  ...over,
});
let queries: string[];
function withRows(rows: Array<Record<string, unknown>>) {
  const l = ledgerSql(rows);
  db.sql = l.sql;
  queries = l.queries;
}
const render = async () => renderToStaticMarkup(await HistoryPage());

beforeEach(() => withRows([row()]));

describe("History: resynced", () => {
  it("selects resynced_at and still orders by synced_at", async () => {
    await render();
    const select = queries.find((q) => q.includes("hevy_id, title"))!;
    expect(select).toMatch(/resynced_at/);
    expect(select).toMatch(/ORDER BY synced_at DESC/);
  });

  it("no note on a row that was never resynced", async () => {
    expect(await render()).not.toMatch(/resynced/);
  });

  it("notes the resync under the original sync date", async () => {
    withRows([row({ resynced_at: new Date("2026-10-09T14:52:00Z") })]);
    const html = await render();
    expect(html).toMatch(/resynced/);
    expect(html).toMatch(/2026/);
    expect(html.indexOf("Oct 7")).toBeLessThan(html.indexOf("resynced"));
  });
});
