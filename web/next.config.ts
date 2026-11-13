import type { NextConfig } from "next";

// Optional path prefix for a self-hosted dashboard behind a reverse proxy
// (e.g. "/tools/hevy2garmin"). Read at build time: Next.js bakes it into the
// bundle, so the image is built for the path it is served under.
const basePath = (process.env.H2G_BASE_PATH ?? "").replace(/\/+$/, "");

// Mirrors lib/demo.ts demoMode(). The public demo serves fixed sample data with
// no database, so Vercel's CDN can hold its pages for six hours. Off the demo
// this is empty, so a self-hosted deployment is unchanged.
const demo = ["1", "true", "yes", "on"].includes((process.env.DEMO_MODE ?? "").trim().toLowerCase());

const nextConfig: NextConfig = {
  ...(basePath ? { basePath } : {}),
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
  async headers() {
    if (!demo) return [];
    return [
      {
        source: "/:path((?!api/|_next/).*)",
        headers: [
          { key: "Vercel-CDN-Cache-Control", value: "max-age=21600, stale-while-revalidate=86400" },
        ],
      },
    ];
  },
  // `standalone` is for Docker self-hosting. On Vercel it corrupts the Edge
  // middleware bundle (pulls in Node-only `__dirname` → MIDDLEWARE_INVOCATION_FAILED),
  // so only enable it off-Vercel; Vercel uses its own optimized output.
  output: process.env.VERCEL ? undefined : "standalone",
  // Don't auto-generate AGENTS.md / CLAUDE.md on build (those are local-only).
  agentRules: false,
  // Parity with the Python dashboard's GET /sync → dashboard (#461).
  async redirects() {
    return [{ source: "/sync", destination: "/dashboard", permanent: false }];
  },
};

export default nextConfig;
