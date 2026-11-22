import { NextResponse } from "next/server";
import { listProfiles, createProfile, renameProfile } from "@/lib/profiles";
import { activeProfileId } from "@/lib/profile-context";
import { selectProfileCookie } from "@/lib/profile-response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const profiles = await listProfiles();
    const id = await activeProfileId();
    return NextResponse.json({ profiles, selectedId: profiles.some((p) => p.id === id) ? id : null },
      { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Profiles could not be loaded. Check the database connection." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  try {
    const profile = await createProfile(body?.name);
    const response = NextResponse.json({ profile }, { status: 201 });
    selectProfileCookie(response, request, profile.id);
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Profile could not be created.";
    if (message.startsWith("Use a profile name")) return NextResponse.json({ error: message }, { status: 400 });
    return NextResponse.json({ error: "Profile could not be created. Check the database connection." }, { status: 503 });
  }
}

export async function PATCH(request: Request) {
  const body = await request.json().catch(() => null);
  if (typeof body?.id !== "string") return NextResponse.json({ error: "Choose a profile." }, { status: 400 });
  try {
    await renameProfile(body.id, body.name);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Profile could not be renamed. Check the profile and name." }, { status: 400 });
  }
}
