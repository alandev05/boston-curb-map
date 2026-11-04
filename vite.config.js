import { defineConfig } from "vite";

// Static tiles in public/tiles are pre-gzipped; serve them with the right headers in dev too.
const tileHeaders = () => ({
  name: "pbf-tile-headers",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = req.url?.split("?")[0]; // tile URLs carry ?v=<build>
      if (url === "/review") req.url = "/" + (req.url.slice(7) || ""); // the map, with the moderator panel open (vercel.json rewrite)
      if (url?.startsWith("/tiles/") && url.endsWith(".pbf")) {
        res.setHeader("Content-Type", "application/x-protobuf");
        res.setHeader("Content-Encoding", "gzip");
      }
      next();
    });
  },
});

export default defineConfig({
  plugins: [tileHeaders()],
  publicDir: process.env.UI_PUBLIC || "public", // the browser tests build against mock data (.ui/public)
  test: { include: ["test/**/*.test.js"] }, // Vitest; the browser tests in tests-ui/ run under Playwright
  build: { target: "es2022", chunkSizeWarningLimit: 1200 },
  server: {
    // Local dev: `vercel dev` or scripts/dev-server.js serves /api on :3000.
    proxy: { "/api": "http://localhost:3000" },
  },
});
