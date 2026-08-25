// Serves THIS worktree's built remocon (build/dev/remocon) while proxying
// everything it can't serve, /graphql (POST + graphql-ws upgrade) and
// /portraits/*, to a karafriends app already listening on :8080.
//
// Why not .claude/tcp-proxy-8080.js: that forwards every byte to the app,
// which reverse-proxies page requests to whichever checkout's dev static
// server owns :3000. When the running app belongs to a different worktree,
// this is the way to preview local changes without killing it.
const fs = require("fs");
const http = require("http");
const path = require("path");

const LISTEN_PORT = 3006;
const APP_PORT = 8080;
const root = path.resolve(__dirname, "..", "build", "dev", "remocon");

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function localFile(urlPath) {
  const clean = decodeURIComponent(urlPath.split("?")[0].split("#")[0]);
  const resolved = path.normalize(path.join(root, clean));
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  const candidate =
    fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
      ? path.join(resolved, "index.html")
      : resolved;
  return fs.existsSync(candidate) && fs.statSync(candidate).isFile()
    ? candidate
    : null;
}

function proxy(req, res) {
  const upstream = http.request(
    {
      host: "127.0.0.1",
      port: APP_PORT,
      path: req.url,
      method: req.method,
      headers: req.headers,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstream.on("error", (e) => {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`upstream error: ${e.message}`);
  });
  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  const file = req.method === "GET" ? localFile(req.url || "/") : null;
  if (file === null) {
    proxy(req, res);
    return;
  }
  res.writeHead(200, {
    "content-type":
      CONTENT_TYPES[path.extname(file)] || "application/octet-stream",
  });
  fs.createReadStream(file).pipe(res);
});

// graphql-ws rides a raw upgrade; hand the socket to the app untouched.
server.on("upgrade", (req, socket, head) => {
  const upstream = http.request({
    host: "127.0.0.1",
    port: APP_PORT,
    path: req.url,
    method: req.method,
    headers: req.headers,
  });
  upstream.end();
  upstream.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
    const headers = Object.entries(upstreamRes.headers)
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join("");
    socket.write(`HTTP/1.1 101 ${upstreamRes.statusMessage}\r\n${headers}\r\n`);
    if (upstreamHead && upstreamHead.length) socket.write(upstreamHead);
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
  });
  upstream.on("error", () => socket.destroy());
});

server.listen(LISTEN_PORT, "127.0.0.1", () => {
  console.log(
    `remocon preview: http://127.0.0.1:${LISTEN_PORT}/ -> ${root} (+ :${APP_PORT} for /graphql)`,
  );
});
