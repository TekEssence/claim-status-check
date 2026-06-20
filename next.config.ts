import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@sparticuz/chromium"],
  outputFileTracingIncludes: {
    "/api/process-claims": ["node_modules/@sparticuz/chromium/bin/**/*"],
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
