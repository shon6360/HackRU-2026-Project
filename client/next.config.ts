import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

// Where `next dev` forwards /api requests. The built site is served by the server itself, so it needs no proxy.
const SERVER = (process.env.CONCORD_SERVER || "http://127.0.0.1:8040").replace(/\/+$/, "");

// Cache Components (the scaffold's default) needs a Node server, and this app is exported as plain files, so it is left off.
const shared: NextConfig = {
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default function config(phase: string): NextConfig {
  if (phase === PHASE_DEVELOPMENT_SERVER) {
    return { ...shared, rewrites: async () => [{ source: "/api/:path*", destination: `${SERVER}/api/:path*` }] };
  }
  // `next build` writes plain files to out/. trailingSlash makes each page <route>/index.html, which is
  // the layout the server's static file handler serves without any routing rules of its own.
  return { ...shared, output: "export", trailingSlash: true };
}
