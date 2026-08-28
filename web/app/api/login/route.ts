import { NextResponse } from "next/server";
import {
  checkPassword,
  signSession,
  sessionTtlSeconds,
  SESSION_COOKIE,
  authEnabled,
} from "@/lib/auth";

export const runtime = "nodejs";

/** POST { password } → set the h2g_session cookie on success. */
export async function POST(req: Request) {
  // If auth isn't configured, there's nothing to log into.
  if (!authEnabled()) {
    return NextResponse.json({ ok: true, note: "auth disabled" });
  }
  const body = (await req.json().catch(() => ({}))) as { password?: string };
  if (!body.password || !(await checkPassword(body.password))) {
    return NextResponse.json({ error: "Incorrect password" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, await signSession(), {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    maxAge: sessionTtlSeconds(),
    path: "/",
  });
  return res;
}
