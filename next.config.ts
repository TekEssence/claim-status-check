import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@sparticuz/chromium"],
  experimental: {
    serverComponentsExternalPackages: ["@sparticuz/chromium"]
  },
  outputFileTracingIncludes: {
    "/api/process-claims": ["node_modules/@sparticuz/chromium/bin/**/*"],
  },
};

export default nextConfig;
