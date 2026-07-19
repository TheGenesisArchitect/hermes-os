import type { NextConfig } from "next";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Load the repo-root .env into the server process at startup — the dashboard has
// no .env of its own (DB URL + all config have safe defaults), but the live
// wallet vars (TRADER_WALLET_SECRET_KEY, LIVE_TRADING_ENABLED) have NO default
// and live only in repo-root .env. next.config runs in plain Node (NOT bundled by
// webpack), so fs is available here — unlike instrumentation.ts, which webpack
// tries to bundle and cannot resolve 'fs'. The secret is used only to derive the
// PUBLIC wallet address server-side; it is never inlined into the client bundle
// (we do NOT use next's `env` key, which would inline). Existing env wins.
for (const candidate of ["../../.env", ".env", "../../../.env"]) {
  try {
    const text = readFileSync(resolve(process.cwd(), candidate), "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
      if (m && m[1] && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
      }
    }
    break; // first readable .env wins
  } catch {
    /* try next candidate */
  }
}

const nextConfig: NextConfig = {
  transpilePackages: ["@hermes/db", "@hermes/core"],
  serverExternalPackages: ["postgres"],
  // workspace packages use NodeNext ".js" import specifiers on TS sources
  webpack: (config) => {
    config.resolve.extensionAlias = { ".js": [".ts", ".js"] };
    return config;
  },
  turbopack: {
    resolveExtensions: [".ts", ".tsx", ".js", ".jsx", ".json"],
  },
};

export default nextConfig;
