import { NextResponse } from "next/server";
import { unsyncAll } from "@/lib/pending-store";
import { getDb } from "@/lib/db";
import { demoMode } from "@/lib/demo";

// Deletes from the app's own synced_workouts table at request time — never at build.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/unsync-all
 * Body: { confirm: "RESET" }
 *
 * Clears every terminal synced_workouts row so all workouts become sync
 * candidates again. DB-ONLY: it does NOT delete any Garmin activity (same
 * boundary as single /api/unsync). Mirrors the Python /api/unsync-all:
 * refuses in demo mode (403), requires confirm=RESET (400), and clears the
 * cached Hevy workout pages so the reset shows immediately. Session-gating is
 * handled by the proxy (all /api/* except the public login routes).
 */
export async function POST(request: Request) {
  if (demoMode()) {
    return NextResponse.json({ ok: false, error: "Read-only in demo mode" }, { status: 403 });
  }

  let confirm = "";
  try {
    const text = await request.text();
    if (text) confirm = String((JSON.parse(text) as { confirm?: unknown }).confirm ?? "");
  } catch {
    confirm = "";
  }
  if (confirm !== "RESET") {
    return NextResponse.json({ ok: false, error: "Send confirm=RESET to proceed" }, { status: 400 });
  }

  let count: number;
  try {
    count = await unsyncAll();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }

  // Clear cached Hevy workout pages so the reset is reflected on next load.
  try {
    const sql = getDb();
    for (let page = 1; page <= 10; page++) {
      await sql`
        INSERT INTO app_cache (key, value, updated_at)
        VALUES (${`hevy_workouts_page_${page}`}, ${sql.json({})}, NOW())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `;
    }
  } catch {
    /* best-effort cache clear; the unsync already succeeded */
  }

  return NextResponse.json({ ok: true, count });
}
