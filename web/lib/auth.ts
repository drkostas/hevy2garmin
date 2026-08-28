/**
 * Shared-password session auth for the web app.
 *
 * The Python FastAPI dashboard is the canonical implementation. Keep the
 * cookie wire format and environment names identical here:
 *   - signing seed: H2G_SECRET, then H2G_PASSWORD, then H2G_PASSWORD_HASH
 *   - key: SHA-256("h2g-session-" + seed)
 *   - cookie: v2.<ts>.<epoch>.<sig>, with legacy v1 accepted during migration
 *   - password: plaintext H2G_PASSWORD or Argon2 H2G_PASSWORD_HASH
 *
 * HEVY2GARMIN_SECRET is deliberately not used here: Python uses that variable
 * for CSRF/API protection, not dashboard session signing.
 */

import argon2 from "argon2";

const DEFAULT_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const CLOCK_SKEW_SECONDS = 300;

export const SESSION_COOKIE = "h2g_session";

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

let cachedKey: { material: string; key: CryptoKey } | null = null;

export function sessionTtlSeconds(): number {
  const raw = process.env.H2G_SESSION_TTL_DAYS;
  const days = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isInteger(days) && days > 0
    ? days * 24 * 60 * 60
    : DEFAULT_SESSION_TTL_SECONDS;
}

function signingSeed(): string {
  const seed = process.env.H2G_SECRET || process.env.H2G_PASSWORD || process.env.H2G_PASSWORD_HASH;
  if (!seed) {
    throw new Error("Set H2G_PASSWORD or H2G_PASSWORD_HASH to enable dashboard auth.");
  }
  return seed;
}

/**
 * Resolve the HMAC signing key using the same derivation as Python auth.py.
 */
async function getKey(): Promise<CryptoKey> {
  const seed = signingSeed();
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

/** HMAC-SHA256 of `data`, hex-encoded and truncated to 32 chars (matches auth.py). */
async function hmacHex32(data: string): Promise<string> {
  const key = await getKey();
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return toHex(sig).slice(0, 32);
}

/** True when a password verifier is configured, matching Python auth_enabled(). */
export function authEnabled(): boolean {
  return Boolean(process.env.H2G_PASSWORD || process.env.H2G_PASSWORD_HASH);
}

/** Create a signed session cookie value: `v2.<ts>.<epoch>.<sig>`. */
export async function signSession(issuedAt?: number, epoch = 0): Promise<string> {
  const ts = issuedAt ?? Math.floor(Date.now() / 1000);
  const payload = `v2.${ts}.${epoch}`;
  const sig = await hmacHex32(payload);
  return `${payload}.${sig}`;
}

/** Verify a v2 cookie, or a legacy v1 cookie while it is still valid. */
export async function verifySession(cookie: string | null, currentEpoch = 0): Promise<boolean> {
  if (!cookie) return false;
  const parts = cookie.split(".");
  let ts: number;
  let payload: string;
  let sig: string;
  if (parts[0] === "v2" && parts.length === 4) {
    ts = Number(parts[1]);
    if (Number(parts[2]) !== currentEpoch) return false;
    payload = `v2.${parts[1]}.${parts[2]}`;
    sig = parts[3];
  } else if (parts[0] === "v1" && parts.length === 3) {
    if (currentEpoch !== 0) return false;
    ts = Number(parts[1]);
    payload = `v1.${parts[1]}`;
    sig = parts[2];
  } else {
    return false;
  }
  if (!Number.isSafeInteger(ts) || !/^\d+$/.test(parts[1]) || !/^[0-9a-f]{32}$/.test(sig)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (now - ts > sessionTtlSeconds()) return false;
  if (ts > now + CLOCK_SKEW_SECONDS) return false;
  try {
    const expected = await hmacHex32(payload);
    if (sig.length !== expected.length) return false;
    // Constant-time compare.
    let diff = 0;
    for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
  } catch {
    return false;
  }
}

/** Verify plaintext or Argon2 dashboard credentials. */
export async function checkPassword(candidate: string): Promise<boolean> {
  const hash = process.env.H2G_PASSWORD_HASH;
  if (hash) {
    try {
      return await argon2.verify(hash, candidate);
    } catch {
      return false;
    }
  }
  const pw = process.env.H2G_PASSWORD;
  if (!pw) return false;
  if (candidate.length !== pw.length) return false;
  let diff = 0;
  for (let i = 0; i < pw.length; i++) diff |= candidate.charCodeAt(i) ^ pw.charCodeAt(i);
  return diff === 0;
}
