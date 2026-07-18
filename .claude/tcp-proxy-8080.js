// Transparent TCP proxy: 3002 -> localhost:8080 (karafriends app server).
// Carries HTTP and graphql-ws WebSocket traffic untouched so the preview
// browser can drive the real running app's remocon.
const net = require("net");

const LISTEN_PORT = 3002;
const TARGET_PORT = 8080;

const server = net.createServer((client) => {
  const upstream = net.connect(TARGET_PORT, "127.0.0.1");
  client.pipe(upstream);
  upstream.pipe(client);
  const kill = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on("error", kill);
  upstream.on("error", kill);
});

server.listen(LISTEN_PORT, () => {
  console.log(`tcp proxy listening on :${LISTEN_PORT} -> :${TARGET_PORT}`);
});
