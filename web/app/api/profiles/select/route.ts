import { NextResponse } from "next/server";
import { requireProfile } from "@/lib/profiles";
import { selectProfileCookie } from "@/lib/profile-response";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (typeof body?.id !== "string") return NextResponse.json({ error: "Choose a profile." }, { status: 400 });
  try {
    const profile = await requireProfile(body.id);
    const response = NextResponse.json({ ok: true });
    selectProfileCookie(response, request, profile.id);
    return response;
  } catch {
    return NextResponse.json({ error: "That profile is not available." }, { status: 404 });
  }
}
