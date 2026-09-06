import { defineConfig, devices } from "@playwright/test";

/**
 * A DEDICATED port, deliberately not the 8096 that `npm run dev` and
 * `npm run start` use. With `reuseExistingServer` on (everywhere but CI),
 * sharing the dev port makes Playwright silently adopt a running dev server
 * instead of starting the one configured below. That server carries the
 * developer's .env.local, so the "no database" suite would run against the
 * staging database and its real Garmin and Hevy tokens, and dev-mode compile
 * latency also pushes hydration past the click timeout. A separate port means
 * the only server we can ever reuse is one this suite started itself.
 */
const PORT = process.env.E2E_PORT ?? "8097";

/**
 * Parity smoke for the web dashboard (#461). Runs against a production build started with ONLY
 * a password in the environment: no database, so every page must render its "no database"
 * state instead of failing — that is what a fresh fork sees before it wires Neon.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: `npx next start --port ${PORT} --hostname 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: { H2G_PASSWORD: "test-pw", NODE_ENV: "production", DATABASE_URL: "" },
  },
});
