import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {},
  // Mark packages as external to prevent bundling
  serverExternalPackages: ['thread-stream', 'pino', '@reown/appkit', '@reown/appkit-utils', '@reown/appkit-controllers'],
};

export default nextConfig;
