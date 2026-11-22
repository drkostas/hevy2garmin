import type { NextResponse } from "next/server";
import { PROFILE_COOKIE } from "./profile-context";

export function selectProfileCookie(response: NextResponse, request: Request, id: string): void {
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0].trim();
  response.cookies.set(PROFILE_COOKIE, id, {
    httpOnly: true, sameSite: "strict", path: "/", maxAge: 30 * 24 * 60 * 60,
    secure: forwarded ? forwarded === "https" : new URL(request.url).protocol === "https:",
  });
}
