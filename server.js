// DEV Lottery self-hosted server for Coolify (zero dependencies)
// Serves index.html + assets/ and persists draws, salutes & builder profiles in /data/db.json
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, "data", "db.json");
const ORIGIN = process.env.ALLOWED_ORIGIN || "*";

const MAX_DRAWS_PER_REQ = 300;
const MAX_HITS_PER_MIN = 1000;
const MAX_BUILDERS = 500;
const VALID_ISO = new Set([
  "USA","GBR","CAN","NLD","DEU","FRA","CHE","JPN","SGP","ARE","POL","MEX","BRA",
  "SAU","IND","NGA","KEN","IDN","PHL","TUR","UKR","PAK","BGD","EGY","ETH","MAR",
  "TUN","DZA","ARG","LBN","IRN","VEN","SYR"
]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8"
};

fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
let db = { draws: 0, salutes: 0, builders: [] };
try {
  const loaded = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  db.draws = Number(loaded.draws) || 0;
  db.salutes = Number(loaded.salutes) || 0;
  if (Array.isArray(loaded.builders)) db.builders = loaded.builders.slice(0, MAX_BUILDERS);
} catch {}

let dirty = false;
function flushNow() {
  if (!dirty) return;
  dirty = false;
  fs.writeFile(DATA_FILE + ".tmp", JSON.stringify(db), (err) => {
    if (!err) fs.rename(DATA_FILE + ".tmp", DATA_FILE, () => {});
  });
}
setInterval(flushNow, 4000);
process.on("SIGTERM", () => { flushNow(); process.exit(0); });

const hits = new Map();
const postCooldown = new Map();
setInterval(() => { hits.clear(); postCooldown.clear(); }, 60000);

function getIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
}
function sendJson(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body ? JSON.stringify(body) : "");
}
function cleanStr(v, max) {
  return String(v || "").replace(/[\u0000-\u001F<>]/g, "").trim().slice(0, max);
}
function cleanUrl(v) {
  const s = String(v || "").trim().slice(0, 200);
  if (!s) return "";
  try {
    const u = new URL(s.startsWith("http://") || s.startsWith("https://") ? s : "https://" + s);
    return (u.protocol === "https:" || u.protocol === "http:") ? u.href : "";
  } catch { return ""; }
}
function readBody(req, limit, cb) {
  let body = "";
  let done = false;
  req.on("data", (d) => {
    body += d;
    if (body.length > limit && !done) { done = true; req.destroy(); cb(new Error("too large")); }
  });
  req.on("end", () => { if (!done) cb(null, body); });
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  if (rel.includes("..") || rel.startsWith("server.js") || rel.startsWith("data") || rel.startsWith("counter")) {
    res.writeHead(404); return res.end("Not found");
  }
  const full = path.join(ROOT, rel);
  if (!full.startsWith(ROOT)) { res.writeHead(403); return res.end("Forbidden"); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=86400"
    });
    res.end(data);
  });
}

http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  const urlPath = (req.url || "/").split("?")[0];
  const ip = getIp(req);

  if (req.method === "GET" && urlPath === "/health") return sendJson(res, 200, { ok: true });
  if (req.method === "GET" && (urlPath === "/api/count" || urlPath === "/count")) {
    return sendJson(res, 200, { draws: db.draws, salutes: db.salutes });
  }
  if (req.method === "GET" && urlPath === "/api/builders") {
    return sendJson(res, 200, { builders: db.builders });
  }

  if (req.method === "POST" && (urlPath === "/api/draws" || urlPath === "/draws" || urlPath === "/api/salute" || urlPath === "/salute")) {
    return readBody(req, 256, (err, body) => {
      if (err) return sendJson(res, 413, { error: "payload too large" });
      let parsed = {};
      try { parsed = JSON.parse(body); } catch {}
      if (urlPath.endsWith("/salute")) {
        const used = hits.get(ip) || 0;
        if (used + 1 > MAX_HITS_PER_MIN) return sendJson(res, 429, { error: "slow down" });
        hits.set(ip, used + 1);
        const delta = parsed.delta === -1 ? -1 : 1;
        db.salutes = Math.max(0, db.salutes + delta);
        dirty = true;
        return sendJson(res, 200, { draws: db.draws, salutes: db.salutes });
      }
      let n = parseInt(parsed.n, 10);
      if (!Number.isFinite(n) || n < 1) n = 1;
      n = Math.min(n, MAX_DRAWS_PER_REQ);
      const used = hits.get(ip) || 0;
      if (used + n > MAX_HITS_PER_MIN) return sendJson(res, 429, { error: "slow down" });
      hits.set(ip, used + n);
      db.draws += n;
      dirty = true;
      return sendJson(res, 200, { draws: db.draws, salutes: db.salutes });
    });
  }

  if (req.method === "POST" && urlPath === "/api/builders") {
    const count = postCooldown.get(ip) || 0;
    if (count >= 5) return sendJson(res, 429, { error: "too many submissions, try again in a minute" });
    return readBody(req, 4096, (err, body) => {
      if (err) return sendJson(res, 413, { error: "payload too large" });
      let p = {};
      try { p = JSON.parse(body); } catch { return sendJson(res, 400, { error: "invalid json" }); }
      const name = cleanStr(p.name, 48);
      const handle = cleanStr(p.handle, 40).replace(/^@+/, "");
      const iso = cleanStr(p.iso, 3).toUpperCase();
      const project = cleanStr(p.project, 60);
      const url = cleanUrl(p.url);
      const note = cleanStr(p.note, 240);
      if (!name || !VALID_ISO.has(iso) || !note) {
        return sendJson(res, 400, { error: "name, valid country, and experience are required" });
      }
      postCooldown.set(ip, count + 1);
      const builder = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name, handle, iso, project, url, note,
        createdAt: new Date().toISOString().slice(0, 10)
      };
      db.builders.unshift(builder);
      if (db.builders.length > MAX_BUILDERS) db.builders.length = MAX_BUILDERS;
      dirty = true;
      flushNow();
      return sendJson(res, 201, { builder, total: db.builders.length });
    });
  }

  if (req.method === "GET") return serveStatic(req, res, urlPath);
  res.writeHead(404); res.end("Not found");
}).listen(PORT, () => console.log("DEV Lottery server running on :" + PORT));
