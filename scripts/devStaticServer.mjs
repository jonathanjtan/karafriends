#!/usr/bin/env node
// Minimal static file server for the dev build output.
//
// Replaces `parcel serve` in run-dev. `parcel serve` runs its own in-memory
// HMR build that, with multiple browser targets, hoists bundles to the server
// root and serves an index/asset layout inconsistent with the on-disk
// `parcel build` output, which whitescreens the remocon behind the
// `/remocon/`-prefixing reverse proxy. Serving the already-built, self-
// consistent `build/dev/{remocon,renderer}/*` files (produced with
// `--public-url .`) sidesteps that entirely. `parcel build --watch` keeps the
// files fresh; there's no hot-module-reload, so reload the page after a change.
//
// Usage: node scripts/devStaticServer.mjs <port> <rootDir>
import fs from "fs";
import http from "http";
import path from "path";

const port = parseInt(process.argv[2] || "3000", 10);
const root = path.resolve(process.argv[3] || "build/dev");

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".bin": "application/octet-stream",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".wav": "audio/wav",
};

function resolveWithinRoot(urlPath) {
  // Strip query/hash, decode, and normalize; reject anything that escapes root.
  const clean = decodeURIComponent(urlPath.split("?")[0].split("#")[0]);
  const resolved = path.normalize(path.join(root, clean));
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

const server = http.createServer((req, res) => {
  const resolved = resolveWithinRoot(req.url || "/");
  if (resolved === null) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  let filePath = resolved;
  try {
    if (fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }
  } catch {
    // stat failed (missing), so fall through to the read error below.
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    const type =
      CONTENT_TYPES[path.extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    res.end(data);
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`dev static server: http://127.0.0.1:${port}/ -> ${root}`);
});
