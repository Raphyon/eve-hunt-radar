// Hunt Radar — Electron overlay edition (Windows)
// Genesis / Kor-Azor / Kador (+ Armi pocket)
//
// Reads only: zKillboard's public kill feed, CCP's public ESI, EVE's own chat log files,
// EVE window titles, your clipboard, and (opt-in) a screenshot of the area you mark.
// Never reads or modifies the EVE client.
"use strict";
const { app, BrowserWindow, Tray, Menu, globalShortcut, clipboard, screen, nativeImage, shell, dialog, Notification } = require("electron");
const fs = require("fs"), path = require("path"), http = require("http"), os = require("os"), cp = require("child_process");

const VERSION = "v" + app.getVersion();
const UA = "hunt-radar/3.0 (personal tool; electron)";
const SSO = process.env.SSO_BASE || "https://login.eveonline.com";
const R2Z2 = process.env.R2Z2_BASE || "https://r2z2.zkillboard.com/ephemeral";
const ESI = process.env.ESI_BASE || "https://esi.evetech.net/latest";
const ZKB = process.env.ZKB_BASE || "https://zkillboard.com";
const PORT = +(process.env.HR_PORT || 8765);
const HERE = __dirname;
const HERE_UNPACKED = HERE.replace("app.asar", "app.asar.unpacked");   // files PowerShell must read from real disk
// Settings live in %APPDATA%\Hunt Radar so installs and updates never touch them.
const DATA_DIR = process.env.HR_DATA || (app.isPackaged ? app.getPath("userData") : path.join(HERE, "..", "data"));
fs.mkdirSync(DATA_DIR, { recursive: true });
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const TOKENS_FILE = path.join(DATA_DIR, "tokens.json");      // ESI refresh tokens — never share the data folder

const MAP = JSON.parse(fs.readFileSync(path.join(HERE, "data.json"), "utf8"));   // big-map page layout (3 regions) until region views land
const SHIPS = JSON.parse(fs.readFileSync(path.join(HERE, "ships.json"), "utf8"));

// ------------------------------------------------------------- map / graph
const dispSec = s => (s > 0 && s < 0.05) ? 0.1 : Math.floor(s * 10 + 0.5) / 10;   // game rounding: 0.45 -> 0.5
// All of known space (no wormholes). universe.json: sys = [id, name, sec, regionIdx, constIdx, x, y, z] (light years)
const U = JSON.parse(fs.readFileSync(path.join(HERE, "universe.json"), "utf8"));
const SYS = {}, BYNAME = {}, ADJ = {};
U.sys.forEach(([id, n, sec, ri, ci, x, y, z]) => {
  SYS[id] = { id, n, s: sec, r: U.regions[ri][1], c: U.consts[ci][1], p: x == null ? null : [x, y, z] };
  BYNAME[n.toLowerCase()] = id; ADJ[id] = [];
});
U.gates.forEach(([a, b]) => { const A = U.sys[a][0], B = U.sys[b][0]; ADJ[A].push(B); ADJ[B].push(A); });
const BAND = id => { const s = SYS[id]; if (!s) return null; if (s.r === "Pochven") return "poch"; const d = dispSec(s.s); return d <= 0 ? "null" : d < 0.5 ? "low" : "high"; };
const inSpace = id => { const b = BAND(id); return !!b && b !== "high" && settings.space[b] !== false; };   // never highsec / wormholes
const TYPES = {}; for (const k in SHIPS.types) TYPES[+k] = SHIPS.types[k];      // typeID -> [groupID, name]
const GROUP_CLASS = {}; for (const k in SHIPS.groupClass) GROUP_CLASS[+k] = SHIPS.groupClass[k];
function bfs(src, maxd = 99) {
  const d = new Map([[src, 0]]), q = [src];
  while (q.length) { const u = q.shift(); if (d.get(u) >= maxd) continue; for (const v of ADJ[u] || []) if (!d.has(v)) { d.set(v, d.get(u) + 1); q.push(v); } }
  return d;
}

// ------------------------------------------------------------- settings
const DEFAULTS = {
  watched: "Gonditsa, Ami, Fensi, Vecamia, Ahbazon, Beke, Armi, Kihkounad", ignore: "",
  camp: null, hunt: null,          // pre-v10, merged into "watched" on load
  classes: null,                 // pre-v10 fixed ship classes, migrated into watchlists on load
  watchlists: null,              // [{ name, on, groups, types (watched: feed/map), pgroups, ptypes (pinged: beep) }]
  victim: true, range: 3, sound: true, near: true, nearRange: 5, chatlogs: "",
  // v10: watch range (kills outside are dropped before any lookup) and space bands
  watchJumpsOn: true, watchJumps: 20, watchLyOn: true, watchLy: 16, space: { low: true, null: true, poch: true }, beepGap: 10,
  keyEdit: "Ctrl+Shift+O", keyMode: "Ctrl+Shift+M",
  localArea: null, lookupOn: true,
  jumpToons: {},                 // (unused since v9.3, kept for old settings files)
  autostart: false,
  esiClientId: "",               // optional: EVE developer app client ID, only for reading ship type
  overlay: { mode: "strip", strip: null, map: null, opacity: 0.85, mapJumps: 3 },
};
function loadJSON(p, d) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } }
let settings = Object.assign({}, DEFAULTS, loadJSON(SETTINGS_FILE, {}));
settings.overlay = Object.assign({}, DEFAULTS.overlay, settings.overlay || {});
{ const old = loadJSON(SETTINGS_FILE, {});          // v10: camp spots + hunting grounds -> one "watched systems" list
  if (old.watched == null && (old.camp || old.hunt)) settings.watched = [...new Set([old.camp, old.hunt].filter(Boolean).join(",").split(/[,\n;]+/).map(t => t.trim()).filter(Boolean))].join(", "); }
let saveTimer = null;
function saveSettings() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { fs.writeFileSync(SETTINGS_FILE + ".tmp", JSON.stringify(settings, null, 1)); fs.renameSync(SETTINGS_FILE + ".tmp", SETTINGS_FILE); } catch (e) { log("settings save failed:", e.message); } }, 300); }

// ------------------------------------------------------------- state
const events = []; const alerts = [];
let evSeq = 0, alSeq = 0, heat = {}, heatAt = 0;
const status = { feed: "starting", seen: 0, kept: 0, last_ok: 0, heat: "pending", err: "", live: false };
const names = new Map();               // id -> name
const seen = new Map();                // character_id -> recent appearances on area kills
const chars = new Map();               // character name -> {sys, sysName, t, running}
const local = { sys: null, t: 0, pilots: [], count: 0, resolving: false, source: "paste" };
const localCounts = {};                // system_id -> [count, time]
const zstats = new Map(); const statQueue = [];
const snap = { busy: false, msg: "", t: 0 };
const log = (...a) => console.log(new Date().toTimeString().slice(0, 8), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => Date.now() / 1000;

// ------------------------------------------------------------- http
async function get(url, { body, headers, timeout = 20000 } = {}) {
  const h = Object.assign({ "User-Agent": UA, "Accept": "application/json" }, headers || {});
  if (body !== undefined) h["Content-Type"] = "application/json";
  try {
    const r = await fetch(url, { method: body !== undefined ? "POST" : "GET", headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout) });
    const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch { }
    return [r.status, j];
  } catch (e) { return [0, null, e]; }
}
async function resolveNames(ids) {
  const todo = [...new Set(ids.filter(Boolean))].filter(i => !names.has(i));
  for (let k = 0; k < todo.length; k += 900) {
    const chunk = todo.slice(k, k + 900);
    const [c, b] = await get(`${ESI}/universe/names/`, { body: chunk });
    if (c === 200 && b) b.forEach(o => names.set(o.id, o.name));
    else if (c === 404 && chunk.length > 1) { await resolveNames(chunk.slice(0, chunk.length >> 1)); await resolveNames(chunk.slice(chunk.length >> 1)); }
    else chunk.forEach(i => { if (!names.has(i)) names.set(i, null); });
  }
}
async function shipInfo(tid) {
  if (!tid) return [0, "?"];
  if (TYPES[tid]) return TYPES[tid];
  const [c, b] = await get(`${ESI}/universe/types/${tid}/`);
  TYPES[tid] = (c === 200 && b) ? [b.group_id || 0, b.name || `type ${tid}`] : [0, `type ${tid}`];
  return TYPES[tid];
}
// ---- ship watchlists: a ship is watched if its type, or its whole group, is in any enabled list
if (!Array.isArray(settings.watchlists)) {
  const cls = settings.classes || {};
  settings.watchlists = [{ name: "Default", on: true, types: [], groups: [], ptypes: [],
    pgroups: Object.keys(GROUP_CLASS).filter(g => cls[GROUP_CLASS[g]] !== false).map(Number) }];
}
// beta.4 lists had only "groups/types" and everything in them beeped: keep that behaviour as "pinged"
settings.watchlists.forEach(l => { if (!l.pgroups && !l.ptypes) { l.pgroups = l.groups || []; l.ptypes = l.types || []; l.groups = []; l.types = []; } });
let wsCache = { key: null, g: new Set(), t: new Set() };
function watchSets() {
  const key = JSON.stringify(settings.watchlists); if (key === wsCache.key) return wsCache;
  const g = new Set(), t = new Set(), pg = new Set(), pt = new Set();
  (settings.watchlists || []).filter(l => l.on !== false).forEach(l => {
    (l.groups || []).forEach(x => g.add(+x)); (l.types || []).forEach(x => t.add(+x));
    (l.pgroups || []).forEach(x => { pg.add(+x); g.add(+x); }); (l.ptypes || []).forEach(x => { pt.add(+x); t.add(+x); }); });
  return wsCache = { key, g, t, pg, pt };
}
const isWatched = p => { const W = watchSets(); return !!p && (W.t.has(+p.ship || +p.type) || W.g.has(+p.group)); };   // ✓ or ✗
const isPinged = p => { const W = watchSets(); return !!p && (W.pt.has(+p.ship || +p.type) || W.pg.has(+p.group)); };   // ✗ only

// ------------------------------------------------------------- targets / alerts
function parseTargets(txt) {
  const out = new Set();
  for (const t of String(txt || "").split(/[,\n;]+/)) {
    const k = t.trim().toLowerCase(); if (!k) continue;
    if (BYNAME[k]) out.add(BYNAME[k]);
    for (const id in SYS) if (SYS[id].c.toLowerCase() === k || SYS[id].r.toLowerCase() === k) out.add(+id);
  }
  return out;
}
let ignCache = { txt: null, set: new Set() };
function ignored() { if (ignCache.txt !== settings.ignore) ignCache = { txt: settings.ignore, set: parseTargets(settings.ignore) }; return ignCache.set; }
function runningChars() { return [...chars.entries()].filter(([, c]) => c.running !== false); }
function anchors() { const a = new Set(parseTargets(settings.watched)); runningChars().forEach(([, c]) => { if (SYS[c.sys]) a.add(c.sys); }); return a; }
function nearestAnchor(sid) {
  const A = anchors(); if (!A.size || !SYS[sid]) return [99, "-"];
  const d = bfs(sid, 12); let best = [99, null];
  A.forEach(x => { if (d.has(x) && d.get(x) < best[0]) best = [d.get(x), x]; });
  if (!best[1]) return [99, "-"];
  const who = runningChars().find(([, c]) => c.sys === best[1]);
  return [best[0], who ? who[0] + " (you)" : SYS[best[1]].n];
}
// ---- watch range: union of <= N gate jumps from any running character and <= X LY from any jump toon
let watchCache = { key: "", set: new Set() };
function watchSet() {
  const run = runningChars().filter(([, c]) => SYS[c.sys]);
  const J = typeof jumpView === "function" ? jumpView() : [];
  const key = [settings.watchJumpsOn, settings.watchJumps, settings.watchLyOn, settings.watchLy, JSON.stringify(settings.space),
    run.map(([n, c]) => n + c.sys).join(), J.map(j => j.name + j.sysName).join()].join("|");
  if (key === watchCache.key) return watchCache.set;
  const set = new Set();
  if (settings.watchJumpsOn) run.forEach(([, c]) => bfs(c.sys, +settings.watchJumps || 20).forEach((_, id) => set.add(id)));
  if (settings.watchLyOn) J.forEach(j => { const from = coordsOf(j.sysName); if (!from) return;
    for (const id in SYS) { const p = SYS[id].p; if (p && lyBetween(from, p) <= (+settings.watchLy || 16)) set.add(+id); } });
  for (const id of [...set]) if (!inSpace(id)) set.delete(id);
  watchCache = { key, set }; return set;
}
let lastBeep = 0;
function maybeAlert(ev) {
  // v10 rules:  <= beep radius of the character you fly: any PvP (klaxon) / watched ship (beep)
  //             near camp/hunt targets (within watch range): watched ships only (beep)
  //             everything else in watch range: silent (feed + map)
  if (!status.live) return;
  if (ignored().has(ev.sys)) return;
  const a = ev.attackers.filter(isPinged);                // only ✗ (pinged) ships beep; ✓ ships just show in feed/map
  const v = isPinged(ev.victim) && settings.victim;
  const watched = !!(a.length || v);
  const me = activeChar(), mySys = me && chars.get(me).sys;
  const R = +settings.nearRange || 5;
  const meDist = SYS[mySys] ? (bfs(mySys, Math.max(R, 40)).get(ev.sys) ?? null) : null;
  const nearMe = meDist !== null && meDist <= R;
  const T = parseTargets(settings.watched);
  let tDist = 99, tName = null;
  if (watched && T.size) { const d = bfs(ev.sys, +settings.range || 3); T.forEach(t => { if (d.has(t) && d.get(t) < tDist) { tDist = d.get(t); tName = SYS[t].n; } }); }
  const nearTarget = watched && tName !== null;
  if (!(nearMe && (watched || settings.near)) && !nearTarget) return;
  const what = a.length ? [...new Set(a.map(p => p.shipName))].sort().join(", ")
    : v ? ev.victim.shipName + " died"
      : `${ev.victim.shipName} killed by ${ev.attackers.length} (${[...new Set(ev.attackers.map(p => p.shipName))].slice(0, 3).join(", ")})`;
  const t = now(), silent = t - lastBeep < (+settings.beepGap || 0); if (!silent) lastBeep = t;
  alerts.push({ n: ++alSeq, t, sys: ev.sys, sysName: SYS[ev.sys].n, sec: dispSec(SYS[ev.sys].s), dist: nearMe ? meDist : tDist, near: nearMe ? me + " (you)" : tName,
    meDist, jumpers: jumpersFor(ev.sys), what, attacker: a.length > 0, watched, nearMe, silent, link: ev.link });
  if (alerts.length > 50) alerts.shift();
  log(`ALERT${nearMe ? " [NEAR YOU]" : " [TARGET]"}${silent ? " (silent)" : ""} ${SYS[ev.sys].n}: ${what}`);
}

// ------------------------------------------------------------- kill feed (zKillboard R2Z2)
async function handle(pkg) {
  const km = pkg.esi || pkg.killmail || {}, zkb = pkg.zkb || {}, sid = km.solar_system_id;
  status.seen++;
  if (!inSpace(sid) || zkb.npc || !watchSet().has(sid)) return;     // out of watch range: dropped before any lookup
  const atk = (km.attackers || []).filter(x => x.character_id); if (!atk.length) return;
  const v = km.victim || {};
  await resolveNames([v, ...atk].flatMap(p => [p.character_id, p.corporation_id, p.alliance_id]));
  const pack = async p => { const [g, n] = await shipInfo(p.ship_type_id); return { ship: p.ship_type_id, shipName: n, group: g, char: p.character_id, charName: names.get(p.character_id), corpName: names.get(p.corporation_id), alliName: names.get(p.alliance_id), fb: !!p.final_blow }; };
  const kid = km.killmail_id || pkg.killmail_id;
  const ev = { id: kid, time: km.killmail_time, sys: sid, sysName: SYS[sid].n, sec: dispSec(SYS[sid].s), region: SYS[sid].r, val: zkb.totalValue || 0, solo: !!zkb.solo, victim: await pack(v), attackers: await Promise.all(atk.map(pack)), link: `https://zkillboard.com/kill/${kid}/`, n: ++evSeq };
  events.push(ev); if (events.length > 600) events.shift();
  for (const [role, p] of [["victim", ev.victim], ...ev.attackers.map(p => ["attacker", p])]) {
    if (!p.char) continue; const l = seen.get(p.char) || [];
    l.unshift({ t: ev.time, sys: sid, ship: p.shipName, type: p.ship, group: p.group, role }); seen.set(p.char, l.slice(0, 5));
  }
  status.kept++;
  log(`KILL ${SYS[sid].n}: ${ev.victim.shipName} (${ev.victim.charName}) by ${atk.length}`);
  maybeAlert(ev);
}
async function feedLoop(backfill) {
  let seq = null;
  for (; ;) {
    try {
      if (seq === null) {
        const [c, b] = await get(`${R2Z2}/sequence.json`);
        if (c !== 200 || !b) throw new Error(`sequence.json HTTP ${c}`);
        seq = +b.sequence - backfill; log(`feed: starting at ${seq} (replaying ~${backfill}, no alerts for those)`);
      }
      const [c, b] = await get(`${R2Z2}/${seq}.json`);
      if (c === 200 && b) { await handle(b); seq = +(b.sequence_id ?? seq) + 1; Object.assign(status, { feed: status.live ? "live" : "catching up", last_ok: now(), err: "" }); await sleep(120); }
      else if (c === 404) { if (!status.live) log("feed: live, alerts on"); Object.assign(status, { feed: "live", live: true, last_ok: now() }); await sleep(6000); }
      else throw new Error(`HTTP ${c} on sequence ${seq}`);
    } catch (e) { Object.assign(status, { feed: "error", err: String(e.message || e).slice(0, 200) }); log("feed error:", e.message); await sleep(15000); }
  }
}
async function heatLoop() {
  for (; ;) {
    try {
      const [c1, kills] = await get(`${ESI}/universe/system_kills/`), [c2, jumps] = await get(`${ESI}/universe/system_jumps/`);
      if (c1 !== 200 || c2 !== 200) throw new Error(`ESI kills ${c1} / jumps ${c2}`);
      const h = {};
      (jumps || []).forEach(j => { if (BAND(j.system_id) && BAND(j.system_id) !== "high") (h[j.system_id] = h[j.system_id] || [0, 0, 0, 0])[0] = j.ship_jumps; });
      (kills || []).forEach(k => { if (BAND(k.system_id) && BAND(k.system_id) !== "high") { const r = h[k.system_id] = h[k.system_id] || [0, 0, 0, 0]; r[1] = k.ship_kills; r[2] = k.pod_kills; r[3] = k.npc_kills; } });
      heat = h; heatAt = now(); status.heat = "ok"; await sleep(600000);
    } catch (e) { status.heat = "error: " + String(e.message).slice(0, 120); await sleep(60000); }
  }
}

// ------------------------------------------------------------- best hunting spots near you
function bestNearby(maxj = 6, n = 8) {
  const src = primarySys(); const origins = src ? [src] : [...parseTargets(settings.watched)];
  if (!origins.length) return [];
  const dist = new Map(); origins.forEach(o => bfs(o, maxj).forEach((v, k) => dist.set(k, Math.min(dist.get(k) ?? 99, v))));
  const recent = {}; const t0 = now();
  events.forEach(e => { const t = Date.parse(e.time) / 1000; if (t0 - t < 3600 && (e.attackers.some(isWatched) || isWatched(e.victim))) recent[e.sys] = (recent[e.sys] || 0) + 1; });
  const rows = [];
  const IG = ignored();
  dist.forEach((d, sid) => {
    if (!inSpace(sid) || IG.has(sid)) return;
    const [j, k, p, npc] = heat[sid] || [0, 0, 0, 0]; const w = recent[sid] || 0;
    const score = npc + 40 * w + 8 * (k + p); if (score <= 0) return;
    rows.push({ sys: sid, n: SYS[sid].n, sec: dispSec(SYS[sid].s), j: d, npc, kills: k + p, jumps: j, watched: w, score: Math.round(score / (1 + 0.35 * d) * 10) / 10, local: localCounts[sid] || null });
  });
  const J = jumpView();
  return rows.sort((a, b) => b.score - a.score).slice(0, n).map(r => Object.assign(r, { jumpers: J.filter(j => j.inRange.includes(r.sys)).map(j => j.name) }));
}

// ------------------------------------------------------------- Windows helper (window titles, OCR, keys)
const helper = { proc: null, ready: false, queue: [], buf: "" };
function startHelper() {
  if (process.platform !== "win32") return;
  const ps1 = path.join(HERE_UNPACKED, "win.ps1");
  helper.proc = cp.spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1], { windowsHide: true });
  helper.proc.stdout.setEncoding("utf8");
  helper.proc.stdout.on("data", d => {
    helper.buf += d; let i;
    while ((i = helper.buf.indexOf("\n")) >= 0) {
      const line = helper.buf.slice(0, i).trim(); helper.buf = helper.buf.slice(i + 1); if (!line) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (j.ready) { helper.ready = true; log("windows helper ready"); setTimeout(syncHook, 100); continue; }
      const w = helper.queue.shift(); if (w) w(j);
    }
  });
  helper.proc.stderr.on("data", d => log("helper:", String(d).trim().slice(0, 200)));
  helper.proc.on("exit", () => { helper.ready = false; helper.queue.splice(0).forEach(w => w({ error: "helper exited" })); setTimeout(startHelper, 3000); });
}
function helperCmd(cmd, timeout = 15000) {
  return new Promise(res => {
    if (!helper.ready) return res({ error: "helper not ready" });
    let done = false; const w = j => { if (!done) { done = true; res(j); } };
    helper.queue.push(w); helper.proc.stdin.write(cmd + "\n");
    setTimeout(() => { if (!done) { done = true; const i = helper.queue.indexOf(w); if (i >= 0) helper.queue.splice(i, 1); res({ error: "timeout" }); } }, timeout);
  });
}
// Test hook off Windows: HR_FAKE_WINDOWS="Name A|Name B;fg=Name A"
async function eveWindows() {
  if (process.platform !== "win32") {
    const f = process.env.HR_FAKE_WINDOWS; if (!f) return null;
    const [list, fg] = f.split(";fg="); return { titles: list.split("|").filter(Boolean), fg: fg || null };
  }
  const j = await helperCmd("WIN", 3000); if (j.error) return null;
  const arr = v => Array.isArray(v) ? v : (v ? [v] : []);           // PowerShell may unwrap 1-item arrays
  let clicks = arr(j.clicks); if (clicks.length === 2 && typeof clicks[0] === "number") clicks = [clicks];
  return { titles: arr(j.titles), fg: j.fg || null, clicks };
}

// ------------------------------------------------------------- characters: chat logs + window titles
function chatlogDirs() {
  if (settings.chatlogs) return [settings.chatlogs];
  if (process.env.HR_CHATLOGS) return [process.env.HR_CHATLOGS];
  const home = os.homedir();
  return ["Documents", "OneDrive/Documents", "OneDrive/Dokumenter", "Dokumenter"].map(d => path.join(home, d, "EVE", "logs", "Chatlogs")).filter(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
}
const LISTENER_RE = /Listener:\s*(.+?)\s*$/, CHANGE_RE = /Channel changed to Local\s*:\s*(.+?)\s*\*?\s*$/, STAMP_RE = /\[\s*(\d{4})\.(\d\d)\.(\d\d) (\d\d):(\d\d):(\d\d)\s*\]/;
const logfiles = new Map();
const chatlog = { dir: null, files: 0, err: "", ver: 0 };
function scanChatlogs() {
  const dirs = chatlogDirs();
  if (!dirs.length) { Object.assign(chatlog, { dir: null, err: "EVE chat log folder not found (Documents\\EVE\\logs\\Chatlogs)" }); return; }
  const d = dirs[0]; Object.assign(chatlog, { dir: d, err: "" });
  let files; try { files = fs.readdirSync(d).filter(f => /^local_.*\.txt$/i.test(f)).map(f => path.join(d, f)); } catch (e) { chatlog.err = e.message; return; }
  const cutoff = Date.now() - 12 * 3600e3;
  files = files.map(f => { try { const st = fs.statSync(f); return [f, st]; } catch { return null; } }).filter(x => x && x[1].mtimeMs > cutoff).sort((a, b) => a[1].mtimeMs - b[1].mtimeMs);
  chatlog.files = files.length;
  for (const [f, st] of files) {
    let s = logfiles.get(f);
    try {
      if (!s) { const fd = fs.openSync(f, "r"), head = Buffer.alloc(4); fs.readSync(fd, head, 0, 4, 0); fs.closeSync(fd);
        s = { off: 0, listener: null, enc: (head[0] === 0xff && head[1] === 0xfe) || head[1] === 0 ? "utf16le" : "utf8" }; logfiles.set(f, s); }
      if (st.size <= s.off) continue;
      const fd = fs.openSync(f, "r"); let len = st.size - s.off; if (s.enc === "utf16le" && len % 2) len--;
      const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, s.off); fs.closeSync(fd); s.off += len;
      for (const line of buf.toString(s.enc).replace(/^﻿/, "").split(/\r?\n/)) {
        let m = LISTENER_RE.exec(line); if (m && !s.listener) { s.listener = m[1]; continue; }
        m = CHANGE_RE.exec(line);
        if (m && s.listener) {
          const nm = m[1].trim(), sid = BYNAME[nm.toLowerCase()] || null, ts = STAMP_RE.exec(line);
          const t = ts ? Date.UTC(+ts[1], ts[2] - 1, +ts[3], +ts[4], +ts[5], +ts[6]) / 1000 : now();
          const c = chars.get(s.listener) || {}; chars.set(s.listener, c);
          if (t >= (c.t || 0)) { if (c.sysName !== nm) chatlog.ver++; Object.assign(c, { sys: sid, sysName: nm, t }); }
        }
      }
    } catch (e) { chatlog.err = `${path.basename(f)}: ${e.message}`; }
  }
}
const FG = { name: null, running: [] };
let charsVer = 0;
async function pollWindows() {
  const w = await eveWindows(); if (!w) return false;
  (w.clicks || []).forEach(([x, y]) => onMiddleClick(x, y));
  const fg = w.fg || FG.name;
  const changed = fg !== FG.name || w.titles.join("|") !== FG.running.join("|");
  FG.name = fg; FG.running = w.titles;
  if (changed) { w.titles.forEach(n => { if (!chars.has(n)) chars.set(n, {}); }); chars.forEach((c, n) => c.running = w.titles.includes(n)); charsVer++; }
  return changed;
}
function activeChar() {
  if (FG.name && chars.has(FG.name)) return FG.name;
  let best = null; chars.forEach((c, n) => { if (c.running !== false && c.sys && (!best || (c.t || 0) > (chars.get(best).t || 0))) best = n; });
  return best;
}
function primarySys() { const n = activeChar(); return n ? chars.get(n).sys : null; }
function charView() {
  const act = activeChar();
  return [...chars.entries()].sort((a, b) => (a[1].running === false) - (b[1].running === false) || a[0].localeCompare(b[0]))
    .map(([n, c]) => { const s = SYS[c.sys]; return { name: n, sys: c.sys, sysName: c.sysName || null, sec: s ? dispSec(s.s) : null, inMap: !!s, running: c.running !== false, active: n === act, t: c.t || null }; });
}

// ------------------------------------------------------------- local intel (clipboard / snapshot)
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 '.\-]{1,36}$/;
function looksLikeLocal(text) {
  if (!text || text.includes("\t")) return null;
  const lines = text.replace(/\r/g, "").split("\n").map(l => l.trim()).filter(Boolean);
  if (!lines.length || lines.length > 1500) return null;
  if (!lines.every(l => NAME_RE.test(l) && !l.includes("  "))) return null;
  if (lines.length === 1 && BYNAME[lines[0].toLowerCase()]) return null;
  return [...new Set(lines)];
}
async function analyseLocal(pilotNames, source = "paste") {
  if (source === "paste") { local.pasted = pilotNames.slice(); local.pastedAt = now(); }
  const sid = primarySys();
  Object.assign(local, { sys: sid, t: now(), count: pilotNames.length, resolving: true, source, pilots: pilotNames.map(n => ({ name: n })) });
  if (sid) localCounts[sid] = [pilotNames.length, now()];
  try {
    let ids = [];
    for (let k = 0; k < pilotNames.length; k += 500) { const [c, b] = await get(`${ESI}/universe/ids/`, { body: pilotNames.slice(k, k + 500) }); if (c === 200 && b) ids = ids.concat(b.characters || []); }
    const aff = {}; const idl = ids.map(o => o.id);
    for (let k = 0; k < idl.length; k += 1000) { const [c, b] = await get(`${ESI}/characters/affiliation/`, { body: idl.slice(k, k + 1000) }); if (c === 200 && b) b.forEach(a => aff[a.character_id] = a); }
    await resolveNames(Object.values(aff).flatMap(a => [a.corporation_id, a.alliance_id]));
    const mine = new Set([...chars.keys()].map(n => n.toLowerCase()));
    local.pilots = ids.map(o => { const a = aff[o.id] || {}; const me = mine.has(o.name.toLowerCase());
      if (!me && !zstats.has(o.id) && !statQueue.includes(o.id)) statQueue.push(o.id);
      return { id: o.id, name: o.name, corp: names.get(a.corporation_id), alli: names.get(a.alliance_id), me, seen: (seen.get(o.id) || []).slice(0, 3) }; });
    if (source === "snapshot") { local.count = local.pilots.length; if (sid) localCounts[sid] = [local.pilots.length, now()]; }
    log(`local: ${local.pilots.length} pilots${SYS[sid] ? " in " + SYS[sid].n : ""} (${source})`);
  } catch (e) { log("local error:", e.message); }
  local.resolving = false;
}
async function statsLoop() {
  for (; ;) {
    if (!statQueue.length) { await sleep(500); continue; }
    const cid = statQueue.shift(); if (zstats.has(cid)) continue;
    const [c, b] = await get(`${ZKB}/api/stats/characterID/${cid}/`);
    zstats.set(cid, (c === 200 && b && typeof b === "object") ? { danger: b.dangerRatio ?? null, gang: b.gangRatio ?? null, kills: b.shipsDestroyed ?? null, losses: b.shipsLost ?? null } : {});
    await sleep(1200);    // be polite to zKillboard
  }
}
function localView() {
  const ps = local.pilots.map(p => Object.assign({}, p, { st: zstats.get(p.id) || null, hot: (p.seen || []).some(s => isWatched(s) && s.role === "attacker") }));
  ps.sort((a, b) => (b.hot - a.hot) || (((b.st || {}).danger ?? -1) - ((a.st || {}).danger ?? -1)) || a.name.localeCompare(b.name));
  const g = {}; ps.filter(p => p.id && !p.me).forEach(p => { const k = p.alli || p.corp || "?"; g[k] = (g[k] || 0) + 1; });
  return { sys: local.sys, sysName: SYS[local.sys] ? SYS[local.sys].n : null, t: local.t, count: local.count, resolving: local.resolving, source: local.source, pilots: ps, groups: Object.entries(g).sort((a, b) => b[1] - a[1]).slice(0, 6) };
}
function cleanOcrLine(l) {
  let t = l.trim().replace(/^[^A-Za-z0-9]+/, "").replace(/[^A-Za-z0-9 '.\-]/g, "").replace(/\s{2,}/g, " ").trim();
  return NAME_RE.test(t) ? t : null;
}
let lastClip = null, clipBusy = false;
async function pollClipboard() {
  if (clipBusy) return; clipBusy = true;
  try {
    let c = await clipboard.readText();          // returns a Promise in Electron 45+
    c = typeof c === "string" ? c : "";
    if (c && c !== lastClip) { lastClip = c; const ps = looksLikeLocal(c); if (ps) analyseLocal(ps, "paste"); }
  } catch (e) { } finally { clipBusy = false; }
}

// ------------------------------------------------------------- jump range (blops / capitals)
// BASE ranges (post-Phoebe). Jump Drive Calibration adds +20% per level (read from ESI skills; V assumed if unknown).
const JUMP = {
  BLOPS: ["Black Ops", 4], DREAD: ["Dreadnought", 3.5], LANCER: ["Lancer dreadnought", 4], CARRIER: ["Carrier", 3.5],
  FAX: ["Force auxiliary", 3.5], CMDCAR: ["Command carrier", 3.75], SUPER: ["Supercarrier", 3], TITAN: ["Titan", 3],
  JF: ["Jump freighter", 5], RORQ: ["Rorqual", 5],
};
const JDC_SKILL = 21611;
const jumpRange = (key, jdc) => Math.round(JUMP[key][1] * (1 + 0.2 * (jdc ?? 5)) * 100) / 100;
const LY = 9.4607e15;
// positions in LY: bundled for known space; systems without one (new regions) are fetched from ESI once
const coordFetched = {}, coordPending = new Set();
async function fetchCoords(id) {
  if (coordPending.has(id)) return; coordPending.add(id);
  try {
    const [c, b] = await get(`${ESI}/universe/systems/${id}/`);
    const p = c === 200 && b && b.position;
    coordFetched[id] = p ? [p.x / LY, p.y / LY, p.z / LY] : null;
    if (p) log(`coords: ${SYS[id] ? SYS[id].n : id}`);
  } finally { coordPending.delete(id); }
}
function coordsOf(sysName) {
  if (!sysName) return null; const id = BYNAME[sysName.toLowerCase()]; if (!id) return null;
  if (SYS[id].p) return SYS[id].p;
  if (coordFetched[id] === undefined) fetchCoords(id);
  if (coordFetched[id]) SYS[id].p = coordFetched[id];
  return coordFetched[id] || null;
}
const lyBetween = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
// ---- optional ESI login: reads ship type only (scope esi-location.read_ship_type.v1)
const crypto = require("crypto");
const JUMP_GROUP = { 898: "BLOPS", 485: "DREAD", 4594: "LANCER", 547: "CARRIER", 1538: "FAX", 5120: "CMDCAR", 659: "SUPER", 30: "TITAN", 902: "JF", 883: "RORQ" };
const esi = { tokens: loadJSON(TOKENS_FILE, {}), ships: {}, pending: {}, err: "" };   // ships: name -> {shipName, key, t}
const b64url = b => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function saveTokens() { try { fs.writeFileSync(TOKENS_FILE, JSON.stringify(esi.tokens, null, 1)); } catch (e) { log("tokens save failed:", e.message); } }
function esiLoginUrl() {
  const verifier = b64url(crypto.randomBytes(32)), challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = b64url(crypto.randomBytes(12)); esi.pending[state] = verifier;
  const q = new URLSearchParams({ response_type: "code", redirect_uri: `http://localhost:${PORT}/callback`, client_id: settings.esiClientId.trim(),
    scope: "esi-location.read_ship_type.v1 esi-skills.read_skills.v1", code_challenge: challenge, code_challenge_method: "S256", state });
  return `${SSO}/v2/oauth/authorize/?${q}`;
}
async function tokenRequest(fields) {
  const r = await fetch(`${SSO}/v2/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "Host": new URL(SSO).host, "User-Agent": UA },
    body: new URLSearchParams(fields).toString(), signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => null); if (!r.ok || !j) throw new Error(`SSO HTTP ${r.status}`); return j;
}
function storeToken(j) {
  const pl = JSON.parse(Buffer.from(j.access_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
  const id = +String(pl.sub).split(":").pop();
  esi.tokens[id] = { name: pl.name, refresh: j.refresh_token, access: j.access_token, exp: Date.now() + (j.expires_in || 1199) * 1000 - 60000 };
  saveTokens(); return esi.tokens[id];
}
async function readShip(id) {
  const t = esi.tokens[id]; if (!t) return;
  try {
    if (!t.access || Date.now() > (t.exp || 0)) {
      const j = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh, client_id: settings.esiClientId.trim() });
      Object.assign(t, storeToken(j));
    }
    const [c, b] = await get(`${ESI}/characters/${id}/ship/`, { headers: { Authorization: `Bearer ${t.access}` } });
    if (c === 200 && b) { const [g, nm] = await shipInfo(b.ship_type_id); esi.ships[t.name] = { shipName: nm, key: JUMP_GROUP[g] || null, t: now() }; t.err = ""; }
    else t.err = `ESI ${c}`;
    if (!t.skillsAt || Date.now() - t.skillsAt > 15 * 60e3) {          // skills change rarely: every 15 min
      const [c2, b2] = await get(`${ESI}/characters/${id}/skills/`, { headers: { Authorization: `Bearer ${t.access}` } });
      t.skillsAt = Date.now();
      if (c2 === 200 && b2) { const sk = (b2.skills || []).find(x => x.skill_id === JDC_SKILL); t.jdc = sk ? (sk.active_skill_level ?? sk.trained_skill_level ?? 0) : 0; t.skillErr = ""; }
      else { t.jdc = null; t.skillErr = c2 === 403 || c2 === 401 ? "log in again to read skills" : `skills ESI ${c2}`; }
    }
  } catch (e) { t.err = String(e.message).slice(0, 80); }
}
async function esiShipLoop() {
  for (; ;) { for (const id of Object.keys(esi.tokens)) await readShip(id); await sleep(20000); }
}
function hullOf(name) {   // ESI only: a toon counts as a jumper while ESI says it sits in a jump-drive hull
  const e = esi.ships[name];
  return e && now() - e.t < 300 ? { key: e.key, src: "ESI", ship: e.shipName } : { key: null, src: null, ship: null };
}

let jvCache = { t: 0, v: [] };
function jumpView() {
  if (Date.now() - jvCache.t < 1000) return jvCache.v;
  const out = [];
  for (const id of Object.keys(esi.tokens)) {
    const name = esi.tokens[id].name, c = chars.get(name) || {};
    const h = hullOf(name); if (!h.key || !JUMP[h.key]) continue;
    const jdc = esi.tokens[id].jdc ?? null, range = jumpRange(h.key, jdc), sysName = c.sysName || null, from = coordsOf(sysName);
    const v = { name, clsName: h.ship, range, jdc, jdcKnown: jdc !== null, sysName, known: !!from, inRange: [] };
    if (from) for (const sid in SYS) { const p = SYS[sid].p; if (p && inSpace(+sid) && lyBetween(from, p) <= range) v.inRange.push(+sid); }
    out.push(v);
  }
  jvCache = { t: Date.now(), v: out };
  return out;
}
function jumpersFor(sid) {   // names of jump toons that can reach this system
  return jumpView().filter(j => j.inRange.includes(sid)).map(j => j.name);
}
function jumpToonsView() {   // ESI-logged toons and what they fly
  return Object.entries(esi.tokens).map(([id, t]) => ({ name: t.name, id: +id, err: t.err || "", ship: esi.ships[t.name] || null, jdc: t.jdc ?? null, skillErr: t.skillErr || "" })).sort((a, b) => a.name.localeCompare(b.name));
}

// ------------------------------------------------------------- pilot lookup (middle-click a name in Local)
let hookOn = null;
async function syncHook() {
  const want = !!(settings.lookupOn && settings.localArea);
  if (want === hookOn || !helper.ready) return;
  const j = await helperCmd("HOOK " + (want ? "ON" : "OFF"), 3000); if (!j.error) hookOn = want;
}
const card = { win: null, data: null, seq: 0 };
const AREA_SLACK = 14;   // px: clicks just outside the marked box (e.g. a cut-off top/bottom row) still count
function insideArea(x, y) { const a = settings.localArea, m = AREA_SLACK; return a && x >= a[0] - m && x <= a[0] + a[2] + m && y >= a[1] - m && y <= a[1] + a[3] + m; }
async function onMiddleClick(x, y) {
  if (!settings.lookupOn) return;
  if (!insideArea(x, y)) { hideCard(); return; }          // middle-click anywhere else closes the card
  // capture a strip centred on the click, NOT clamped to the marked box, so the top/bottom rows are never cut in half
  const a = settings.localArea, half = 28, top = y - half, bot = y + half;
  const seq = ++card.seq;
  showCard({ state: "reading", at: [x, y] });
  const j = await helperCmd(`OCRL ${a[0]} ${top} ${a[2]} ${bot - top} ${path.join(os.tmpdir(), "hunt_radar_row.png")}`, 15000);
  if (seq !== card.seq) return;
  if (j.error) return showCard({ state: "error", msg: "couldn't read that row: " + j.error, at: [x, y] });
  let lines = Array.isArray(j.lines) ? j.lines : (j.lines ? [j.lines] : []);
  const cy = y - top;
  // prefer the line whose box contains the cursor; otherwise the nearest one
  lines = lines.map(l => { const yc = +l.y || 0, hh = (+l.h || 14) / 2 + 2; return { t: cleanOcrLine(String(l.t || "")), dy: Math.abs(yc - cy) - (Math.abs(yc - cy) <= hh ? 1000 : 0) }; })
    .filter(l => l.t).sort((p, q) => p.dy - q.dy);
  if (!lines.length) return showCard({ state: "error", msg: "no name under the cursor", at: [x, y] });
  showCard({ state: "loading", name: lines[0].t, at: [x, y] });
  const m = await resolveOcrName(lines[0].t);
  if (seq !== card.seq) return;
  if (!m) return showCard({ state: "error", msg: `read "${lines[0].t}" but no pilot matches. Copy Local once (Ctrl+A, Ctrl+C) — the radar then matches against those exact names, including long names Local cuts off.`, at: [x, y] });
  await lookupPilot(m.name, [x, y], seq, m.how === "exact" ? null : lines[0].t);
}
// ---- OCR name correction
// EVE's small font makes OCR confuse l/I/1, O/0, rn/m etc. Instead of trusting the raw read:
//  1) match against names we already know are real (last Local paste/snapshot, pilots on recent kills),
//     using an edit distance where look-alike letters are almost free;
//  2) otherwise ask ESI which look-alike spellings exist (one batched /universe/ids call, no login).
const CONF = [["l", "I"], ["l", "1"], ["I", "1"], ["i", "l"], ["i", "j"], ["O", "0"], ["o", "0"], ["O", "Q"], ["O", "D"], ["S", "5"], ["s", "5"], ["B", "8"],
  ["Z", "2"], ["z", "2"], ["g", "q"], ["g", "9"], ["G", "6"], ["e", "c"], ["a", "o"], ["u", "v"], ["n", "h"], ["t", "f"], ["T", "7"], ["A", "4"], ["E", "F"], ["c", "o"],
  ["y", "g"], ["y", "v"], ["Y", "V"], ["r", "t"], ["k", "x"], ["C", "G"], ["P", "R"], ["H", "N"], ["M", "N"], ["U", "V"], ["w", "vv"]];
const CONF_SET = new Set(CONF.flatMap(([a, b]) => [a + b, b + a]));
const MULTI = [["rn", "m"], ["vv", "w"], ["cl", "d"], ["li", "h"], ["ri", "n"], ["nn", "m"], ["iI", "il"]];
function subCost(a, b) { if (a === b) return 0; if (a.toLowerCase() === b.toLowerCase()) return 0.1; return CONF_SET.has(a + b) ? 0.25 : 1; }
function ocrDist(a, b) {   // weighted Damerau-ish edit distance with look-alike + multi-char swaps
  const n = a.length, m = b.length, D = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  for (let i = 0; i <= n; i++) D[i][0] = i; for (let j = 0; j <= m; j++) D[0][j] = j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    let v = Math.min(D[i - 1][j] + (a[i - 1] === " " || a[i - 1] === "." ? 0.4 : 1), D[i][j - 1] + (b[j - 1] === " " ? 0.4 : 1), D[i - 1][j - 1] + subCost(a[i - 1], b[j - 1]));
    for (const [x, y] of MULTI) for (const [p, q] of [[x, y], [y, x]])
      if (i >= p.length && j >= q.length && a.slice(i - p.length, i) === p && b.slice(j - q.length, j) === q) v = Math.min(v, D[i - p.length][j - q.length] + 0.25);
    D[i][j] = v;
  }
  return D[n][m];
}
function nameScore(t, n) {
  // full match, or t is the (possibly misread) start of a longer name that Local / OCR cut off
  const T = t.replace(/\s+/g, ""), N = n.replace(/\s+/g, "");
  let d = ocrDist(t, n) / Math.max(n.length, 3);
  if (T.length >= 4 && N.length > T.length)
    for (let L = T.length - 1; L <= Math.min(N.length, T.length + 2); L++) d = Math.min(d, ocrDist(T, N.slice(0, L)) / T.length + 0.03);
  return d;
}
function knownNames() {
  // Ctrl+C on Local is exact text from EVE, so pasted names are the best reference (kept for 2 h)
  const out = new Set(local.pasted && now() - local.pastedAt < 7200 ? local.pasted : []);
  local.pilots.filter(p => p.id).forEach(p => out.add(p.name));
  for (const e of events.slice(-300)) for (const p of [e.victim, ...e.attackers]) if (p.charName) out.add(p.charName);
  return [...out];
}
function variants(t, cap = 400) {   // look-alike spellings of an OCR read, original first
  const subs = new Map(); CONF.forEach(([a, b]) => { (subs.get(a) || subs.set(a, []).get(a)).push(b); (subs.get(b) || subs.set(b, []).get(b)).push(a); });
  let out = new Set([t]);
  for (const [x, y] of MULTI) for (const v of [...out]) { if (v.includes(x)) out.add(v.split(x).join(y)); if (v.includes(y)) out.add(v.split(y).join(x)); }
  for (let i = 0; i < t.length && out.size < cap; i++) {
    const alts = subs.get(t[i]); if (!alts) continue;
    for (const v of [...out]) { for (const r of alts) { if (out.size >= cap) break; if (v[i] === t[i]) out.add(v.slice(0, i) + r + v.slice(i + 1)); } }
  }
  return [...out].filter(v => NAME_RE.test(v));
}
async function resolveOcrName(t) {
  // 1) known names
  let best = null;
  let second = 9;
  for (const n of knownNames()) { const d = nameScore(t, n); if (!best || d < best.d) { if (best) second = best.d; best = { name: n, d }; } else if (d < second) second = d; }
  if (best && best.d === 0) return { name: best.name, how: "exact" };
  if (best && best.d <= 0.22 && second - best.d > 0.04) return { name: best.name, how: "known" };   // must be clearly the best
  // 2) ESI: which look-alike spellings are real characters?
  const vs = variants(t);
  for (let k = 0; k < vs.length; k += 250) {
    const [c, b] = await get(`${ESI}/universe/ids/`, { body: vs.slice(k, k + 250) });
    const found = c === 200 && b && b.characters || [];
    if (found.length) {
      found.sort((p, q) => ocrDist(t, p.name) - ocrDist(t, q.name));
      return { name: found[0].name, how: found[0].name === t ? "exact" : "esi" };
    }
  }
  return null;
}

function pickTop(list, n = 3) {
  // zKill topLists entries: pull a readable name + count from whatever fields are present
  return (list || []).slice(0, n).map(v => {
    const nameKey = Object.keys(v).find(k => /name$/i.test(k) && typeof v[k] === "string" && !/corporation|alliance|faction|region/i.test(k)) || Object.keys(v).find(k => /name$/i.test(k));
    const idKey = Object.keys(v).find(k => /^(shipTypeID|solarSystemID|typeID|id)$/i.test(k));
    return { name: v[nameKey] || "?", kills: v.kills ?? v.count ?? null, id: idKey ? v[idKey] : null };
  });
}
async function lookupPilot(name, at, seq = ++card.seq, readAs = null) {
  showCard({ state: "loading", name, at });
  const [c1, b1] = await get(`${ESI}/universe/ids/`, { body: [name] });
  const ch = c1 === 200 && b1 && (b1.characters || [])[0];
  if (seq !== card.seq) return;
  if (!ch) return showCard({ state: "error", msg: `"${name}" isn't a pilot name (misread?)`, at });
  const [, aff] = await get(`${ESI}/characters/affiliation/`, { body: [ch.id] });
  const a = (aff || [])[0] || {};
  await resolveNames([a.corporation_id, a.alliance_id]);
  const [c3, z] = await get(`${ZKB}/api/stats/characterID/${ch.id}/`);
  if (seq !== card.seq) return;
  const zz = c3 === 200 && z && typeof z === "object" ? z : {};
  const tl = Array.isArray(zz.topLists) ? zz.topLists : [];
  const listBy = re => (tl.find(l => re.test(l.title || l.type || "")) || {}).values;
  const st = { danger: zz.dangerRatio ?? null, gang: zz.gangRatio ?? null, kills: zz.shipsDestroyed ?? null, losses: zz.shipsLost ?? null,
    solo: zz.soloKills ?? null, isk: zz.iskDestroyed ?? null, active: zz.activepvp && zz.activepvp.kills ? zz.activepvp.kills.count ?? null : null,
    ships: pickTop(listBy(/ship/i)), systems: pickTop(listBy(/system/i)) };
  zstats.set(ch.id, { danger: st.danger, gang: st.gang, kills: st.kills, losses: st.losses });
  const sn = (seen.get(ch.id) || []).slice(0, 3).map(x => ({ role: x.role, ship: x.ship, type: x.type, sysId: x.sys, sys: SYS[x.sys] ? SYS[x.sys].n : x.sys, sec: SYS[x.sys] ? dispSec(SYS[x.sys].s) : null, t: x.t, watched: isWatched(x) }));
  const base = { state: "ok", at, readAs, id: ch.id, name: ch.name, corpId: a.corporation_id || null, alliId: a.alliance_id || null, corp: names.get(a.corporation_id), alli: names.get(a.alliance_id), st, seen: sn, zk: c3 === 200,
    link: `https://zkillboard.com/character/${ch.id}/`, act: { loading: true } };
  showCard(base);
  const act = await recentActivity(ch.id);
  if (seq === card.seq) showCard(Object.assign({}, base, { act }));
}

// ---- recent PvP activity: last 7 days; if none, last 30; if none, last 90.
// zKill's character API filters "pastSeconds" up to 7 days and otherwise by calendar month, and returns IDs + hashes;
// time / system / ship come from CCP's public killmail endpoint.
const actCache = new Map();
async function zkRefs(cid, filter) {
  const out = [];
  for (const kind of ["kills", "losses"]) {
    const [c, b] = await get(`${ZKB}/api/${kind}/characterID/${cid}/${filter}`);
    if (c === 200 && Array.isArray(b)) b.forEach(r => r && r.killmail_id && r.zkb && out.push({ id: r.killmail_id, hash: r.zkb.hash, value: r.zkb.totalValue || 0 }));
    await sleep(400);                                         // be polite to zKillboard
  }
  return out;
}
async function esiKill(r) {
  const [c, b] = await get(`${ESI}/killmails/${r.id}/${r.hash}/`);
  return c === 200 && b ? b : null;
}
async function recentActivity(cid) {
  const hit = actCache.get(cid); if (hit && Date.now() - hit.at < 15 * 60e3) return hit.v;
  const nowMs = Date.now(), seenIds = new Set(), kms = [];
  const monthsBack = n => { const out = []; const d = new Date(); for (let i = 0; i < n; i++) { out.push([d.getUTCFullYear(), d.getUTCMonth() + 1]); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); } return out; };
  const steps = [[7, ["pastSeconds/604800/"]], [30, monthsBack(2).map(([y, m]) => `year/${y}/month/${m}/`)], [90, monthsBack(4).map(([y, m]) => `year/${y}/month/${m}/`)]];
  let result = { days: 90, kills: 0, losses: 0, recent: [] };
  for (const [days, filters] of steps) {
    let refs = [];
    for (const f of filters) refs = refs.concat(await zkRefs(cid, f));
    refs = refs.filter(r => !seenIds.has(r.id)).sort((x, y) => y.id - x.id).slice(0, 30);   // newest first (IDs grow over time)
    for (const r of refs) { seenIds.add(r.id); const km = await esiKill(r); if (km) kms.push({ km, value: r.value }); }
    const cut = nowMs - days * 864e5;
    const inWin = kms.filter(x => Date.parse(x.km.killmail_time) >= cut).sort((x, y) => Date.parse(y.km.killmail_time) - Date.parse(x.km.killmail_time));
    if (inWin.length) {
      const rows = [];
      for (const { km, value } of inWin) {
        const lost = km.victim && km.victim.character_id === cid;
        const me = lost ? km.victim : (km.attackers || []).find(x => x.character_id === cid) || {};
        const [, shipName] = await shipInfo(me.ship_type_id);
        const vt = km.victim ? km.victim.ship_type_id : null;
        const [, victimShip] = lost ? [null, shipName] : await shipInfo(vt);
        const s = SYS[km.solar_system_id];
        rows.push({ t: km.killmail_time, lost, ship: victimShip, type: vt || null, flying: lost ? null : shipName, sysId: km.solar_system_id, n: (km.attackers || []).length, sys: s ? s.n : String(km.solar_system_id), sec: s ? dispSec(s.s) : null, region: s ? s.r : null,
          link: `https://zkillboard.com/kill/${km.killmail_id}/`, value });
      }
      result = { days, kills: rows.filter(r => !r.lost).length, losses: rows.filter(r => r.lost).length, more: inWin.length >= 30, recent: rows.slice(0, 3) };
      break;
    }
  }
  actCache.set(cid, { at: Date.now(), v: result });
  return result;
}
function showCard(d) {
  card.data = Object.assign({ v: Date.now(), img: process.env.IMG_BASE || "https://images.evetech.net" }, d);
  const W = 340, H = 470;
  let px = d.at || [0, 0], a = settings.localArea;
  let dip = { x: px[0], y: px[1] };
  try { if (process.platform === "win32") dip = screen.screenToDipPoint({ x: px[0], y: px[1] }); } catch { }
  let areaDip = a ? { x: a[0], y: a[1], width: a[2], height: a[3] } : null;
  try { if (a && process.platform === "win32") areaDip = screen.screenToDipRect(null, areaDip); } catch { }
  const wa = screen.getDisplayNearestPoint({ x: Math.round(dip.x), y: Math.round(dip.y) }).workArea;
  let x = areaDip ? areaDip.x + areaDip.width + 8 : dip.x + 16;
  if (x + W > wa.x + wa.width) x = (areaDip ? areaDip.x : dip.x) - W - 8;
  let y = Math.min(Math.max(dip.y - 40, wa.y), wa.y + wa.height - H);
  const b = { x: Math.round(x), y: Math.round(y), width: W, height: H };
  if (!card.win || card.win.isDestroyed()) {
    card.win = new BrowserWindow(Object.assign(b, { transparent: true, frame: false, resizable: false, alwaysOnTop: true, skipTaskbar: true, hasShadow: false, focusable: true, show: false, backgroundColor: "#00000000", webPreferences: { backgroundThrottling: false } }));
    card.win.setAlwaysOnTop(true, "screen-saver");
    card.win.loadURL(`http://127.0.0.1:${PORT}/card`);
    card.win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
    card.win.once("ready-to-show", () => card.win.showInactive());
  } else { card.win.setBounds(b); card.win.showInactive(); }
  clearTimeout(card.timer);
  if (d.state === "ok" || d.state === "error") card.timer = setTimeout(hideCard, d.state === "ok" ? 25000 : 6000);
}
function hideCard() { clearTimeout(card.timer); card.seq++; if (card.win && !card.win.isDestroyed() && card.win.isVisible()) card.win.hide(); }

// ------------------------------------------------------------- windows: overlay, map, area picker, tray
let overlay = null, mapWin = null, tray = null, editMode = false;
const OV_SIZE = { strip: [560, 62], map: [480, 540] };
function overlayBounds() {
  const m = settings.overlay.mode === "map" ? "map" : "strip";
  const b = settings.overlay[m];
  if (b) return b;
  const wa = screen.getPrimaryDisplay().workArea, [w, h] = OV_SIZE[m];
  return { x: wa.x + Math.round((wa.width - w) / 2), y: wa.y + 8, width: w, height: h };
}
function createOverlay() {
  overlay = new BrowserWindow(Object.assign(overlayBounds(), {
    transparent: true, frame: false, resizable: true, alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
    focusable: false, show: false, backgroundColor: "#00000000", title: "Hunt Radar overlay",
    webPreferences: { backgroundThrottling: false, autoplayPolicy: "no-user-gesture-required" },
  }));
  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.setVisibleOnAllWorkspaces(true);
  overlay.setIgnoreMouseEvents(true);
  overlay.loadURL(`http://127.0.0.1:${PORT}/overlay`);
  overlay.once("ready-to-show", () => overlay.showInactive());
  const remember = () => { if (!overlay || overlay.isDestroyed()) return; const m = settings.overlay.mode === "map" ? "map" : "strip"; settings.overlay[m] = overlay.getBounds(); saveSettings(); };
  overlay.on("moved", remember); overlay.on("resized", remember);
}
function setEdit(on) {
  editMode = on;
  if (!overlay) return;
  overlay.setIgnoreMouseEvents(!on); overlay.setFocusable(on);
  if (on) overlay.focus(); else overlay.blur();
  overlay.setAlwaysOnTop(true, "screen-saver");
  updateTray();
}
function setMode(m) {
  settings.overlay.mode = m; saveSettings();
  if (overlay) { overlay.setBounds(overlayBounds()); }
  updateTray();
}
function openMap() {
  if (mapWin && !mapWin.isDestroyed()) { mapWin.show(); mapWin.focus(); return; }
  mapWin = new BrowserWindow({ width: 1500, height: 950, title: `Hunt Radar ${VERSION}`, backgroundColor: "#0d1014", autoHideMenuBar: true, webPreferences: { backgroundThrottling: true } });
  mapWin.loadURL(`http://127.0.0.1:${PORT}/`);
  mapWin.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
}
function openLogin() {
  const w = new BrowserWindow({ width: 520, height: 760, title: "EVE login — Hunt Radar", autoHideMenuBar: true, backgroundColor: "#0d1014" });
  w.loadURL(`http://127.0.0.1:${PORT}/login`);
}
function pickArea() {
  const ds = screen.getAllDisplays();
  const x0 = Math.min(...ds.map(d => d.bounds.x)), y0 = Math.min(...ds.map(d => d.bounds.y));
  const x1 = Math.max(...ds.map(d => d.bounds.x + d.bounds.width)), y1 = Math.max(...ds.map(d => d.bounds.y + d.bounds.height));
  const w = new BrowserWindow({ x: x0, y: y0, width: x1 - x0, height: y1 - y0, transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true, resizable: false, movable: false, hasShadow: false, backgroundColor: "#00000000" });
  w.setAlwaysOnTop(true, "screen-saver");
  w.loadURL(`http://127.0.0.1:${PORT}/pick?ox=${x0}&oy=${y0}`);
  pickWin = w;
}
let pickWin = null;
function savePickedArea(r) {
  // r is in DIP screen coordinates -> convert to physical pixels for the screenshot
  let rect = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.w), height: Math.round(r.h) };
  if (process.platform === "win32") { try { rect = screen.dipToScreenRect(null, rect); } catch { } }
  settings.localArea = [rect.x, rect.y, rect.width, rect.height]; saveSettings(); syncHook();
  Object.assign(snap, { msg: "Local area saved — middle-click a name in Local", t: now() });
  if (pickWin && !pickWin.isDestroyed()) pickWin.close();
}
function trayIcon() {
  const p = path.join(HERE, "icon.png");
  return fs.existsSync(p) ? nativeImage.createFromPath(p) : nativeImage.createEmpty();
}
function updateTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Hunt Radar ${VERSION}`, enabled: false },
    { label: "Open map & settings", click: openMap },
    { label: editMode ? `Lock overlay  (${settings.keyEdit})` : `Edit / move overlay  (${settings.keyEdit})`, click: () => setEdit(!editMode) },
    { label: settings.overlay.mode === "map" ? `Switch to strip  (${settings.keyMode})` : `Switch to mini-map  (${settings.keyMode})`, click: () => setMode(settings.overlay.mode === "map" ? "strip" : "map") },
    { label: "Mark Local area (middle-click lookup)", click: pickArea },
    ...(upd.state === "ready" ? [{ label: `Restart to update to v${upd.version}`, click: () => { app.isQuitting = true; autoUpdater.quitAndInstall(false, true); } }] : [{ label: "Check for updates", enabled: !!(app.isPackaged && autoUpdater), click: () => autoUpdater.checkForUpdates().catch(() => { }) }]),
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]));
  tray.setToolTip(`Hunt Radar ${VERSION}`);
}
const keyStatus = {};
function registerKeys() {
  globalShortcut.unregisterAll();
  const reg = (name, acc, fn) => { if (!acc) return; let ok = false; try { ok = globalShortcut.register(acc, fn); } catch { } keyStatus[name] = ok ? "ok" : `${acc} is taken or invalid`; };
  reg("edit", settings.keyEdit, () => setEdit(!editMode));
  reg("mode", settings.keyMode, () => setMode(settings.overlay.mode === "map" ? "strip" : "map"));
}

// ------------------------------------------------------------- updates (GitHub Releases), autostart, import
let autoUpdater = null; try { autoUpdater = require("electron-updater").autoUpdater; } catch { }
const upd = { state: "", version: null, at: 0 };
function setupUpdates() {
  if (!app.isPackaged || !autoUpdater) { upd.state = "updates off (dev build)"; return; }
  autoUpdater.autoDownload = true; autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("checking-for-update", () => upd.state = "checking…");
  autoUpdater.on("update-available", i => { upd.state = `downloading ${i.version}…`; upd.version = i.version; });
  autoUpdater.on("update-not-available", () => { upd.state = "up to date"; upd.at = now(); });
  autoUpdater.on("download-progress", p => upd.state = `downloading ${upd.version || ""} ${Math.round(p.percent)}%`);
  autoUpdater.on("update-downloaded", i => {
    upd.state = "ready"; upd.version = i.version; updateTray();
    try { new Notification({ title: "Hunt Radar update ready", body: `v${i.version} installs when you restart the radar (tray icon → Restart to update).` }).show(); } catch { }
  });
  autoUpdater.on("error", e => upd.state = "update error: " + String(e && e.message || e).slice(0, 120));
  const check = () => autoUpdater.checkForUpdates().catch(e => upd.state = "update error: " + String(e.message).slice(0, 120));
  setTimeout(check, 8000); setInterval(check, 6 * 3600e3);
}
function applyAutostart() {
  if (process.platform !== "win32" || !app.isPackaged) return;
  try { app.setLoginItemSettings({ openAtLogin: !!settings.autostart }); } catch { }
}
async function importOldSettings() {
  const r = await dialog.showOpenDialog({ title: "Pick your old Hunt Radar 'data' folder (from the zip versions)", properties: ["openDirectory"] });
  if (r.canceled || !r.filePaths[0]) return "cancelled";
  const d = r.filePaths[0]; let n = 0;
  const old = loadJSON(path.join(d, "settings.json"), null);
  if (old) { settings = Object.assign({}, DEFAULTS, old); settings.overlay = Object.assign({}, DEFAULTS.overlay, old.overlay || {}); settings.overlay.strip = null; settings.overlay.map = null; saveSettings(); n++; }
  const tok = loadJSON(path.join(d, "tokens.json"), null);
  if (tok) { Object.assign(esi.tokens, tok); saveTokens(); n++; }
  registerKeys(); updateTray(); if (overlay) overlay.setBounds(overlayBounds());
  return n ? `imported ${n} file(s)` : "no settings found in that folder";
}

// ------------------------------------------------------------- local web server (overlay + map pages talk to this)
const read = f => fs.readFileSync(path.join(HERE, f), "utf8");
const page = (title, body) => `<!DOCTYPE html><meta charset=utf-8><title>${title}</title><body style="background:#0d1014;color:#d8dee6;font:15px system-ui;padding:40px;max-width:640px">${body}</body>`;
// names/sec/region for every system the pages may reference (the big map page only knows its own region data)
function sysInfo() {
  const ids = new Set();
  events.forEach(e => ids.add(e.sys)); alerts.forEach(a => ids.add(a.sys)); chars.forEach(c => c.sys && ids.add(c.sys));
  if (local.sys) ids.add(local.sys); bestNearby().forEach(r => ids.add(r.sys));
  const o = {}; ids.forEach(id => { const s = SYS[id]; if (s) o[id] = [s.n, dispSec(s.s), s.r]; }); return o;
}
function statePayload(q) {
  const since = +(q.get("since") || 0), asince = +(q.get("asince") || 0);
  return {
    version: VERSION, status, heat, heatAt, events: events.filter(e => e.n > since), alerts: alerts.filter(a => a.n > asince),
    chars: charView(), local: localView(), best: bestNearby(), localCounts, settings, chatlogs: chatlog,
    jump: jumpView().map(j => Object.assign({}, j, { inRange: undefined, inRangeCount: j.inRange.length })), jumpToons: jumpToonsView(), jumpClasses: JUMP, ignoredIds: [...ignored()], watch: { g: [...watchSets().g], t: [...watchSets().t], pg: [...watchSets().pg], pt: [...watchSets().pt] },
    jumpReach: [...new Set(jumpView().flatMap(j => j.inRange))], watchCount: watchSet().size, sysInfo: sysInfo(),
    ui: { edit: editMode, mode: settings.overlay.mode, keys: keyStatus }, snap, now: now(), update: upd, dataDir: DATA_DIR,
  };
}
const SETTABLE = new Set(Object.keys(DEFAULTS));
function startServer() {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const send = (code, body, type) => { res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(body); };
    if (req.method === "GET") {
      if (u.pathname === "/") return send(200, read("map.html").replace("__VERSION__", VERSION).replace("__DATA__", () => JSON.stringify(MAP)).replace("__SHIPS__", () => JSON.stringify({ types: SHIPS.types, groups: SHIPS.groups, defaults: Object.keys(SHIPS.groupClass).map(Number) })), "text/html; charset=utf-8");
      if (u.pathname === "/overlay") return send(200, read("overlay.html").replace("__DATA__", () => JSON.stringify(U)).replace("__SHIPS__", JSON.stringify(SHIPS.groupClass)), "text/html; charset=utf-8");
      if (u.pathname === "/pick") return send(200, read("pick.html"), "text/html; charset=utf-8");
      if (u.pathname === "/card") return send(200, read("card.html"), "text/html; charset=utf-8");
      if (u.pathname === "/login") {
        if (!settings.esiClientId.trim()) return send(200, page("ESI not set up", "<p>Put your EVE developer app <b>Client ID</b> in Map &amp; settings → Jump drive toons first.</p>"), "text/html; charset=utf-8");
        res.writeHead(302, { Location: esiLoginUrl() }); return res.end();
      }
      if (u.pathname === "/callback") {
        const st = u.searchParams.get("state"), code = u.searchParams.get("code"), ver = esi.pending[st]; delete esi.pending[st];
        if (!ver || !code) return send(200, page("Login failed", "<p>Unknown or expired login — try again.</p>"), "text/html; charset=utf-8");
        tokenRequest({ grant_type: "authorization_code", code, client_id: settings.esiClientId.trim(), code_verifier: ver })
          .then(j => { const t = storeToken(j); const id = Object.keys(esi.tokens).find(k => esi.tokens[k] === t); if (id) readShip(id); send(200, page("Logged in", `<h2>✔ ${t.name} added</h2><p>The radar now reads this character's ship. You can close this window.</p>`), "text/html; charset=utf-8"); })
          .catch(e => send(200, page("Login failed", `<pre>${String(e.message)}</pre>`), "text/html; charset=utf-8"));
        return;
      }
      if (u.pathname === "/cardstate") return send(200, JSON.stringify(card.data || {}), "application/json");
      if (u.pathname === "/state") return send(200, JSON.stringify(statePayload(u.searchParams)), "application/json");
      return send(404, "not found", "text/plain");
    }
    let body = ""; req.on("data", d => body += d); req.on("end", () => {
      let j = {}; try { j = body ? JSON.parse(body) : {}; } catch { return send(400, "bad json", "text/plain"); }
      if (u.pathname === "/settings") {
        for (const k in j) if (SETTABLE.has(k)) settings[k] = k === "overlay" ? Object.assign({}, settings.overlay, j[k]) : j[k];
        saveSettings();
        if (["keyEdit", "keyMode"].some(k => k in j)) registerKeys();
        if (["lookupOn", "localArea"].some(k => k in j)) syncHook();
        if ("autostart" in j) applyAutostart();
        if ("overlay" in j && overlay) { overlay.setBounds(overlayBounds()); }
        updateTray();
        return send(200, JSON.stringify(settings), "application/json");
      }
      if (u.pathname === "/cmd") {
        const c = j.cmd;
        if (c === "map") openMap(); else if (c === "lock") setEdit(false); else if (c === "edit") setEdit(true);
        else if (c === "mode") setMode(j.mode || (settings.overlay.mode === "map" ? "strip" : "map"));
        else if (c === "pick") pickArea(); else if (c === "picked") savePickedArea(j.rect);
        else if (c === "pickcancel") { if (pickWin && !pickWin.isDestroyed()) pickWin.close(); }
        else if (c === "quit") app.quit();
        else if (c === "cardclose") hideCard();
        else if (c === "cardhold") { clearTimeout(card.timer); if (!j.on && card.data && card.data.state === "ok") card.timer = setTimeout(hideCard, 8000); }
        else if (c === "esilogin") openLogin();
        else if (c === "update-check") { if (autoUpdater && app.isPackaged) autoUpdater.checkForUpdates().catch(() => { }); }
        else if (c === "update-install") { if (upd.state === "ready") { app.isQuitting = true; autoUpdater.quitAndInstall(false, true); } }
        else if (c === "import") { importOldSettings().then(m => { snap.msg = m; snap.t = now(); }); }
        else if (c === "datadir") shell.openPath(DATA_DIR);
        else if (c === "esilogout") { const id = Object.keys(esi.tokens).find(k => esi.tokens[k].name === j.name); if (id) { delete esi.tokens[id]; delete esi.ships[j.name]; saveTokens(); } }
        else if (c === "resize" && overlay && settings.overlay.mode !== "map") {   // strip grows/shrinks to fit its rows
          const b = overlay.getBounds(), h = Math.max(40, Math.min(220, Math.round(+j.h || b.height)));
          if (Math.abs(h - b.height) > 2) { overlay.setBounds({ x: b.x, y: b.y, width: b.width, height: h }); }
        }
        else if (c === "lookup") lookupPilot(String(j.name || ""), j.at || [screen.getPrimaryDisplay().workArea.width / 2, 300]);
        return send(200, "{}", "application/json");
      }
      send(404, "not found", "text/plain");
    });
  });
  return new Promise((resolve, reject) => { srv.once("error", reject); srv.listen(PORT, "127.0.0.1", resolve); });
}

// ------------------------------------------------------------- start
// never let a stray error pop a blocking dialog over the game — log it and keep running
process.on("uncaughtException", e => log("error:", e && e.stack || e));
process.on("unhandledRejection", e => log("error:", e && e.stack || e));
if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.on("second-instance", () => openMap());
  app.whenReady().then(async () => {
    try { await startServer(); }
    catch (e) { const { dialog } = require("electron"); dialog.showErrorBox("Hunt Radar", `Port ${PORT} is already in use — is an old Hunt Radar (or the Python version) still running? Close it and start again.`); app.quit(); return; }
    log(`Hunt Radar ${VERSION} — data folder: ${DATA_DIR}`);
    if (process.platform === "win32") app.setAppUserModelId("no.raphyon.huntradar");
    setupUpdates(); applyAutostart();
    startHelper();
    feedLoop(+(process.env.HR_BACKFILL || 600)); heatLoop(); statsLoop(); esiShipLoop();
    setInterval(() => { try { scanChatlogs(); } catch (e) { chatlog.err = String(e.message); } }, 500);
    setInterval(pollWindows, 250);
    setInterval(pollClipboard, 600);
    createOverlay();
    tray = new Tray(trayIcon()); tray.on("click", openMap); updateTray();
    registerKeys();
    if (!fs.existsSync(path.join(DATA_DIR, ".seen"))) { fs.writeFileSync(path.join(DATA_DIR, ".seen"), "1"); openMap(); }   // first run: show settings once
    if (process.env.HR_OPEN) { const o = process.env.HR_OPEN.split(","); if (o.includes("edit")) setEdit(true); if (o.includes("map")) openMap(); }
  });
  app.on("window-all-closed", e => { /* keep running in tray */ });
  app.on("will-quit", () => { globalShortcut.unregisterAll(); try { helper.proc && helper.proc.kill(); } catch { } });
}
