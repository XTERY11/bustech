import type { NextConfig } from "next";

const isGitHubPages = process.env.GITHUB_ACTIONS === "true";
const repositoryName = process.env.GITHUB_REPOSITORY?.split("/")[1] ?? "";
const basePath = isGitHubPages && repositoryName ? `/${repositoryName}` : "";

const nextConfig: NextConfig = {
  distDir: process.env.NEXT_BUILD_DIR || '.next',
  // Phones and other computers open the dev dashboard by this machine's LAN address (LAN=1 bash start_demo.sh).
  // Without this the Next dev server refuses its own scripts to those origins and the page never hydrates.
  allowedDevOrigins: ['127.0.0.1', 'localhost', '192.168.*.*', '10.*.*.*', '172.*.*.*', '*.local'],
  // Local browser and bridge share one origin. GitHub Pages remains a static export.
  ...(!isGitHubPages && process.env.NODE_ENV === 'development' ? { async rewrites() { return [{ source: '/api/:path*', destination: `http://127.0.0.1:${process.env.BRIDGE_PORT || 8787}/api/:path*` }]; } } : {}),
  ...(isGitHubPages
    ? {
        output: "export" as const,
        basePath,
        assetPrefix: basePath,
        trailingSlash: true,
        images: { unoptimized: true },
      }
    : {}),
};

export default nextConfig;
