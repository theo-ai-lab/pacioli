import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // /api/version reads the predeploy-generated build info at request time; trace the file (when
  // present — it is gitignored and only exists after scripts/predeploy.mjs) into the serverless
  // bundle explicitly rather than depending on static analysis of the fs call.
  outputFileTracingIncludes: {
    "/api/version": ["./lib/generated/build-info.json"],
  },
};

export default nextConfig;
