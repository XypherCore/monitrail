import type { NextConfig } from "next";
import { baselineSecurityHeaders } from "./src/security/headers.ts";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // OAuth callback queries contain short-lived credentials; do not log them.
  logging: false,
  async headers() {
    return [{
      source: "/:path*",
      headers: Object.entries(baselineSecurityHeaders(process.env.NODE_ENV === "production"))
        .map(([key, value]) => ({ key, value })),
    }];
  },
};

export default nextConfig;
