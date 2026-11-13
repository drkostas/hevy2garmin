import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ledgerSql } from "@/lib/test-ledger-sql";

const db = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock("@/lib/db", () => ({ getDb: () => db.sql }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
// The page calls connection() off demo to force a dynamic render; it throws
// outside a request scope, so stub it to a no-op for this unit render.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => {},
}));

import WorkoutsPage from "./page";

/** The Workouts page carries resynced_at to its rows (#709). */
const row = (over: Record<string, unknown> = {}) => ({
  hevy_id: "w1",
  title: "Push",
  synced_at: new Date("2026-10-07T10:56:00Z"),
  resynced_at: null,
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
const render = async () => renderToStaticMarkup(await WorkoutsPage());

beforeEach(() => withRows([row()]));

describe("Workouts: resynced", () => {
  it("selects resynced_at and still orders by synced_at", async () => {
    await render();
    const select = queries.find((q) => q.includes("FROM synced_workouts"))!;
    expect(select).toMatch(/resynced_at/);
    expect(select).toMatch(/ORDER BY synced_at DESC/);
  });

  it("no note on a row that was never resynced", async () => {
    expect(await render()).not.toMatch(/resynced/);
  });

  it("notes the resync on a resynced row", async () => {
    withRows([row({ resynced_at: new Date("2026-10-09T14:52:00Z") })]);
    expect(await render()).toMatch(/resynced/);
  });
});
