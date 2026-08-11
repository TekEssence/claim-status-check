import type { NextConfig } from "next";

const automationRuntimeFiles = [
  "node_modules/@sparticuz/chromium/bin/**/*",
  "node_modules/playwright-core/**/*",
];

const nextConfig: NextConfig = {
  output: process.env.STATIC_EXPORT === "true" ? "export" : "standalone",
  images: {
    unoptimized: process.env.STATIC_EXPORT === "true",
  },
  serverExternalPackages: ["@sparticuz/chromium", "playwright-core"],
  outputFileTracingIncludes: {
    "/api/scrape-jobs": automationRuntimeFiles,
    "/api/automation-jobs": automationRuntimeFiles,
    "/api/process-claims": automationRuntimeFiles,
  },
  turbopack: {
    // Stub out Node.js built-ins that ExcelJS references but aren't needed in the browser
    resolveAlias: {
      fs: { browser: "./frontend/src/shims/empty-module.js" },
      stream: { browser: "./frontend/src/shims/empty-module.js" },
      crypto: { browser: "./frontend/src/shims/empty-module.js" },
      path: { browser: "./frontend/src/shims/empty-module.js" },
      zlib: { browser: "./frontend/src/shims/empty-module.js" },
    },
  },
};

export default nextConfig;
