import { NextResponse, type NextRequest } from "next/server";

/* Session verification is inlined because the proxy must remain edge-safe.
   Keep this logic synchronized with web/lib/auth.ts and Python auth.py:
   key = SHA-256("h2g-session-" + H2G_SECRET/password/hash), and accept v2 plus
   legacy v1 cookies. */
const SESSION_COOKIE = "h2g_session";
const DEFAULT_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const CLOCK_SKEW_SECONDS = 300;

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

let cachedKey: { material: string; key: CryptoKey } | null = null;

async function getKey(): Promise<CryptoKey> {
  const seed = process.env.H2G_SECRET || process.env.H2G_PASSWORD || process.env.H2G_PASSWORD_HASH;
  if (!seed) throw new Error("no auth credential");
  const material = `seed:${seed}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`h2g-session-${seed}`),
  );
  const rawKey = new Uint8Array(digest);
  if (cachedKey && cachedKey.material === material) return cachedKey.key;
  const key = await crypto.subtle.importKey(
    "raw",
    rawKey as unknown as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  cachedKey = { material, key };
  return key;
}

async function hmacHex32(data: string): Promise<string> {
  const key = await getKey();
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return toHex(sig).slice(0, 32);
}

async function verifySession(cookie: string | null): Promise<boolean> {
  if (!cookie) return false;
  const parts = cookie.split(".");
  let ts: number;
  let payload: string;
  let sig: string;
  if (parts[0] === "v2" && parts.length === 4) {
    ts = Number(parts[1]);
    if (Number(parts[2]) !== 0) return false;
    payload = `v2.${parts[1]}.${parts[2]}`;
    sig = parts[3];
  } else if (parts[0] === "v1" && parts.length === 3) {
    ts = Number(parts[1]);
    payload = `v1.${parts[1]}`;
    sig = parts[2];
  } else {
    return false;
  }
  if (!Number.isSafeInteger(ts) || !/^\d+$/.test(parts[1]) || !/^[0-9a-f]{32}$/.test(sig)) return false;
  const now = Math.floor(Date.now() / 1000);
  const rawDays = process.env.H2G_SESSION_TTL_DAYS;
  const days = rawDays ? Number.parseInt(rawDays, 10) : NaN;
  const ttl = Number.isInteger(days) && days > 0 ? days * 24 * 60 * 60 : DEFAULT_SESSION_TTL_SECONDS;
  if (now - ts > ttl) return false;
  if (ts > now + CLOCK_SKEW_SECONDS) return false;
  try {
    const expected = await hmacHex32(payload);
    if (sig.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
  } catch {
    return false;
  }
}

function authEnabled(): boolean {
  return Boolean(process.env.H2G_PASSWORD || process.env.H2G_PASSWORD_HASH);
}

const PUBLIC_PATHS = ["/login", "/api/login", "/api/logout"];
const STATIC_PREFIX = /^\/(_next|favicon|manifest|icons|robots|sitemap)/;

/** Gate every page + API route behind the shared-password session (mirrors auth.py).
    When no secret/password is set, auth is disabled and everything is open. */
export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (STATIC_PREFIX.test(pathname)) return NextResponse.next();
  if (!authEnabled()) return NextResponse.next();
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }
  const cookie = req.cookies.get(SESSION_COOKIE)?.value ?? null;
  if (await verifySession(cookie)) return NextResponse.next();
  if (pathname.startsWith("/api/")) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
