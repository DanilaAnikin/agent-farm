import type { NextConfig } from "next";

// Standalone output kvůli malému Docker image (multi-stage build).
const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  // @farm/* balíčky přicházejí předsestavené v dist (ESM/JS) — Next je jen použije.
  outputFileTracingRoot: process.env.TURBO_ROOT ?? undefined,
  // Balíčky se serverovými závislostmi (archiver má dynamické require) nebundlovat.
  serverExternalPackages: [
    "@farm/storage",
    "@farm/db",
    "@farm/billing",
    "stripe",
    "archiver",
    "postgres",
  ],
  typescript: {
    // Typecheck běží zvlášť (pnpm typecheck).
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
