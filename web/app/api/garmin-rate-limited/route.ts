import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BASE_SECONDS = 2 * 60 * 60; // first cooldown: 2 hours
const MAX_SECONDS = 24 * 60 * 60; // cap at 24 hours
const RATELIMIT_KEY = "garmin_ratelimit";

/**
 * POST /api/garmin-rate-limited
 *
 * Record that Garmin rate-limited a sign-in/upload, so the app backs off before
 * retrying. State is app_cache 'garmin_ratelimit' { until, hits, seconds } with
 * an exponential backoff (2h → 4h → … → 24h cap). Mirrors Python
 * record_rate_limit() / POST /api/garmin-rate-limited. Returns the cooldown.
 */
export async function POST() {
  let sql: ReturnType<typeof getDb>;
  try {
    sql = getDb();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: `DB unavailable: ${error}` }, { status: 503 });
  }

  try {
    const rows = (await sql`SELECT value FROM app_cache WHERE key = ${RATELIMIT_KEY} LIMIT 1`) as Array<{
      value: unknown;
    }>;
    const cur = rows[0]?.value && typeof rows[0].value === "object" ? (rows[0].value as Record<string, unknown>) : {};
    const hits = Number(cur.hits ?? 0) + 1;
    const seconds = Math.min(BASE_SECONDS * 2 ** (hits - 1), MAX_SECONDS);
    const until = new Date(Date.now() + seconds * 1000).toISOString();
    await sql`
      INSERT INTO app_cache (key, value, updated_at)
      VALUES (${RATELIMIT_KEY}, ${sql.json({ until, hits, seconds })}, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `;
    return NextResponse.json({ ok: true, cooldown_seconds: seconds });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }
}
