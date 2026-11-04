import { NextResponse } from "next/server";
import { syncOneWorkout, type SyncOneResult } from "@/lib/sync-one";
import { repeatsEarlierRun } from "@/lib/sync-progress";
import { postgresSyncStore } from "@/lib/sync-store";
import { recordSyncRun } from "hevy2garmin";
import { getDb } from "@/lib/db";
import { demoMode } from "@/lib/demo";
import { acquireSyncLock } from "hevy2garmin";
import { postgresLockBackend } from "@/lib/sync-lock-store";
import { getGithubPat, getGithubRepo, triggerViaActions } from "@/lib/github";

// Runs the sync at request time — never at build.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/cron/sync  —  the scheduled-trigger entry (Vercel cron / any
 * scheduler). Requires `Authorization: Bearer <CRON_SECRET>`. Then, like the
 * live path of POST /api/sync, it hands off to the GitHub Action when
 * GITHUB_PAT + GITHUB_REPO are set (the deployed path, off the request), or
 * loops the tested single-workout engine up to a cap. Mirrors the Python
 * /api/cron/sync.
 */

const CAP = 50;


export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!secret || !m || m[1] !== secret) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  // The public demo has no database and only placeholder credentials, so there is
  // nothing to sync. Answer without starting a database or a GitHub Action.
  if (demoMode()) {
    return NextResponse.json({ ok: true, mode: "demo", reason: "sync is disabled in demo mode" });
  }

  // Deployed path: hand off to the Action so the long browser-auth sync runs off
  // the request.
  // Settings row first, GITHUB_PAT fallback (#458). The DB handle may be unavailable here; env still works.
  let sqlForPat: ReturnType<typeof getDb> | null = null;
  try { sqlForPat = getDb(); } catch { sqlForPat = null; }
  const pat = await getGithubPat(sqlForPat);
  const repo = getGithubRepo();
  if (pat && repo) {
    try {
      const ok = await triggerViaActions(pat, repo);
      return NextResponse.json({ ok, mode: "dispatch", triggered: ok }, { status: ok ? 200 : 502 });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ ok: false, error }, { status: 502 });
    }
  }

  // Local/self-hosted path: loop the tested engine.
  let sql: ReturnType<typeof getDb>;
  try {
    sql = getDb();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: `DB unavailable: ${error}` }, { status: 503 });
  }

  // The scheduled run and a user pressing Sync are the overlap this lock is
  // actually for. Skipping when it is busy is the right answer for a cron:
  // the next tick will pick up whatever is left (#604).
  const lock = await acquireSyncLock({ backend: postgresLockBackend(sql), key: "sync" });
  if (!lock) {
    return NextResponse.json({ ok: true, mode: "skipped", reason: "another sync is running", ran: 0 });
  }

  const runs: SyncOneResult[] = [];
  const seen = new Set<string>();
  try {
    for (let i = 0; i < CAP; i++) {
      // respectGrace: nobody is watching this run, so a workout that just
      // finished can wait for the watch to upload its own activity rather than
      // becoming a second copy of the same session.
      const r = await syncOneWorkout(sql, { dryRun: false, respectGrace: true });
      if (r.status === "none") break;
      // A workout already handled in this run came back: it is still pending (deferred), so
      // nothing more will move until the next run (#723).
      if (repeatsEarlierRun(seen, r)) break;
      runs.push(r);
      // Only a hard error stops the run. One refused or unresolved workout must
      // not cancel the rest of the backlog, which is how the Python loop
      // behaves at `sync.py:822-833`.
      if (r.status === "error") break;
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error, ran: runs.length }, { status: 500 });
  } finally {
    await lock.release();
  }

  // Compared as plain strings: the engine is a separately versioned package and
  // can report statuses these pinned types do not know yet, so counting by name
  // keeps an upgrade from dropping workouts out of the tally.
  const status = (r: SyncOneResult) => r.status as string;

  const synced = runs.filter((r) => status(r) === "synced").length;
  // `processing` joins deferred and skipped: the upload may have landed, so it
  // is a workout that did not finish this run, not a failure. `failed` joins
  // the errors, because Garmin refused the import outright.
  const deferred = runs.filter(
    (r) => status(r) === "deferred" || status(r) === "skipped" || status(r) === "processing",
  ).length;
  const failed = runs.filter((r) => status(r) === "error" || status(r) === "failed").length;
  await recordSyncRun(postgresSyncStore(sql), { synced, skipped: deferred, failed }, "cron");
  return NextResponse.json({ ok: true, mode: "inline", ran: runs.length, synced });
}
