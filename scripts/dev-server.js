#!/usr/bin/env node
// Vercel-free local server: serves ./dist (or proxies to Vite) and mounts api/*.js
// with a Vercel-compatible (req.query / res.status().send()) shim.
//
//   npm run build && node scripts/dev-server.js            # :3000, static dist + /api
//   node scripts/dev-server.js --port 3000 --vite 5173     # proxy non-/api to Vite dev server
//   CDS_BASE=http://localhost:4321 node scripts/dev-server.js   # point /api at the mock city API
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith("--") ? [a.slice(2), arr[i + 1] ?? true] : []).filter(Boolean));
// Secrets for the submission endpoints (SUPABASE_*, ADMIN_TOKEN) come from .env.local, as `vercel dev` would load them.
try {
  for (const line of (await readFile(path.join(root, ".env.local"), "utf8")).split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {}
const PORT = Number(args.port || process.env.PORT || 3000);
const DIST = path.resolve(root, process.env.DIST || "dist"); // the browser tests serve their own build (.ui/dist)
const VITE = args.vite ? Number(args.vite) : null;

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".map": "application/json" };

function shim(req, res, url) {
  req.query = Object.fromEntries(url.searchParams);
  res.status = (c) => { res.statusCode = c; return res; };
  res.send = (b) => { res.end(b); return res; };
  res.json = (o) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(o)); return res; };
}

async function serveStatic(res, urlPath) {
  let p = path.join(DIST, urlPath === "/" ? "index.html" : urlPath === "/review" ? "index.html" : urlPath);
  try { if ((await stat(p)).isDirectory()) p = path.join(p, "index.html"); } catch { p = path.join(DIST, "index.html"); }
  try {
    const body = await readFile(p);
    const headers = { "Content-Type": MIME[path.extname(p)] || "application/octet-stream" };
    if (p.endsWith(".pbf")) Object.assign(headers, { "Content-Type": "application/x-protobuf", "Content-Encoding": "gzip", "Cache-Control": "public, max-age=86400" });
    res.writeHead(200, headers);
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }); res.end("not found (run `npm run build` first)");
  }
}

function proxyToVite(req, res) {
  const up = http.request({ host: "localhost", port: VITE, path: req.url, method: req.method, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode, r.headers); r.pipe(res);
  });
  up.on("error", () => { res.writeHead(502); res.end("vite not running on :" + VITE); });
  req.pipe(up);
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname.startsWith("/api/")) {
      const name = url.pathname.slice(5).replace(/[^a-z0-9_-]/gi, "");
      try {
        const mod = await import(pathToFileURL(path.join(root, "api", `${name}.js`)).href);
        shim(req, res, url);
        if (req.method === "POST") { // like Vercel: a JSON body arrives parsed as req.body
          const chunks = []; for await (const c of req) chunks.push(c);
          try { req.body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { req.body = {}; }
        }
        await mod.default(req, res);
      } catch (e) {
        res.writeHead(e.code === "ERR_MODULE_NOT_FOUND" ? 404 : 500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(e.message || e) }));
      }
      return;
    }
    if (VITE) return proxyToVite(req, res);
    return serveStatic(res, url.pathname);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createServer().listen(PORT, () => console.log(`➜ http://localhost:${PORT}  (api from ./api, ${VITE ? "front-end via Vite :" + VITE : "static ./dist"}; CDS_BASE=${process.env.CDS_BASE || "city"})`));
}
