import { defineConfig } from "vite";
export default defineConfig({
  server: {
    // Local dev: `vercel dev` serves /api; plain `vite` proxies to it on :3000.
    proxy: { "/api": "http://localhost:3000" },
  },
});
