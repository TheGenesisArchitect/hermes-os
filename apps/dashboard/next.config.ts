import type { NextConfig } from "next";

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
