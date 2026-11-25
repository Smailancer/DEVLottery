// DEV Lottery production server for Coolify (zero npm dependencies)
// Built-in node:sqlite (Node 22+) + dynamic OG cards + SVG badges + vote deduplication + ADMIN_TOKEN moderation
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const SQLITE_FILE = process.env.SQLITE_FILE || path.join(DATA_DIR, "devlottery.sqlite");
const JSON_FILE = process.env.DATA_FILE || path.join(DATA_DIR, "db.json");
const ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const VOTE_SALT = process.env.VOTE_SALT || "devlottery-v2-salt";

const MAX_DRAWS_PER_REQ = 300;
const MAX_HITS_PER_MIN = 600;
const MAX_BUILDERS = 500;
const VALID_TAGS = new Set(["payouts", "tools", "relocation", "shipping"]);

// Single source of truth: parse verified RAW country dataset directly from index.html
const indexHtmlTemplate = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const rawMatch = indexHtmlTemplate.match(/const RAW=(\[[\s\S]*?\n\]);/);
if (!rawMatch) throw new Error("Failed to parse RAW country data from index.html");
const RAW_LIST = new Function("return " + rawMatch[1])();

const WORLD = 132405927, lmin = Math.log1p(0.38), lmax = Math.log1p(71);
const cl = (x) => Math.max(0, Math.min(1, x));
const COUNTRIES = {};
const COUNTRIES_LIST = RAW_LIST.map(([iso, flag, en, ar, earn, noteEn, noteAr, hours, visa, births, blocked, baliVisa, usVisa, flightUsd]) => {
  const buy = 100 * (1 - cl((Math.log1p(hours) - lmin) / (lmax - lmin)));
  const move = 100 * cl((visa - 23) / 169);
  const score = Math.round(0.4 * earn + 0.4 * buy + 0.2 * move);
  const tier = score >= 75 ? ["Easy", "EASY MODE", "#F2C230", "#111111"]
    : score >= 50 ? ["Normal", "NORMAL MODE", "#FBF9F3", "#111111"]
    : score >= 25 ? ["Hard", "HARD MODE", "#2B2924", "#F0EDE5"]
    : ["Nightmare", "NIGHTMARE MODE", "#C8201A", "#FFFFFF"];
  const obj = {
    iso, flag, en, ar, earn, noteEn, noteAr, hours, visa, births,
    blocked: !!blocked, baliVisa, usVisa, flightUsd,
    score, tier: tier[0], tierLabel: tier[1], bg: tier[2], fg: tier[3],
    worldBirthSharePct: Number((births / WORLD * 100).toFixed(2))
  };
  COUNTRIES[iso] = obj;
  return obj;
});

const MIME = {
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

fs.mkdirSync(DATA_DIR, { recursive: true });

function hashVoter(ip) {
  return crypto.createHash("sha256").update(ip + "|" + VOTE_SALT).digest("hex").slice(0, 24);
}
function safeAdminCheck(req) {
  if (!ADMIN_TOKEN) return false;
  const auth = String(req.headers["authorization"] || "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const a = Buffer.from(token);
  const b = Buffer.from(ADMIN_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* Storage layer: built-in node:sqlite (Node 22+) with automatic JSON fallback */
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
    CREATE TABLE IF NOT EXISTS votes_log (
      target TEXT NOT NULL,
      ip_hash TEXT NOT NULL,
      PRIMARY KEY (target, ip_hash)
    );
    INSERT OR IGNORE INTO meta (key, val) VALUES ('draws', 0), ('salutes', 0);
  `);

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
    } catch {}
  }

  const qMeta = sq.prepare("SELECT key, val FROM meta");
  const uDraws = sq.prepare("UPDATE meta SET val = val + ? WHERE key='draws'");
  const uSalute = sq.prepare("UPDATE meta SET val = MAX(0, val + ?) WHERE key='salutes'");
  const qBuilders = sq.prepare("SELECT id,name,handle,iso,tag,project,url,note,votes,created_at AS createdAt FROM builders ORDER BY votes DESC, rowid DESC LIMIT ?");
  const iBuilder = sq.prepare("INSERT INTO builders (id,name,handle,iso,tag,project,url,note,votes,created_at) VALUES (?,?,?,?,?,?,?,?,0,?)");
  const qExists = sq.prepare("SELECT votes FROM builders WHERE id = ?");
  const uVote = sq.prepare("UPDATE builders SET votes = MAX(0, votes + ?) WHERE id = ?");
  const iVoteLog = sq.prepare("INSERT OR IGNORE INTO votes_log (target, ip_hash) VALUES (?, ?)");
  const dVoteLog = sq.prepare("DELETE FROM votes_log WHERE target = ? AND ip_hash = ?");
  const dBuilder = sq.prepare("DELETE FROM builders WHERE id = ?");
  const dBuilderVotes = sq.prepare("DELETE FROM votes_log WHERE target = ?");

  store = {
    engine: "sqlite",
    getCounts() {
      const rows = Object.fromEntries(qMeta.all().map((r) => [r.key, r.val]));
      return { draws: rows.draws || 0, salutes: rows.salutes || 0 };
    },
    addDraws(n) { uDraws.run(n); return this.getCounts(); },
    toggleSalute(ipHash, delta) {
      if (delta > 0) {
        if (iVoteLog.run("salute", ipHash).changes) uSalute.run(1);
      } else {
        if (dVoteLog.run("salute", ipHash).changes) uSalute.run(-1);
      }
      return this.getCounts();
    },
    listBuilders() { return qBuilders.all(MAX_BUILDERS); },
    addBuilder(b) { iBuilder.run(b.id, b.name, b.handle, b.iso, b.tag, b.project, b.url, b.note, b.createdAt); return b; },
    voteBuilder(id, ipHash, delta) {
      const row = qExists.get(id);
      if (!row) return null;
      if (delta > 0) {
        if (iVoteLog.run(id, ipHash).changes) uVote.run(1, id);
      } else {
        if (dVoteLog.run(id, ipHash).changes) uVote.run(-1, id);
      }
      return qExists.get(id).votes;
    },
    deleteBuilder(id) {
      dBuilderVotes.run(id);
      return dBuilder.run(id).changes > 0;
    },
    close() { try { sq.close(); } catch {} }
  };
} else {
  let db = { draws: 0, salutes: 0, builders: [], votesLog: {} };
  try {
    const loaded = JSON.parse(fs.readFileSync(JSON_FILE, "utf8"));
    db.draws = Number(loaded.draws) || 0;
    db.salutes = Number(loaded.salutes) || 0;
    if (Array.isArray(loaded.builders)) db.builders = loaded.builders.slice(0, MAX_BUILDERS);
    if (loaded.votesLog && typeof loaded.votesLog === "object") db.votesLog = loaded.votesLog;
  } catch {}
  let dirty = false;
  function flushNow() {
    if (!dirty) return;
    dirty = false;
    try { fs.writeFileSync(JSON_FILE + ".tmp", JSON.stringify(db)); fs.renameSync(JSON_FILE + ".tmp", JSON_FILE); } catch {}
  }
  setInterval(flushNow, 4000);

  store = {
    engine: "json",
    getCounts() { return { draws: db.draws, salutes: db.salutes }; },
    addDraws(n) { db.draws += n; dirty = true; return this.getCounts(); },
    toggleSalute(ipHash, delta) {
      const k = "salute:" + ipHash;
      if (delta > 0 && !db.votesLog[k]) { db.votesLog[k] = 1; db.salutes += 1; dirty = true; }
      else if (delta < 0 && db.votesLog[k]) { delete db.votesLog[k]; db.salutes = Math.max(0, db.salutes - 1); dirty = true; }
      return this.getCounts();
    },
    listBuilders() { return [...db.builders].sort((a, b) => (b.votes || 0) - (a.votes || 0)); },
    addBuilder(b) { db.builders.unshift(b); if (db.builders.length > MAX_BUILDERS) db.builders.length = MAX_BUILDERS; dirty = true; flushNow(); return b; },
    voteBuilder(id, ipHash, delta) {
      const b = db.builders.find((x) => x.id === id);
      if (!b) return null;
      const k = id + ":" + ipHash;
      if (delta > 0 && !db.votesLog[k]) { db.votesLog[k] = 1; b.votes = (Number(b.votes) || 0) + 1; dirty = true; }
      else if (delta < 0 && db.votesLog[k]) { delete db.votesLog[k]; b.votes = Math.max(0, (Number(b.votes) || 0) - 1); dirty = true; }
      return Number(b.votes) || 0;
    },
    deleteBuilder(id) {
      const before = db.builders.length;
      db.builders = db.builders.filter((x) => x.id !== id);
      dirty = true; flushNow();
      return db.builders.length < before;
    },
    close() { flushNow(); }
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
function escAttr(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[m]));
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

function resolveBaseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const host = String(req.headers["x-forwarded-host"] || req.headers["host"] || "").split(",")[0].trim();
  if (!/^[a-zA-Z0-9.:-]+$/.test(host)) return "https://smailancer.github.io/DEVLottery";
  const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim() === "https" ? "https" : "http";
  return proto + "://" + host;
}

function renderIndexHtml(req) {
  const base = resolveBaseUrl(req);
  let html = indexHtmlTemplate.replace(/https:\/\/smailancer\.github\.io\/DEVLottery/g, base);
  const u = new URL(req.url || "/", "http://localhost");
  const a = COUNTRIES[(u.searchParams.get("a") || "").toUpperCase()];
  const b = COUNTRIES[(u.searchParams.get("b") || "").toUpperCase()];
  if (a && b && a !== b) {
    const isAr = u.searchParams.get("lang") === "ar";
    const hi = a.hours >= b.hours ? a : b, lo = hi === a ? b : a;
    const mult = hi.hours / lo.hours;
    const mStr = mult >= 1.95 ? Math.round(mult) + "x" : mult.toFixed(1) + "x";
    const title = isAr
      ? `${a.flag} ${a.ar} (${a.score}/100) مقابل ${b.flag} ${b.ar} (${b.score}/100) · DEV Lottery`
      : `${a.flag} ${a.en} (${a.score}/100 · ${a.tier}) vs ${b.flag} ${b.en} (${b.score}/100 · ${b.tier}) · DEV Lottery`;
    const desc = isAr
      ? `نفس الكود ونفس الاجتهاد، لكن خط البداية في ${hi.ar} أصعب بـ ${mStr} من ${lo.ar}. اختبر جواز سفرك.`
      : `Same code, same hustle — ${hi.en}'s starting line is ${mStr} harder than ${lo.en}. Test your passport.`;
    html = html
      .replace(/<title>[^<]*<\/title>/, `<title>${escAttr(title)}</title>`)
      .replace(/(property="og:title"\s+content=")[^"]*"/, `$1${escAttr(title)}"`)
      .replace(/(name="twitter:title"\s+content=")[^"]*"/, `$1${escAttr(title)}"`)
      .replace(/(property="og:description"\s+content=")[^"]*"/, `$1${escAttr(desc)}"`)
      .replace(/(name="twitter:description"\s+content=")[^"]*"/, `$1${escAttr(desc)}"`);
  }
  return html;
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

const ASSETS_DIR = path.join(ROOT, "assets");
function serveStatic(req, res, urlPath) {
  if (urlPath === "/" || urlPath === "/index.html") {
    const html = renderIndexHtml(req);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    return res.end(html);
  }
  const assetName = urlPath === "/favicon.ico" ? "favicon.svg"
    : (urlPath.startsWith("/assets/") ? urlPath.slice(8) : "");
  if (!assetName || !/^[a-zA-Z0-9._-]+$/.test(assetName)) {
    res.writeHead(404); return res.end("Not found");
  }
  const full = path.join(ASSETS_DIR, assetName);
  if (!full.startsWith(ASSETS_DIR + path.sep)) {
    res.writeHead(403); return res.end("Forbidden");
  }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "public, max-age=86400"
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  const urlPath = (req.url || "/").split("?")[0];
  const ip = getIp(req);

  if (req.method === "GET" && urlPath === "/health") {
    return sendJson(res, 200, { ok: true, engine: store.engine, countries: COUNTRIES_LIST.length });
  }
  if (req.method === "GET" && urlPath === "/api/countries") {
    return sendJson(res, 200, { totalWorldBirths: WORLD, count: COUNTRIES_LIST.length, countries: COUNTRIES_LIST });
  }
  if (req.method === "GET" && (urlPath === "/api/count" || urlPath === "/count")) {
    return sendJson(res, 200, store.getCounts());
  }
  if (req.method === "GET" && urlPath === "/api/builders") {
    return sendJson(res, 200, { builders: store.listBuilders() });
  }

  const bm = req.method === "GET" && urlPath.match(/^\/badge\/([a-zA-Z]{3})\.svg$/);
  if (bm) {
    const info = COUNTRIES[bm[1].toUpperCase()];
    if (!info) { res.writeHead(404); return res.end("Unknown country ISO"); }
    res.writeHead(200, { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    return res.end(renderBadgeSvg(info));
  }

  if (req.method === "POST" && (urlPath === "/api/draws" || urlPath === "/draws" || urlPath === "/api/salute" || urlPath === "/salute")) {
    return readBody(req, 256, (err, body) => {
      if (err) return sendJson(res, 413, { error: "payload too large" });
      let parsed = {};
      try { parsed = JSON.parse(body); } catch {}
      const used = hits.get(ip) || 0;
      if (urlPath.endsWith("/salute")) {
        if (used + 1 > MAX_HITS_PER_MIN) return sendJson(res, 429, { error: "slow down" });
        hits.set(ip, used + 1);
        return sendJson(res, 200, store.toggleSalute(hashVoter(ip), parsed.delta === -1 ? -1 : 1));
      }
      let n = parseInt(parsed.n, 10);
      if (!Number.isFinite(n) || n < 1) n = 1;
      n = Math.min(n, MAX_DRAWS_PER_REQ);
      if (used + n > MAX_HITS_PER_MIN) return sendJson(res, 429, { error: "slow down" });
      hits.set(ip, used + n);
      return sendJson(res, 200, store.addDraws(n));
    });
  }

  const vm = req.method === "POST" && urlPath.match(/^\/api\/builders\/([a-zA-Z0-9_-]{4,32})\/vote$/);
  if (vm) {
    const used = hits.get(ip) || 0;
    if (used + 1 > MAX_HITS_PER_MIN) return sendJson(res, 429, { error: "slow down" });
    hits.set(ip, used + 1);
    return readBody(req, 128, (err, body) => {
      if (err) return sendJson(res, 413, { error: "payload too large" });
      let parsed = {};
      try { parsed = JSON.parse(body); } catch {}
      const votes = store.voteBuilder(vm[1], hashVoter(ip), parsed.delta === -1 ? -1 : 1);
      if (votes === null) return sendJson(res, 404, { error: "builder not found" });
      return sendJson(res, 200, { id: vm[1], votes });
    });
  }

  const dm = req.method === "DELETE" && urlPath.match(/^\/api\/builders\/([a-zA-Z0-9_-]{4,32})$/);
  if (dm) {
    if (!safeAdminCheck(req)) return sendJson(res, 401, { error: "unauthorized" });
    const removed = store.deleteBuilder(dm[1]);
    return sendJson(res, removed ? 200 : 404, { ok: removed });
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
});

server.listen(PORT, () => console.log("DEV Lottery server running on :" + PORT + " (" + store.engine + ")"));

function shutdown() {
  server.close(() => { store.close(); process.exit(0); });
  setTimeout(() => { store.close(); process.exit(0); }, 2000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
