import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Disable Next.js built-in gzip compression. With compress enabled (default),
  // Next.js buffers the ENTIRE streaming response to compress it before sending,
  // which completely defeats SSE real-time delivery. Vercel's edge handles
  // compression separately, so this is safe to disable.
  compress: false,
  serverExternalPackages: ["@sparticuz/chromium"],
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
