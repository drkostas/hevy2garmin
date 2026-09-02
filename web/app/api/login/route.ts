import { NextResponse } from "next/server";
import { checkPassword, signSession, SESSION_COOKIE, authEnabled } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getSessionEpoch } from "@/lib/session-epoch";
import { lockoutRemaining, recordFailure, clearFailures, formatCooldown } from "@/lib/login-ratelimit";

export const runtime = "nodejs";

/** First forwarded IP (client), matching the Python client_ip(); "unknown" if absent. */
function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim() || "unknown";
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

/** Only allow same-origin relative redirects (block open-redirects). */
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/dashboard";
  return raw;
}

/**
 * POST { password } → set the h2g_session cookie on success.
 * Rate-limited per client IP (mirrors Python /login): the lockout is checked
 * BEFORE comparing credentials, a failure records against the limiter, and a
 * success clears it. Honors ?next= (sanitized to a relative path).
 */
export async function POST(req: Request) {
  if (!authEnabled()) {
    return NextResponse.json({ ok: true, note: "auth disabled" });
  }

  const next = safeNext(new URL(req.url).searchParams.get("next"));
  const body = (await req.json().catch(() => ({}))) as { password?: string };

  let sql: ReturnType<typeof getDb> | null = null;
  try {
    sql = getDb();
  } catch {
    sql = null; // DB unavailable → skip the limiter (never lock the admin out on an outage)
  }
  const key = clientIp(req);

  // Check the lockout BEFORE comparing credentials.
  if (sql) {
    const remaining = await lockoutRemaining(sql, key);
    if (remaining > 0) {
      return NextResponse.json(
        { error: `Too many attempts. Try again in ${formatCooldown(remaining)}.` },
        { status: 429 },
      );
    }
  }

  if (!body.password || !checkPassword(body.password)) {
    if (sql) {
      await recordFailure(sql, key);
      const remaining = await lockoutRemaining(sql, key);
      if (remaining > 0) {
        return NextResponse.json(
          { error: `Too many attempts. Try again in ${formatCooldown(remaining)}.` },
          { status: 429 },
        );
      }
    }
    return NextResponse.json({ error: "Incorrect password" }, { status: 401 });
  }

  if (sql) await clearFailures(sql, key);

  // Sign with the current epoch so the cookie survives until the next
  // "sign out everywhere". No DB → epoch 0 (a v2 cookie that a later bump revokes).
  const epoch = sql ? await getSessionEpoch(sql) : 0;
  const res = NextResponse.json({ ok: true, next });
  res.cookies.set(SESSION_COOKIE, await signSession(epoch), {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    maxAge: 30 * 24 * 60 * 60,
    path: "/",
  });
  return res;
}
