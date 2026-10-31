import { defineConfig } from "vite";

// Static tiles in public/tiles are pre-gzipped; serve them with the right headers in dev too.
const tileHeaders = () => ({
  name: "pbf-tile-headers",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url?.startsWith("/tiles/") && req.url.endsWith(".pbf")) {
        res.setHeader("Content-Type", "application/x-protobuf");
        res.setHeader("Content-Encoding", "gzip");
      }
      next();
    });
  },
});

export default defineConfig({
  plugins: [tileHeaders()],
  build: { target: "es2022", chunkSizeWarningLimit: 1200 },
  server: {
    // Local dev: `vercel dev` or scripts/dev-server.js serves /api on :3000.
    proxy: { "/api": "http://localhost:3000" },
  },
});
