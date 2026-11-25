// Tiny global draw & salute counter for DEV Lottery. No dependencies.
// GET  /count   -> {"draws": N, "salutes": M}
// POST /draws   {"n": 3} -> {"draws": N, "salutes": M}
// POST /salute  {"delta": 1|-1} -> {"draws": N, "salutes": M}
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const FILE = process.env.DATA_FILE || "/data/count.json";
const ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const MAX_PER_REQUEST = 300;   // "spin until Easy" can add many draws at once
const MAX_PER_MINUTE = 1000;   // per IP

fs.mkdirSync(path.dirname(FILE), { recursive: true });
let state = { draws: 0, salutes: 0 };
try {
  const loaded = JSON.parse(fs.readFileSync(FILE, "utf8"));
  state.draws = Number(loaded.draws) || 0;
  state.salutes = Number(loaded.salutes) || 0;
} catch {}

let dirty = false;
setInterval(() => {
  if (!dirty) return;
  dirty = false;
  fs.writeFile(FILE + ".tmp", JSON.stringify(state), (err) => {
    if (!err) fs.rename(FILE + ".tmp", FILE, () => {});
  });
}, 5000);

const hits = new Map();
setInterval(() => hits.clear(), 60000);

function send(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(body ? JSON.stringify(body) : "");
}

http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return send(res, 204);

  if (req.method === "GET" && req.url === "/count") return send(res, 200, state);

  if (req.method === "POST" && (req.url === "/draws" || req.url === "/salute")) {
    const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
    let body = "";
    req.on("data", (d) => { body += d; if (body.length > 200) req.destroy(); });
    req.on("end", () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch {}
      if (req.url === "/salute") {
        const delta = parsed.delta === -1 ? -1 : 1;
        const used = hits.get(ip) || 0;
        if (used + 1 > MAX_PER_MINUTE) return send(res, 429, { error: "slow down" });
        hits.set(ip, used + 1);
        state.salutes = Math.max(0, state.salutes + delta);
        dirty = true;
        return send(res, 200, state);
      }
      let n = parseInt(parsed.n, 10);
      if (!Number.isFinite(n) || n < 1) n = 1;
      n = Math.min(n, MAX_PER_REQUEST);
      const used = hits.get(ip) || 0;
      if (used + n > MAX_PER_MINUTE) return send(res, 429, { error: "slow down" });
      hits.set(ip, used + n);
      state.draws += n;
      dirty = true;
      send(res, 200, state);
    });
    return;
  }

  if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true });
  send(res, 404, { error: "not found" });
}).listen(PORT, () => console.log("counter on :" + PORT));
