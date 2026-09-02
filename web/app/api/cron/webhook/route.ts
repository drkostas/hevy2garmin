import { NextResponse } from "next/server";
import { syncOneWorkout } from "@/lib/sync-one";
import { getDb } from "@/lib/db";

// Runs a sync at request time — never at build.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/cron/webhook — the Hevy webhook, fired when a workout is saved.
 *
 * Mirrors the Python /api/cron/webhook: it MUST be authenticated with a Bearer
 * CRON_SECRET (Hevy is configured with that secret), and when CRON_SECRET is
 * unset there is no way to authenticate a caller, so it refuses with 503. On a
 * (serverless) accept it triggers a sync right away — handing off to the GitHub
 * Action when GITHUB_PAT + GITHUB_REPO are set, else running the tested
 * single-workout engine inline.
 */
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
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "Webhook not configured: CRON_SECRET is unset." },
      { status: 503 },
    );
  }
  const auth = request.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m || m[1] !== secret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const pat = process.env.GITHUB_PAT;
  const repo = process.env.GITHUB_REPO;
  if (pat && repo) {
    try {
      const ok = await triggerViaActions(pat, repo);
      return NextResponse.json({ ok, mode: "dispatch", triggered: ok }, { status: ok ? 200 : 502 });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ ok: false, error }, { status: 502 });
    }
  }

  let sql: ReturnType<typeof getDb>;
  try {
    sql = getDb();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: `DB unavailable: ${error}` }, { status: 503 });
  }

  try {
    const result = await syncOneWorkout(sql, { dryRun: false });
    return NextResponse.json({ ok: true, mode: "inline", status: result.status });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }
}
