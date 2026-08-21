import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // Meta has to reach the webhook over a public URL, so local development runs
  // behind a tunnel. Next rejects dev requests from an origin it does not know,
  // hence this — set DEV_TUNNEL_HOST to your tunnel hostname in .env.
  allowedDevOrigins: process.env.DEV_TUNNEL_HOST
    ? [process.env.DEV_TUNNEL_HOST]
    : [],
  reactCompiler: true,
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
