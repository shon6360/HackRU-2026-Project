import type { NextConfig } from "next";

// The client runs as its own small web server (`next start`): it serves the pages and forwards /api to the
// Concord server (app/api/[...path]/route.ts). Cache Components, the scaffold's default, is left off.
const config: NextConfig = {
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default config;
