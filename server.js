// DEV Lottery full-stack server for Coolify (zero npm dependencies)
// Uses built-in node:sqlite (Node 22+) with automatic JSON fallback.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const SQLITE_FILE = process.env.SQLITE_FILE || path.join(DATA_DIR, "devlottery.sqlite");
const JSON_FILE = process.env.DATA_FILE || path.join(DATA_DIR, "db.json");
const ORIGIN = process.env.ALLOWED_ORIGIN || "*";

const MAX_DRAWS_PER_REQ = 300;
const MAX_HITS_PER_MIN = 1000;
const MAX_BUILDERS = 500;
const VALID_TAGS = new Set(["payouts", "tools", "relocation", "shipping"]);

// Verified country table (synced with index.html) for dynamic SVG badges & validation
const COUNTRIES = {
  USA:["United States",100,0.47,179], GBR:["United Kingdom",100,0.76,183], CAN:["Canada",100,0.74,182],
  NLD:["Netherlands",100,0.61,185], DEU:["Germany",100,0.69,185], FRA:["France",100,0.85,185],
  CHE:["Switzerland",100,0.38,185], JPN:["Japan",100,1.08,187], SGP:["Singapore",100,0.51,192],
  ARE:["UAE",100,0.81,187], POL:["Poland",100,1.63,183], MEX:["Mexico",100,3.02,156],
  BRA:["Brazil",100,3.94,168], SAU:["Saudi Arabia",30,1.15,87], IND:["India",75,15.04,56],
  NGA:["Nigeria",75,32.47,44], KEN:["Kenya",75,18.87,69], IDN:["Indonesia",75,8.11,70],
  PHL:["Philippines",30,8.56,65], TUR:["Turkey",30,2.55,113], UKR:["Ukraine",30,7.54,142],
  PAK:["Pakistan",30,27.68,31], BGD:["Bangladesh",30,14.62,36], EGY:["Egypt",60,12.74,49],
  ETH:["Ethiopia",30,43.47,42], MAR:["Morocco",60,9.52,71], TUN:["Tunisia",60,9.66,66],
  DZA:["Algeria",30,12.55,55], ARG:["Argentina",30,2.97,168], LBN:["Lebanon",30,11.66,43],
  IRN:["Iran",0,13.88,38], VEN:["Venezuela",0,12.58,116], SYR:["Syria",0,71.00,26]
};

const lmin = Math.log1p(0.38), lmax = Math.log1p(71);
const cl = (x) => Math.max(0, Math.min(1, x));
function scoreFor(iso) {
  const row = COUNTRIES[iso];
  if (!row) return null;
  const [name, earn, hours, visa] = row;
  const buy = 100 * (1 - cl((Math.log1p(hours) - lmin) / (lmax - lmin)));
  const move = 100 * cl((visa - 23) / 169);
  const score = Math.round(0.4 * earn + 0.4 * buy + 0.2 * move);
  const tier = score >= 75 ? ["EASY MODE", "#F2C230", "#111111"]
    : score >= 50 ? ["NORMAL MODE", "#FBF9F3", "#111111"]
    : score >= 25 ? ["HARD MODE", "#2B2924", "#F0EDE5"]
    : ["NIGHTMARE MODE", "#C8201A", "#FFFFFF"];
  return { iso, name, score, tierLabel: tier[0], bg: tier[1], fg: tier[2] };
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8"
};

fs.mkdirSync(DATA_DIR, { recursive: true });

/* Storage abstraction: built-in node:sqlite (Node 22+) with automatic JSON fallback */
let store;
let DatabaseSync = null;
try { ({ DatabaseSync } = require("node:sqlite")); } catch {}

if (DatabaseSync) {
  const sq = new DatabaseSync(SQLITE_FILE);
  sq.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, val INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS builders (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      handle TEXT NOT NULL DEFAULT '',
      iso TEXT NOT NULL,
      tag TEXT NOT NULL DEFAULT 'shipping',
      project TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL,
      votes INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    INSERT OR IGNORE INTO meta (key, val) VALUES ('draws', 0), ('salutes', 0);
  `);

  // One-time migration from legacy db.json if SQLite is empty
  const cnt = sq.prepare("SELECT COUNT(*) AS c FROM builders").get().c;
  const dr = sq.prepare("SELECT val FROM meta WHERE key='draws'").get().val;
  if (cnt === 0 && dr === 0 && fs.existsSync(JSON_FILE)) {
    try {
      const legacy = JSON.parse(fs.readFileSync(JSON_FILE, "utf8"));
      sq.prepare("UPDATE meta SET val=? WHERE key='draws'").run(Number(legacy.draws) || 0);
      sq.prepare("UPDATE meta SET val=? WHERE key='salutes'").run(Number(legacy.salutes) || 0);
      const ins = sq.prepare("INSERT OR IGNORE INTO builders (id,name,handle,iso,tag,project,url,note,votes,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)");
      for (const b of (legacy.builders || []).slice(0, MAX_BUILDERS)) {
        ins.run(b.id, b.name, b.handle || "", b.iso, b.tag || "shipping", b.project || "", b.url || "", b.note, Number(b.votes) || 0, b.createdAt || new Date().toISOString().slice(0, 10));
      }
      console.log("Migrated legacy db.json into SQLite.");
    } catch {}
  }

  const qMeta = sq.prepare("SELECT key, val FROM meta");
  const uDraws = sq.prepare("UPDATE meta SET val = val + ? WHERE key='draws'");
  const uSalute = sq.prepare("UPDATE meta SET val = MAX(0, val + ?) WHERE key='salutes'");
  const qBuilders = sq.prepare("SELECT id,name,handle,iso,tag,project,url,note,votes,created_at AS createdAt FROM builders ORDER BY votes DESC, rowid DESC LIMIT ?");
  const iBuilder = sq.prepare("INSERT INTO builders (id,name,handle,iso,tag,project,url,note,votes,created_at) VALUES (?,?,?,?,?,?,?,?,0,?)");
  const uVote = sq.prepare("UPDATE builders SET votes = MAX(0, votes + ?) WHERE id = ?");
  const qOneVote = sq.prepare("SELECT votes FROM builders WHERE id = ?");

  store = {
    engine: "sqlite",
    getCounts() {
      const rows = Object.fromEntries(qMeta.all().map((r) => [r.key, r.val]));
      return { draws: rows.draws || 0, salutes: rows.salutes || 0 };
    },
    addDraws(n) { uDraws.run(n); return this.getCounts(); },
    addSalute(d) { uSalute.run(d); return this.getCounts(); },
    listBuilders() { return qBuilders.all(MAX_BUILDERS); },
    addBuilder(b) { iBuilder.run(b.id, b.name, b.handle, b.iso, b.tag, b.project, b.url, b.note, b.createdAt); return b; },
    voteBuilder(id, delta) {
      const r = uVote.run(delta, id);
      if (!r.changes) return null;
      return qOneVote.get(id).votes;
    }
  };
} else {
  let db = { draws: 0, salutes: 0, builders: [] };
  try {
    const loaded = JSON.parse(fs.readFileSync(JSON_FILE, "utf8"));
    db.draws = Number(loaded.draws) || 0;
    db.salutes = Number(loaded.salutes) || 0;
    if (Array.isArray(loaded.builders)) db.builders = loaded.builders.slice(0, MAX_BUILDERS);
  } catch {}
  let dirty = false;
  function flushNow() {
    if (!dirty) return;
    dirty = false;
    fs.writeFile(JSON_FILE + ".tmp", JSON.stringify(db), (err) => {
      if (!err) fs.rename(JSON_FILE + ".tmp", JSON_FILE, () => {});
    });
  }
  setInterval(flushNow, 4000);
  process.on("SIGTERM", () => { flushNow(); process.exit(0); });

  store = {
    engine: "json",
    getCounts() { return { draws: db.draws, salutes: db.salutes }; },
    addDraws(n) { db.draws += n; dirty = true; return this.getCounts(); },
    addSalute(d) { db.salutes = Math.max(0, db.salutes + d); dirty = true; return this.getCounts(); },
    listBuilders() { return [...db.builders].sort((a, b) => (b.votes || 0) - (a.votes || 0)); },
    addBuilder(b) { db.builders.unshift(b); if (db.builders.length > MAX_BUILDERS) db.builders.length = MAX_BUILDERS; dirty = true; flushNow(); return b; },
    voteBuilder(id, delta) {
      const b = db.builders.find((x) => x.id === id);
      if (!b) return null;
      b.votes = Math.max(0, (Number(b.votes) || 0) + delta);
      dirty = true;
      return b.votes;
    }
  };
}

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

function renderBadgeSvg(info) {
  const leftText = "DEV LOTTERY";
  const rightText = "SHIPPING FROM " + info.tierLabel + " · " + info.iso + " " + info.score + "/100";
  const lw = 112;
  const rw = Math.max(240, rightText.length * 7.6 + 24);
  const w = Math.round(lw + rw);
  const h = 30;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" role="img" aria-label="${leftText}: ${rightText}">
  <rect x="1" y="1" width="${w - 2}" height="${h - 2}" fill="${info.bg}" stroke="#111111" stroke-width="2"/>
  <rect x="1" y="1" width="${lw}" height="${h - 2}" fill="#111111"/>
  <text x="${lw / 2}" y="19" fill="#F2C230" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="11" font-weight="700" text-anchor="middle">${leftText}</text>
  <text x="${lw + rw / 2}" y="19" fill="${info.fg}" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="11" font-weight="700" text-anchor="middle">${rightText}</text>
</svg>`;
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

  if (req.method === "GET" && urlPath === "/health") return sendJson(res, 200, { ok: true, engine: store.engine });
  if (req.method === "GET" && (urlPath === "/api/count" || urlPath === "/count")) return sendJson(res, 200, store.getCounts());
  if (req.method === "GET" && urlPath === "/api/builders") return sendJson(res, 200, { builders: store.listBuilders() });

  // Dynamic embeddable SVG badge: /badge/DZA.svg
  const bm = req.method === "GET" && urlPath.match(/^\/badge\/([a-zA-Z]{3})\.svg$/);
  if (bm) {
    const info = scoreFor(bm[1].toUpperCase());
    if (!info) { res.writeHead(404); return res.end("Unknown country ISO"); }
    res.writeHead(200, { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    return res.end(renderBadgeSvg(info));
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
        return sendJson(res, 200, store.addSalute(parsed.delta === -1 ? -1 : 1));
      }
      let n = parseInt(parsed.n, 10);
      if (!Number.isFinite(n) || n < 1) n = 1;
      n = Math.min(n, MAX_DRAWS_PER_REQ);
      const used = hits.get(ip) || 0;
      if (used + n > MAX_HITS_PER_MIN) return sendJson(res, 429, { error: "slow down" });
      hits.set(ip, used + n);
      return sendJson(res, 200, store.addDraws(n));
    });
  }

  // Upvote a builder workaround: POST /api/builders/:id/vote
  const vm = req.method === "POST" && urlPath.match(/^\/api\/builders\/([a-zA-Z0-9_-]{4,32})\/vote$/);
  if (vm) {
    const used = hits.get(ip) || 0;
    if (used + 1 > MAX_HITS_PER_MIN) return sendJson(res, 429, { error: "slow down" });
    hits.set(ip, used + 1);
    return readBody(req, 128, (err, body) => {
      if (err) return sendJson(res, 413, { error: "payload too large" });
      let parsed = {};
      try { parsed = JSON.parse(body); } catch {}
      const votes = store.voteBuilder(vm[1], parsed.delta === -1 ? -1 : 1);
      if (votes === null) return sendJson(res, 404, { error: "builder not found" });
      return sendJson(res, 200, { id: vm[1], votes });
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
      const tag = VALID_TAGS.has(p.tag) ? p.tag : "shipping";
      const project = cleanStr(p.project, 60);
      const url = cleanUrl(p.url);
      const note = cleanStr(p.note, 240);
      if (!name || !COUNTRIES[iso] || !note) {
        return sendJson(res, 400, { error: "name, valid country, and experience are required" });
      }
      postCooldown.set(ip, count + 1);
      const builder = store.addBuilder({
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name, handle, iso, tag, project, url, note, votes: 0,
        createdAt: new Date().toISOString().slice(0, 10)
      });
      return sendJson(res, 201, { builder });
    });
  }

  if (req.method === "GET") return serveStatic(req, res, urlPath);
  res.writeHead(404); res.end("Not found");
}).listen(PORT, () => console.log("DEV Lottery server running on :" + PORT + " (" + store.engine + ")"));
