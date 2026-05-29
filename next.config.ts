import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@sparticuz/chromium", "pdf-parse"],
  outputFileTracingIncludes: {
    "/api/process-claims": ["node_modules/@sparticuz/chromium/bin/**/*"],
  },
  turbopack: {
    // Stub out Node.js built-ins that ExcelJS references but aren't needed in the browser
    resolveAlias: {
      fs: { browser: "./src/empty-module.js" },
      stream: { browser: "./src/empty-module.js" },
      crypto: { browser: "./src/empty-module.js" },
      path: { browser: "./src/empty-module.js" },
      zlib: { browser: "./src/empty-module.js" },
    },
  },
};

export default nextConfig;
