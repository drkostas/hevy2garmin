/** Throws in production if any required env var is missing or too short. */
export function assertProdEnv(): void {
  if (process.env.NODE_ENV !== "production") return;

  const missing: string[] = [];
  if (!process.env.DATABASE_URL) missing.push("DATABASE_URL");
  // H2G_SECRET signs sessions but is not a login credential. A password or
  // Argon2 verifier is therefore always required when auth is enabled.
  const hasPassword = Boolean(process.env.H2G_PASSWORD && process.env.H2G_PASSWORD.length >= 8);
  const hasHash = Boolean(process.env.H2G_PASSWORD_HASH);
  if (!hasPassword && !hasHash) {
    missing.push("H2G_PASSWORD (min 8 chars) or H2G_PASSWORD_HASH");
  }
  if (process.env.H2G_SECRET && process.env.H2G_SECRET.length < 32) {
    missing.push("H2G_SECRET (min 32 chars when set)");
  }
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
}
