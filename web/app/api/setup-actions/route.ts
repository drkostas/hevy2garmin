import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/db";
import { authEnabled, verifySession, SESSION_COOKIE } from "@/lib/auth";
import { getGithubPat, getGithubRepo, githubActionsProfileError, setupGithubActions } from "@/lib/github";
import { resolveDatabaseUrl } from "@/lib/database-url";

export const dynamic = "force-dynamic";

/**
 * POST /api/setup-actions  { interval?: 30|60|120|240|360|720|1440 }
 * Configures GitHub Actions auto-sync on the fork (port of the Python route, #458).
 * Needs the GitHub token (Settings, or GITHUB_PAT), the repo (GITHUB_REPO or Vercel's git
 * metadata) and DATABASE_URL, which becomes the fork's Actions secret.
 */
export async function POST(request: Request) {
  if (authEnabled()) {
    const store = await cookies();
    if (!(await verifySession(store.get(SESSION_COOKIE)?.value ?? null))) return NextResponse.json({ ok: false, message: "Unauthorized" }, { status: 401 });
  }
  const profileError = await githubActionsProfileError();
  if (profileError) return NextResponse.json({ ok: false, message: profileError }, { status: 400 });
  let body: { interval?: unknown } = {};
  try { const t = await request.text(); if (t) body = JSON.parse(t); } catch { return NextResponse.json({ ok: false, message: "Invalid JSON body." }, { status: 400 }); }
  const allowed = [30, 60, 120, 240, 360, 720, 1440];
  const interval = allowed.includes(Number(body.interval)) ? Number(body.interval) : 120;

  let sql: ReturnType<typeof getDb> | null = null;
  try { sql = getDb(); } catch { sql = null; }
  const pat = await getGithubPat(sql);
  const repo = getGithubRepo();
  const databaseUrl = resolveDatabaseUrl();
  if (!pat) return NextResponse.json({ ok: false, message: "GitHub token not set" }, { status: 400 });
  if (!repo) return NextResponse.json({ ok: false, message: "Not deployed via Vercel (missing repo info)" }, { status: 400 });
  if (!databaseUrl) return NextResponse.json({ ok: false, message: "DATABASE_URL not set" }, { status: 400 });

  const r = await setupGithubActions({ pat, repo, databaseUrl, intervalMinutes: interval });
  return NextResponse.json(r, { status: r.ok ? 200 : 502 });
}
