/**
 * Demo-mode flag — mirrors the Python is_demo_mode(). When DEMO_MODE is truthy
 * the public demo is read-only: destructive/config-writing routes refuse with
 * 403 so visitors can browse without mutating the maintainer's data.
 */
export function demoMode(): boolean {
  const v = (process.env.DEMO_MODE ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}
