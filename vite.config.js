import { defineConfig } from "vite";

// Static tiles in public/tiles are pre-gzipped; serve them with the right headers in dev too.
const tileHeaders = () => ({
  name: "pbf-tile-headers",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = req.url?.split("?")[0]; // tile URLs carry ?v=<build>
      if (url === "/review") req.url = "/review.html" + (req.url.slice(7) || ""); // like Vercel's cleanUrls
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
  // Two pages: the map, and the moderators' review queue.
  build: { target: "es2022", chunkSizeWarningLimit: 1200, rollupOptions: { input: { main: "index.html", review: "review.html" } } },
  server: {
    // Local dev: `vercel dev` or scripts/dev-server.js serves /api on :3000.
    proxy: { "/api": "http://localhost:3000" },
  },
});
