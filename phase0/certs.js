// Generates (and caches) a self-signed HTTPS cert for LAN dev use.
// Regenerated whenever the machine's LAN IP changes, since the cert's SAN
// must list the exact IP the phone connects to or Safari won't offer an
// "accept the risk and continue" option at all — just a hard block.
const fs = require("fs");
const path = require("path");
const os = require("os");
const selfsigned = require("selfsigned");

const CERT_DIR = path.join(__dirname, "certs");
const KEY_PATH = path.join(CERT_DIR, "key.pem");
const CERT_PATH = path.join(CERT_DIR, "cert.pem");
const META_PATH = path.join(CERT_DIR, "meta.json");

function getLanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return "127.0.0.1";
}

async function getOrCreateCert() {
  const lanIp = getLanIp();

  if (fs.existsSync(KEY_PATH) && fs.existsSync(CERT_PATH) && fs.existsSync(META_PATH)) {
    const meta = JSON.parse(fs.readFileSync(META_PATH, "utf8"));
    if (meta.lanIp === lanIp && Date.now() < meta.expiresAt) {
      return { key: fs.readFileSync(KEY_PATH), cert: fs.readFileSync(CERT_PATH), lanIp };
    }
  }

  const attrs = [{ name: "commonName", value: lanIp }];
  const pems = await selfsigned.generate(attrs, {
    days: 365,
    keySize: 2048,
    extensions: [
      {
        name: "subjectAltName",
        altNames: [
          { type: 2, value: "localhost" },
          { type: 7, ip: "127.0.0.1" },
          { type: 7, ip: lanIp },
        ],
      },
    ],
  });

  fs.mkdirSync(CERT_DIR, { recursive: true });
  fs.writeFileSync(KEY_PATH, pems.private);
  fs.writeFileSync(CERT_PATH, pems.cert);
  fs.writeFileSync(META_PATH, JSON.stringify({ lanIp, expiresAt: Date.now() + 350 * 24 * 60 * 60 * 1000 }));

  return { key: pems.private, cert: pems.cert, lanIp };
}

module.exports = { getOrCreateCert, getLanIp };
