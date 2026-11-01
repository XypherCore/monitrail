import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // OAuth callback queries contain short-lived credentials; do not log them.
  logging: false,
};

export default nextConfig;
