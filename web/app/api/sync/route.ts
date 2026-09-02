import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { syncOneWorkout, type SyncOneResult } from "@/lib/sync-one";
import { getDb } from "@/lib/db";
import { verifySession, SESSION_COOKIE, authEnabled } from "@/lib/auth";

// Reads live Hevy + Postgres (and, on the live path, Garmin) at request time.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/sync  —  batch sync of ALL candidates. DRY-RUN BY DEFAULT.
 *
 * Mirrors the Python dashboard's /api/sync:
 *   - dry-run (default): reports how many workouts WOULD sync, plus a preview of
 *     the next one — no upload, no DB write.
 *   - live (requires ?live=1 AND authorization): if GITHUB_PAT + GITHUB_REPO are
 *     set, triggers the sync GitHub Action via repository_dispatch (the deployed
 *     path — avoids the Vercel function timeout + browser-auth constraints);
 *     otherwise loops the tested single-workout engine (syncOneWorkout) up to a
 *     safety cap, aggregating the per-workout results.
 *
 * A live upload fires only when BOTH the request asks for it (?live=1 / body
 * {live}) AND is authorized (h2g session cookie OR Bearer CRON_SECRET) — the
 * same gate as /api/sync-one.
 */

const CAP = 50; // never loop the inline engine more than this many times

async function isAuthorized(request: Request): Promise<boolean> {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization") ?? "";
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m && m[1] === cronSecret) return true;
  }
  if (!authEnabled()) return true;
  const store = await cookies();
  const cookie = store.get(SESSION_COOKIE)?.value ?? null;
  return verifySession(cookie);
}

function wantsLive(request: Request, body: Record<string, unknown>): boolean {
  const q = new URL(request.url).searchParams.get("live");
  if (q === "1" || q === "true") return true;
  const b = body.live;
  return b === 1 || b === true || b === "1" || b === "true";
}

async function triggerViaActions(pat: string, repo: string): Promise<boolean> {
  const res = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ event_type: "sync-trigger" }),
  });
  return res.ok;
}

export async function POST(request: Request) {
  let body: Record<string, unknown> = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const requestedLive = wantsLive(request, body);
  const authorized = requestedLive ? await isAuthorized(request) : false;
  const dryRun = !(requestedLive && authorized);

  if (requestedLive && !authorized) {
    return NextResponse.json(
      { error: "Unauthorized: a live batch sync requires a session or CRON_SECRET." },
      { status: 401 },
    );
  }

  let sql: ReturnType<typeof getDb>;
  try {
    sql = getDb();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `DB unavailable: ${error}` }, { status: 503 });
  }

  // Dry-run: a single read pass tells us how many candidates would sync.
  if (dryRun) {
    try {
      const preview = await syncOneWorkout(sql, { dryRun: true });
      return NextResponse.json({
        dryRun: true,
        mode: "preview",
        candidates: preview.status === "none" ? 0 : preview.remaining,
        preview,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ error }, { status: 500 });
    }
  }

  // Live, deployed: hand off to the GitHub Action so the long browser-auth sync
  // runs off the request path.
  const pat = process.env.GITHUB_PAT;
  const repo = process.env.GITHUB_REPO;
  if (pat && repo) {
    try {
      const ok = await triggerViaActions(pat, repo);
      if (!ok) {
        return NextResponse.json(
          { error: "Failed to trigger the sync workflow." },
          { status: 502 },
        );
      }
      return NextResponse.json({ dryRun: false, mode: "dispatch", triggered: true });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ error }, { status: 502 });
    }
  }

  // Live, local/self-hosted: loop the tested single-workout engine.
  const runs: SyncOneResult[] = [];
  try {
    for (let i = 0; i < CAP; i++) {
      const r = await syncOneWorkout(sql, { dryRun: false });
      if (r.status === "none") break; // no candidates left
      runs.push(r);
      if (r.status === "error") break; // stop the batch on a hard error
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error, runs }, { status: 500 });
  }

  const totalSynced = runs.filter((r) => r.status === "synced").length;
  const totalSkipped = runs.filter((r) => r.status === "skipped").length;
  const totalDeferred = runs.filter((r) => r.status === "deferred").length;
  const totalError = runs.filter((r) => r.status === "error").length;

  return NextResponse.json({
    dryRun: false,
    mode: "inline",
    ran: runs.length,
    totalSynced,
    totalSkipped,
    totalDeferred,
    totalError,
    runs,
  });
}
