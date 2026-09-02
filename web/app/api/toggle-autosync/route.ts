import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

// Reads/writes the app_cache config at request time — never at build.
export const dynamic = "force-dynamic";

/**
 * POST /api/toggle-autosync
 * Body: { enabled?: boolean }
 *
 * Flips (or sets, when `enabled` is given) the scheduled-sync switch, stored as
 * app_cache 'auto_sync'.enabled — the same value the settings form edits. The
 * interval and any other keys are preserved. DB-only; mirrors the Python
 * /api/toggle-autosync.
 */
export async function POST(request: Request) {
  let body: { enabled?: unknown } = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  let sql: ReturnType<typeof getDb>;
  try {
    sql = getDb();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: `DB unavailable: ${error}` }, { status: 503 });
  }

  try {
    const rows = (await sql`
      SELECT value FROM app_cache WHERE key = 'auto_sync' LIMIT 1
    `) as Array<{ value: unknown }>;
    const current =
      rows[0]?.value && typeof rows[0].value === "object"
        ? (rows[0].value as Record<string, unknown>)
        : {};
    const enabled =
      typeof body.enabled === "boolean" ? body.enabled : !Boolean(current.enabled);
    const next = { ...current, enabled };
    await sql`
      INSERT INTO app_cache (key, value, updated_at)
      VALUES ('auto_sync', ${sql.json(next)}, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `;
    return NextResponse.json({ ok: true, enabled });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }
}
