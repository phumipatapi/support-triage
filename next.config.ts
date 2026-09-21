import type { NextConfig } from "next";

const config: NextConfig = {
  agentRules: false,
  serverExternalPackages: ["better-sqlite3"],
  poweredByHeader: false,
};
export default config;
