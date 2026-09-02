/**
 * Server-side session epoch — the counter behind "sign out everywhere".
 *
 * The epoch is folded into every v2 session cookie's signature. Bumping it
 * (logout-all) makes every outstanding cookie stop validating without a session
 * store. State lives in app_cache 'session_epoch' = { n }. Reads are best-effort
 * and default to 0, so a storage failure NEVER locks the admin out (it just
 * means revocation hasn't taken effect yet).
 */
import type { getDb } from "./db";

type Sql = ReturnType<typeof getDb>;

const KEY = "session_epoch";

/** Current epoch (0 if unset or on any read error). */
export async function getSessionEpoch(sql: Sql): Promise<number> {
  try {
    const rows = (await sql`SELECT value FROM app_cache WHERE key = ${KEY} LIMIT 1`) as Array<{
      value: unknown;
    }>;
    const v = rows[0]?.value;
    const n = v && typeof v === "object" ? (v as { n?: unknown }).n : undefined;
    const num = Number(n);
    return Number.isFinite(num) && num >= 0 ? Math.floor(num) : 0;
  } catch {
    return 0;
  }
}

/**
 * Bump the epoch by one and return the new value. Throws on failure so the
 * caller (logout-all) can report that revocation did NOT take effect, rather
 * than pretending success — matching the Python /logout-all behaviour.
 */
export async function bumpSessionEpoch(sql: Sql): Promise<number> {
  const current = await getSessionEpoch(sql);
  const next = current + 1;
  await sql`
    INSERT INTO app_cache (key, value, updated_at)
    VALUES (${KEY}, ${sql.json({ n: next })}, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `;
  return next;
}
