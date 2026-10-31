import type { NextConfig } from "next";

// The browser talks to the Django API through this origin so session cookies stay
// first-party (HttpOnly + SameSite). In production Traefik routes /api and /ws directly.
const backend = process.env.ERP_BACKEND_URL ?? "http://127.0.0.1:8000";

// Mirrors the Traefik policy so the app is protected without the proxy too (D-33 explains 'unsafe-inline').
const isDev = process.env.NODE_ENV !== "production";
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  `connect-src 'self' ${isDev ? "ws: wss:" : "wss:"}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "worker-src 'self' blob:",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(self), geolocation=(), microphone=()" },
];

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  experimental: {
    // Signed-in pages render only once the browser has a session, so automatic instant-navigation
    // validation can't inspect them. Validate only segments that explicitly export `instant`.
    instantInsights: { validationLevel: "manual-warning" },
  },
  // Django URLs end with "/"; don't let Next strip it before proxying.
  skipTrailingSlashRedirect: true,
  poweredByHeader: false,
  output: "standalone", // self-contained server bundle for the Docker image
  // Lets several dev servers run side by side from one checkout (e.g. parallel e2e stacks).
  distDir: process.env.NEXT_DIST_DIR || ".next",
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async rewrites() {
    return [
      { source: "/api/:path*/", destination: `${backend}/api/:path*/` },
      { source: "/api/:path*", destination: `${backend}/api/:path*` },
    ];
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
