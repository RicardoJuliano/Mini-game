const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, "public");

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
};

function getLanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return "127.0.0.1";
}

const server = http.createServer((req, res) => {
  let reqPath = decodeURIComponent(req.url.split("?")[0]);
  if (reqPath === "/") reqPath = "/host.html";
  const filePath = path.join(PUBLIC_DIR, reqPath);

  // Prevent path traversal outside public/
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

// Single in-memory room for the spike: one host, one controller.
const room = { host: null, controller: null };

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

wss.on("connection", (ws) => {
  ws.role = null;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === "hello") {
      ws.role = msg.role === "host" ? "host" : "controller";
      room[ws.role] = ws;
      if (ws.role === "controller") send(room.host, { type: "controller-joined" });
      if (ws.role === "host") send(room.controller, { type: "host-ready" });
      return;
    }

    // Round-trip latency probe: whichever side sends "ping" gets an immediate "pong" echo.
    if (msg.type === "ping") {
      send(ws, { type: "pong", t: msg.t });
      return;
    }

    // Input packets flow controller -> host only.
    if (msg.type === "input" && ws.role === "controller") {
      send(room.host, msg);
      return;
    }
  });

  ws.on("close", () => {
    if (ws.role && room[ws.role] === ws) {
      room[ws.role] = null;
      const other = ws.role === "controller" ? room.host : room.controller;
      send(other, { type: `${ws.role}-left` });
    }
  });
});

server.listen(PORT, () => {
  const ip = getLanIp();
  console.log(`Project Tilt Phase 0 server running`);
  console.log(`  Host page:       http://${ip}:${PORT}/host.html`);
  console.log(`  Controller page: http://${ip}:${PORT}/controller.html`);
  console.log(`  (Both devices must be on the same LAN/Wi-Fi.)`);
});
