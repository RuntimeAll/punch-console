import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 是原生模块,不能让打包器动它
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
