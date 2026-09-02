import { NextResponse, type NextRequest } from "next/server";

/* Session verify is INLINED here (not imported from @/lib/auth) because Vercel's
   proxy bundler rejects a cross-module reference from the proxy even when the
   module is edge-safe. The logic is identical to lib/auth.ts (pure Web Crypto):
   key = HEVY2GARMIN_SECRET raw bytes, else SHA-256("h2g-session-" + H2G_PASSWORD);
   cookie = v1.<ts>.<hmac-sha256(v1.<ts>) hex truncated to 32>. The API routes
   still import from @/lib/auth — they run on the Node serverless runtime. */
const SESSION_COOKIE = "h2g_session";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const CLOCK_SKEW_SECONDS = 300;

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

let cachedKey: { material: string; key: CryptoKey } | null = null;

async function getKey(): Promise<CryptoKey> {
  const secret = process.env.HEVY2GARMIN_SECRET;
  const password = process.env.H2G_PASSWORD;
  let material: string;
  let rawKey: Uint8Array;
  if (secret) {
    material = `secret:${secret}`;
    rawKey = new TextEncoder().encode(secret);
  } else {
    if (!password) throw new Error("no auth secret");
    material = `password:${password}`;
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`h2g-session-${password}`),
    );
    rawKey = new Uint8Array(digest);
  }
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

async function verifySession(cookie: string | null, epoch: number): Promise<boolean> {
  if (!cookie) return false;
  let ts: number;
  let sig: string;
  let payload: string;
  const v2 = cookie.match(/^v2\.(\d+)\.(\d+)\.([0-9a-f]{32})$/);
  const v1 = cookie.match(/^v1\.(\d+)\.([0-9a-f]{32})$/);
  if (v2) {
    if (Number(v2[2]) !== epoch) return false;
    ts = Number(v2[1]);
    sig = v2[3];
    payload = `v2.${v2[1]}.${v2[2]}`;
  } else if (v1) {
    if (epoch !== 0) return false;
    ts = Number(v1[1]);
    sig = v1[2];
    payload = `v1.${v1[1]}`;
  } else {
    return false;
  }
  const now = Math.floor(Date.now() / 1000);
  if (now - ts > SESSION_TTL_SECONDS) return false;
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
  return Boolean(process.env.HEVY2GARMIN_SECRET || process.env.H2G_PASSWORD);
}

/* The "sign out everywhere" epoch, read from the public /api/session-epoch and
   cached in module scope for a few seconds so it is not fetched per request.
   On any failure we keep the last-known value (or 0), so a transient blip never
   locks the admin out — it just briefly delays a fresh revocation. */
let epochCache = { n: 0, at: 0 };
const EPOCH_TTL_MS = 10_000;
async function currentEpoch(origin: string): Promise<number> {
  const now = Date.now();
  if (now - epochCache.at < EPOCH_TTL_MS) return epochCache.n;
  try {
    const res = await fetch(`${origin}/api/session-epoch`, { cache: "no-store" });
    if (res.ok) {
      const d = (await res.json()) as { n?: unknown };
      const n = Number(d.n);
      epochCache = { n: Number.isFinite(n) && n >= 0 ? Math.floor(n) : epochCache.n, at: now };
    } else {
      epochCache = { ...epochCache, at: now };
    }
  } catch {
    epochCache = { ...epochCache, at: now };
  }
  return epochCache.n;
}

const PUBLIC_PATHS = ["/login", "/api/login", "/api/logout", "/api/session-epoch"];
const STATIC_PREFIX = /^\/(_next|favicon|manifest|icons|robots|sitemap)/;

/** Gate every page + API route behind the shared-password session (mirrors auth.py).
    When no secret/password is set, auth is disabled and everything is open. */
export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (STATIC_PREFIX.test(pathname)) return NextResponse.next();
  if (!authEnabled()) return NextResponse.next();
  // Let the epoch endpoint through BEFORE reading the epoch, or currentEpoch()
  // (which fetches it) would recurse into the proxy forever.
  if (pathname === "/api/session-epoch") return NextResponse.next();

  const cookie = req.cookies.get(SESSION_COOKIE)?.value ?? null;
  const epoch = await currentEpoch(req.nextUrl.origin);
  const authed = await verifySession(cookie, epoch);

  // Already signed in and hitting /login → bounce to the dashboard (or ?next=),
  // mirroring the Python GET /login redirect-when-authenticated.
  if (pathname === "/login" && authed) {
    const url = req.nextUrl.clone();
    const next = req.nextUrl.searchParams.get("next");
    url.pathname = next && next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";
    url.search = "";
    return NextResponse.redirect(url);
  }

  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }
  if (authed) return NextResponse.next();
  if (pathname.startsWith("/api/")) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  // Gate the page and remember where the user was headed (?next=, relative-only).
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?next=${encodeURIComponent(pathname + req.nextUrl.search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
