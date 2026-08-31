import type { NextConfig } from "next";
import { assertProdEnv } from "./lib/env";

// Fail during production builds instead of deploying a site with missing DB or
// dashboard credentials. This function was previously defined but never used.
assertProdEnv();

const nextConfig: NextConfig = {
  // `standalone` is for Docker self-hosting. On Vercel it corrupts the Edge
  // middleware bundle (pulls in Node-only `__dirname` → MIDDLEWARE_INVOCATION_FAILED),
  // so only enable it off-Vercel; Vercel uses its own optimized output.
  output: process.env.VERCEL ? undefined : "standalone",
  // Don't auto-generate AGENTS.md / CLAUDE.md on build (those are local-only).
  agentRules: false,
};

export default nextConfig;
