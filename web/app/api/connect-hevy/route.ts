import { NextResponse } from "next/server";
import { fetchWorkoutCount } from "@/lib/hevy-sync";
import { getDb } from "@/lib/db";

// Probes the live Hevy API and writes platform_credentials at request time.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/connect-hevy
 * Body: { key: "<hevy-api-key>" }
 *
 * Validates a Hevy API key with a read-only workout-count probe and, ONLY when
 * it is valid, upserts it into platform_credentials (platform 'hevy',
 * credentials { api_key }) so the sync engine can use it. An invalid key is
 * rejected and nothing is written. Mirrors the Python setup's Hevy step.
 */
export async function POST(request: Request) {
  let body: { key?: unknown } = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const key = typeof body.key === "string" ? body.key.trim() : "";
  if (!key) {
    return NextResponse.json({ ok: false, error: "A Hevy API key is required." }, { status: 400 });
  }

  // 1) Validate — a read-only probe. A bad key throws; nothing is written.
  let workoutCount: number;
  try {
    workoutCount = await fetchWorkoutCount(key);
  } catch {
    return NextResponse.json(
      { ok: false, valid: false, error: "That Hevy API key was rejected by Hevy." },
      { status: 200 },
    );
  }

  // 2) Valid → persist into platform_credentials.
  let sql: ReturnType<typeof getDb>;
  try {
    sql = getDb();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: `DB unavailable: ${error}` }, { status: 503 });
  }

  try {
    await sql`
      INSERT INTO platform_credentials (platform, auth_type, credentials, status, connected_at)
      VALUES ('hevy', 'api_key', ${sql.json({ api_key: key })}, 'active', NOW())
      ON CONFLICT (platform) DO UPDATE SET
        auth_type = 'api_key',
        credentials = EXCLUDED.credentials,
        status = 'active',
        connected_at = NOW()
    `;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, valid: true, error: `Could not save the key: ${error}` }, { status: 500 });
  }

  return NextResponse.json({ ok: true, valid: true, workout_count: workoutCount });
}
