// Serves the exported web build and proxies /api to Django, so the browser build talks to the API
// same-origin (as the native app talks to its configured server). Test harness only.
import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? "dist");
const port = Number(process.env.PORT ?? 8190);
const backend = new URL(process.env.ERP_BACKEND_URL ?? "http://127.0.0.1:8170");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon", ".ttf": "font/ttf", ".svg": "image/svg+xml" };

http
  .createServer((req, res) => {
    if (req.url.startsWith("/api/")) {
      const upstream = http.request(
        { hostname: backend.hostname, port: backend.port, path: req.url, method: req.method, headers: { ...req.headers, host: backend.host } },
        (r) => {
          res.writeHead(r.statusCode ?? 502, r.headers);
          r.pipe(res);
        },
      );
      upstream.on("error", () => {
        res.writeHead(502).end();
      });
      req.pipe(upstream);
      return;
    }
    const clean = decodeURIComponent(new URL(req.url, "http://x").pathname);
    let file = path.join(root, clean);
    if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
      const html = path.join(root, `${clean}.html`);
      file = existsSync(html) ? html : path.join(root, "index.html");
    }
    res.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  })
  .listen(port, () => console.log(`mobile web on http://localhost:${port} -> ${backend.href}`));
