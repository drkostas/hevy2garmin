import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { syncOneWorkout, type SyncOneResult } from "@/lib/sync-one";
import { repeatsEarlierRun } from "@/lib/sync-progress";
import { postgresSyncStore } from "@/lib/sync-store";
import { recordSyncRun } from "hevy2garmin";
import { getDb } from "@/lib/db";
import { acquireSyncLock } from "hevy2garmin";
import { postgresLockBackend } from "@/lib/sync-lock-store";
import { detectDuplicates, garminClient } from "@/lib/garmin-activities";
import { getHevyClient } from "@/lib/hevy-sync";
import { getGithubPat, getGithubRepo, triggerViaActions } from "@/lib/github";
import { verifySession, SESSION_COOKIE, authEnabled } from "@/lib/auth";
import { isDefaultProfile } from "@/lib/profile-context";

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
  // runs off the request path. The Action syncs only the default profile, so an
  // added profile always syncs inline, even if it saved a GitHub token of its own.
  const pat = (await isDefaultProfile()) ? await getGithubPat(sql) : null;   // Settings row first, GITHUB_PAT fallback (#458)
  const repo = getGithubRepo();
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

  // Take the sync lock for the whole batch. The engine has shipped one since
  // #570 and nothing called it, so this route, the cron route and the
  // dashboard's per-workout loop could all run at once, each spending
  // rate-limited Garmin calls on the same backlog (#604).
  //
  // The lock is a courtesy, not a correctness guarantee: `claimPending` is
  // still what makes a double upload impossible. So a lock we cannot take
  // reports "already running" rather than failing, and a lock we cannot
  // release expires on its own.
  const lock = await acquireSyncLock({
    backend: postgresLockBackend(sql),
    key: "sync",
  });
  if (!lock) {
    return NextResponse.json(
      { error: "A sync is already running. Wait for it to finish, or try again in a few minutes.", runs: [] },
      { status: 409 },
    );
  }

  // Live, local/self-hosted: loop the tested single-workout engine.
  const runs: SyncOneResult[] = [];
  const seen = new Set<string>();
  try {
    for (let i = 0; i < CAP; i++) {
      const r = await syncOneWorkout(sql, { dryRun: false });
      if (r.status === "none") break; // no candidates left
      // A workout already handled in this run came back: it is still pending (deferred), so
      // nothing more will move until the next run (#723).
      if (repeatsEarlierRun(seen, r)) break;
      runs.push(r);
      // Only a hard error stops the batch. A refused import (`failed`) or an
      // unknown outcome (`processing`) is about that one workout, so the run
      // carries on and counts it, the way the Python loop does at
      // `sync.py:822-833`. Stopping on those would let one bad FIT cancel the
      // rest of the backlog.
      if (r.status === "error") break;
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error, runs }, { status: 500 });
  } finally {
    await lock.release();
  }

  // Scan for duplicate activities left by past races, the way Python does at
  // the end of every real run (`sync.py:868-881`). It was only reachable from
  // a button in Settings, so a user with a duplicate pair had no way to learn
  // about it unless they went looking (#608). Log-only: nothing is deleted.
  let duplicates = 0;
  try {
    const hevy = await getHevyClient();
    const raw = (await hevy.getAllWorkouts()) as Array<Record<string, unknown>>;
    const windows = raw.slice(0, 50).map((w) => ({
      id: String(w.id),
      title: (w.title as string | null) ?? null,
      start_time: (w.start_time as string | null) ?? null,
      end_time: (w.end_time as string | null) ?? null,
    }));
    duplicates = (await detectDuplicates(await garminClient(), windows)).length;
  } catch {
    // Best-effort, exactly as in Python: a failed scan must never break a sync
    // that already succeeded.
  }

  // Compared as plain strings on purpose. The engine is a separate npm package
  // on its own release cycle, so this route can be running against a version
  // that reports statuses these pinned types have never heard of. Counting them
  // by name means an engine upgrade cannot silently drop a workout out of every
  // tally, which is what happened when `failed` and `processing` were added.
  const status = (r: SyncOneResult) => r.status as string;

  const totalSynced = runs.filter((r) => status(r) === "synced").length;
  const totalSkipped = runs.filter((r) => status(r) === "skipped").length;
  const totalDeferred = runs.filter((r) => status(r) === "deferred").length;
  // `failed` counts with `error`: Garmin refused the import and the workout
  // needs a person either way. `processing` does not, because the upload may
  // well have landed and calling that a failure would be a guess. It is counted
  // with the workouts that did not sync this time, alongside deferred.
  const totalError = runs.filter((r) => status(r) === "error" || status(r) === "failed").length;
  const totalProcessing = runs.filter((r) => status(r) === "processing").length;
  // Read off a widened type for the same reason the statuses are compared as
  // strings: the engine is a separately versioned package and the pinned
  // `SyncOneResult` does not carry this field yet.
  const totalNoHr = runs.filter((r) => (r as { noHr?: boolean }).noHr === true).length;

  // One row per run, for the dashboard's Sync log. Deferred runs count as
  // skipped: from the panel's point of view a workout that waited is a workout
  // that did not sync this time. Best effort, and it never throws.
  await recordSyncRun(
    postgresSyncStore(sql),
    {
      synced: totalSynced,
      skipped: totalSkipped + totalDeferred + totalProcessing,
      failed: totalError,
    },
    "manual",
  );

  return NextResponse.json({
    dryRun: false,
    mode: "inline",
    ran: runs.length,
    totalSynced,
    totalSkipped,
    totalDeferred,
    totalError,
    totalProcessing,
    // "12 synced" and "12 synced, 4 without heart rate" are different answers,
    // and only one of them explains the calorie figure the user is about to
    // question (#343, #601).
    totalNoHr,
    // Log-only: a non-zero count means past races left two Garmin
    // activities for one workout, and Settings can show which (#608).
    duplicates,
    runs,
  });
}
