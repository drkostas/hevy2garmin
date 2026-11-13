import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { countVisit } from "@/lib/visit-counter";

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
  // Same seed order as lib/auth.ts and Python auth.py `_secret()` (#460).
  const seed = process.env.H2G_SECRET || process.env.H2G_PASSWORD || process.env.H2G_PASSWORD_HASH;
  let material: string;
  let rawKey: Uint8Array;
  if (secret) {
    material = `secret:${secret}`;
    rawKey = new TextEncoder().encode(secret);
  } else {
    if (!seed) throw new Error("no auth secret");
    material = `seed:${seed}`;
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`h2g-session-${seed}`),
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
  return Boolean(process.env.HEVY2GARMIN_SECRET || process.env.H2G_SECRET || process.env.H2G_PASSWORD || process.env.H2G_PASSWORD_HASH);
}

/* Production is what a forker's Vercel deploy runs (mirrors lib/auth.ts productionRuntime;
   inlined for the same bundler reason as everything else in this file). */
function productionRuntime(): boolean {
  return Boolean(process.env.VERCEL) || process.env.NODE_ENV === "production";
}

/* The README's promise (Securing the dashboard, #550): without H2G_PASSWORD the app refuses to
   serve anything but the setup page, so a public URL is never open by accident. These are the
   only paths a production deploy answers while no password or secret is configured. /api/cron
   carries its own bearer check (#473). */
const UNCONFIGURED_PATHS = [
  "/setup",
  "/login",
  "/api/login",
  "/api/logout",
  "/api/session-epoch",
  "/api/cron",
  "/api/version",
  "/api/client-error",
];
function unconfiguredRefusal(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { ok: false, error: "Auth is not configured: set H2G_PASSWORD (or H2G_PASSWORD_HASH) and redeploy" },
      { status: 401 },
    );
  }
  const url = req.nextUrl.clone();
  url.pathname = "/setup";
  url.search = "";
  return NextResponse.redirect(url, 307);
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

// /api/cron/* carries a bearer (Vercel Cron, the generated GitHub Actions workflow) and no
// session cookie; each cron route checks CRON_SECRET itself. Gating it here 401'd every
// scheduled sync before that check ran (#473).
// /api/version is open on purpose (#616). It answers "which build is this deployment
// running", and whoever asks that is usually someone whose redeploy may not have taken,
// so gating it made the two states it exists to tell apart both answer 401. It reports a
// commit of a public repository and reads no database and no credential.
// /api/client-error takes the optional error reports from a visitor's browser. It forwards
// them only when a collector is configured, always answers 204 and reads nothing.
const PUBLIC_PATHS = [
  "/login",
  "/api/login",
  "/api/logout",
  "/api/session-epoch",
  "/api/cron",
  "/api/version",
  "/api/client-error",
];
const STATIC_PREFIX = /^\/(_next|favicon|manifest|icons|robots|sitemap)/;

/* Demo mode (#471). Mirrors lib/demo.ts (inlined: the proxy bundler rejects
   cross-module imports). The public demo is read-only: one guard here refuses
   every mutating /api call instead of 30 route-level checks, of which exactly
   one existed. Signing in and out stays allowed so the demo can be browsed. */
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const DEMO_ALLOWED = ["/api/login", "/api/logout", "/api/client-error"];
// In the demo these read-only API answers are fixed sample data, so Vercel's CDN
// can hold them and a page view need not re-invoke a function. These few are left
// out: cron must run, session-epoch/login/logout are auth, version must stay fresh
// so a redeploy check is not masked, and client-error only takes POSTs.
const DEMO_UNCACHED = ["/api/cron", "/api/session-epoch", "/api/login", "/api/logout", "/api/version", "/api/client-error"];
const DEMO_API_CDN = "max-age=21600, stale-while-revalidate=86400";
function demoMode(): boolean {
  const v = (process.env.DEMO_MODE ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}
function demoRefusal(): NextResponse {
  return NextResponse.json({ ok: false, error: "Read-only in demo mode" }, { status: 403 });
}
/* The public demo serves reads only (#634). On a cacheable read-only /api GET, tag the
   response so Vercel's CDN holds the fixed sample answer and a page view need not
   re-invoke the function. Everything else passes straight through. The demo's static
   pages carry their own CDN header from next.config.ts, so only /api is tagged here. */
function demoPublicResponse(pathname: string, method: string): NextResponse {
  const res = NextResponse.next();
  if (
    pathname.startsWith("/api/") &&
    method.toUpperCase() === "GET" &&
    !DEMO_UNCACHED.some((p) => pathname === p || pathname.startsWith(`${p}/`))
  ) {
    res.headers.set("Vercel-CDN-Cache-Control", DEMO_API_CDN);
  }
  return res;
}

/** Gate every page + API route behind the shared-password session (mirrors auth.py).
    When no secret/password is set: open in development, but a production deploy serves only
    the setup and login pages until one is configured (#550). */
export async function proxy(req: NextRequest, event?: NextFetchEvent) {
  // Optional visit counter: does nothing unless COLLECTOR_URL and COLLECTOR_TOKEN are set.
  countVisit(req, event);
  const { pathname } = req.nextUrl;
  if (STATIC_PREFIX.test(pathname)) return NextResponse.next();
  // Before the auth gate on purpose: a demo with auth disabled is still read-only.
  if (
    demoMode() &&
    pathname.startsWith("/api/") &&
    MUTATING.has(req.method.toUpperCase()) &&
    !DEMO_ALLOWED.some((p) => pathname === p || pathname.startsWith(`${p}/`))
  ) {
    return demoRefusal();
  }
  if (!authEnabled()) {
    if (!productionRuntime()) return NextResponse.next();
    if (UNCONFIGURED_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
      return NextResponse.next();
    }
    // A demo is public on purpose, so the accident #550 guards against cannot
    // happen here (#634). Every mutating API call was already refused above,
    // and there are no server actions, so what remains is reads. Without this
    // the demo sent each visitor to /setup to read instructions for configuring
    // a deployment they do not own, which is what the README linked to. The demo
    // has no password, so this branch returns before any session fetch or verify,
    // which is what keeps the proxy's per-hit cost off the cached demo pages.
    if (demoMode()) return demoPublicResponse(pathname, req.method);
    return unconfiguredRefusal(req);
  }
  // Let the epoch endpoint through BEFORE reading the epoch, or currentEpoch()
  // (which fetches it) would recurse into the proxy forever.
  if (pathname === "/api/session-epoch") return NextResponse.next();

  const cookie = req.cookies.get(SESSION_COOKIE)?.value ?? null;
  const epoch = await currentEpoch(req.nextUrl.origin + req.nextUrl.basePath);
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
