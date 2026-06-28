import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  basePath: "/daily",
  trailingSlash: true,
  images: { unoptimized: true },
};

export default nextConfig;
