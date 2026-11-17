// ================= RADAR (talks to hunt_radar.py) =================
const CLS = { BS: "Battleships", MAR: "Marauders", BLOPS: "Black Ops", T3C: "T3 cruisers", CAP: "Capitals (incl. Rorqual)", BC: "Battlecruisers", CMD: "Command ships (T2 BC)", ICS: "Industrial command (Orca/Porpoise)", EXH: "Exhumers" };
const GC = __SHIPS__;
const RA = { evs: [], last: 0, alast: -1, heat: {}, armed: false, ctx: null, chars: [], local: null, best: [], lc: {}, settingsLoaded: false };
let clsOn = {}; Object.keys(CLS).forEach(k => clsOn[k] = true);
$("classes").innerHTML = Object.entries(CLS).map(([k, v]) => `<label class="chk"><input type="checkbox" data-k="${k}" checked> ${v}</label>`).join("");
$("classes").querySelectorAll("input").forEach(i => i.onchange = () => { clsOn[i.dataset.k] = i.checked; pushSettings(); renderFeed(); drawPulses(); });
function pushSettings() {
  fetch("/settings", { method: "POST", body: JSON.stringify({ camp: $("tCamp").value, hunt: $("tHunt").value, ignore: $("tIgn").value, classes: clsOn, victim: $("pVictim").checked, range: +$("pRange").value, near: $("pNear").checked, nearRange: +$("pNearR").value,
    watchJumpsOn: $("wJOn").checked, watchJumps: +$("wJ").value || 20, watchLyOn: $("wLOn").checked, watchLy: +$("wL").value || 16,
    space: { low: $("spL").checked, null: $("spN").checked, poch: $("spP").checked }, beepGap: +$("bGap").value }) }).catch(() => {});
}
function applySettings(st) {
  $("tCamp").value = st.camp; $("tHunt").value = st.hunt; $("tIgn").value = st.ignore || ""; $("pVictim").checked = !!st.victim; $("pRange").value = String(st.range); $("pNear").checked = st.near !== false; $("pNearR").value = String(st.nearRange || 5);
  $("wJOn").checked = st.watchJumpsOn !== false; $("wJ").value = st.watchJumps || 20; $("wLOn").checked = st.watchLyOn !== false; $("wL").value = st.watchLy || 16;
  const sp = st.space || {}; $("spL").checked = sp.low !== false; $("spN").checked = sp.null !== false; $("spP").checked = sp.poch !== false; $("bGap").value = String(st.beepGap ?? 10);
  Object.keys(CLS).forEach(k => { clsOn[k] = st.classes[k] !== false; const i = $("classes").querySelector(`[data-k=${k}]`); if (i) i.checked = clsOn[k]; });
  renderAll();
}
// target edits go to the radar process too
const _apply = $("apply").onclick; $("apply").onclick = () => { _apply(); pushSettings(); };
const _defs = $("defaults").onclick; $("defaults").onclick = () => { _defs(); pushSettings(); };
$("pVictim").onchange = () => { pushSettings(); renderFeed(); drawPulses(); };
$("pRange").onchange = pushSettings;
["wJOn", "wJ", "wLOn", "wL", "spL", "spN", "spP", "bGap"].forEach(id => $(id).addEventListener("change", pushSettings)); $("pNear").onchange = pushSettings; $("pNearR").onchange = pushSettings;

const watched = p => { const c = GC[p.group]; return c && clsOn[c]; };
window.IGNORED = new Set();
window.toggleIgnore = id => {
  const n = S[id].n, list = $("tIgn").value.split(/[,\n;]+/).map(t => t.trim()).filter(Boolean);
  const i = list.findIndex(t => t.toLowerCase() === n.toLowerCase());
  if (i >= 0) list.splice(i, 1); else list.push(n);
  $("tIgn").value = list.join(", "); pushSettings();
};
function interest(ev) {
  const a = ev.attackers.filter(watched), v = watched(ev.victim) ? [ev.victim] : [];
  return { a, v, hit: (ev.sec ?? 0) < 0.5 && !window.IGNORED.has(ev.sys) && (a.length > 0 || ($("pVictim").checked && v.length > 0)) };
}
function nearestTarget(sid) {
  if (!S[sid]) { const c = RA.chars.find(c => c.active); return [null, c ? c.name : "-"]; }   // outside the big map's regions
  const T = new Set([...camp, ...hunt]); RA.chars.forEach(c => { if (S[c.sys] && c.running) T.add(c.sys); });
  if (T.has(sid)) return [0, S[sid].n];
  const seen = { [sid]: 0 }, q = [sid];
  while (q.length) { const u = q.shift(); for (const v of ADJ[u]) if (seen[v] === undefined) { seen[v] = seen[u] + 1; if (T.has(v)) return [seen[v], S[v].n]; q.push(v); } }
  return [99, "-"];
}
const ageMin = ev => (Date.now() - Date.parse(ev.time)) / 60000;
const isk = v => v >= 1e9 ? (v / 1e9).toFixed(1) + "b" : v >= 1e6 ? Math.round(v / 1e6) + "m" : Math.round(v / 1e3) + "k";
const esc = t => String(t ?? "?").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const who = p => `<b>${esc(p.shipName)}</b> ${esc(p.charName)}${p.alliName ? ` <span class="sub">[${esc(p.alliName)}]</span>` : p.corpName ? ` <span class="sub">[${esc(p.corpName)}]</span>` : ""}`;
const agoS = t => { const s = Math.round(Date.now() / 1000 - t); return s < 90 ? s + "s" : s < 5400 ? Math.round(s / 60) + "m" : Math.round(s / 3600) + "h"; };
const jumpTo = root => root.querySelectorAll("[data-id]").forEach(a => a.onclick = ev => { ev.preventDefault(); if (S[+a.dataset.id]) select(+a.dataset.id, true); });

function renderFeed() {
  const only = $("fOnly").checked;
  const list = RA.evs.slice().reverse().filter(e => !only || interest(e).hit).slice(0, 80);
  $("fCount").textContent = `(${RA.evs.length})`;
  $("feed").innerHTML = list.map(e => {
    const I = interest(e), [d, tn] = nearestTarget(e.sys), t = new Date(Date.parse(e.time));
    const hdr = `<div class="fh"><span>${t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span> <a href="#" data-id="${e.sys}" class="fs">${esc(e.sysName || (S[e.sys] || {}).n)}</a> <span class="sub">${(e.sec ?? 0).toFixed(1)}${e.region ? " · " + esc(e.region) : ""}${d === null ? "" : " · " + (d === 0 ? "target" : d + "j from " + esc(tn))}</span><span class="fv">${isk(e.val)}</span></div>`;
    const atk = I.a.length ? I.a.map(who).join("<br>") + (e.attackers.length > I.a.length ? `<br><span class="sub">+${e.attackers.length - I.a.length} other attacker(s)</span>` : "") : `<span class="sub">${e.attackers.length} attacker(s): ${e.attackers.slice(0, 3).map(p => esc(p.shipName)).join(", ")}${e.attackers.length > 3 ? "…" : ""}</span>`;
    return `<div class="fi ${I.hit ? "hit" : ""}">${hdr}<div><span class="sub">killed</span> ${who(e.victim)}</div><div><span class="sub">by</span> ${atk}</div><a class="zk" href="${e.link}" target="_blank" rel="noopener">zKill ↗</a></div>`;
  }).join("") || `<div class="sub">No PvP kills in lowsec yet.</div>`;
  jumpTo($("feed"));
}
function renderChars() {
  const cs = RA.chars.filter(c => c.running);
  $("chars").innerHTML = cs.length ? cs.map(c => `<div class="crow"><span style="color:#3ddc84">${c.active ? "▶" : "&nbsp;&nbsp;"}</span> <b>${esc(c.name)}</b> ${c.sysName ? (S[c.sys] ? `<a href="#" data-id="${c.sys}" class="fs">${esc(c.sysName)}</a>` : esc(c.sysName)) + ` <span class="sub">${c.sec != null ? c.sec.toFixed(1) : ""}</span>` : `<span class="sub">system unknown until you jump</span>`}</div>`).join("")
    : `<div class="sub">${esc((RA.cl && RA.cl.err) || "No EVE client found yet — log in and jump once.")}</div>`;
  $("clDir").placeholder = (RA.cl && RA.cl.dir) || "Documents\\EVE\\logs\\Chatlogs";
  jumpTo($("chars"));
}
function renderLocal() {
  const L = RA.local;
  if (!L || !L.t) { $("local").innerHTML = `<div class="sub">In EVE: click in Local, Ctrl+A, Ctrl+C. The radar picks it up from the clipboard.</div>`; return; }
  const ps = L.pilots.filter(p => !p.me);
  $("local").innerHTML = `<div><b>${L.count} pilots</b>${L.sysName ? ` in <a href="#" data-id="${L.sys}" class="fs">${esc(L.sysName)}</a>` : ""} <span class="sub">· ${agoS(L.t)} ago${L.resolving ? " · looking up…" : ""}</span></div>`
    + (L.groups.length ? `<div class="sub">${L.groups.map(([g, n]) => `${esc(g)} ×${n}`).join(" · ")}</div>` : "")
    + `<table>${ps.slice(0, 60).map(p => { const s = p.st || {}; const dg = s.danger;
        return `<tr><td>${p.hot ? '<span style="color:#ff3bd4">⚠</span> ' : ""}<b style="${p.hot ? "color:#ff3bd4" : ""}">${esc(p.name)}</b> <span class="sub">${esc(p.alli || p.corp || "")}</span>${(p.seen || []).slice(0, 1).map(x => `<br><span style="color:#ffb020">${x.role} in ${esc(x.ship)} @ ${esc(S[x.sys] ? S[x.sys].n : (RA.si && RA.si[x.sys] ? RA.si[x.sys][0] : x.sys))}</span>`).join("")}</td><td class="n">${dg != null ? `<span style="color:${dg >= 70 ? "#ff3b30" : dg >= 40 ? "#ff9a2b" : "#7f8a96"}">${dg}%</span>` : ""}${s.kills != null ? `<br><span class="sub">${s.kills}k/${s.losses}l</span>` : ""}</td></tr>`; }).join("")}</table>`;
  jumpTo($("local"));
}
function renderBest() {
  $("best").innerHTML = RA.best.map((r, i) => `<tr class="cl" data-id="${r.sys}"><td><span class="rk" style="background:${i < 3 ? "#ff3b30" : "#ff9a2b"}">${i + 1}</span> <b>${esc(r.n)}</b> <span class="sub">${r.sec.toFixed(1)} · ${r.j}j</span></td><td class="n">${[r.npc ? "NPC " + r.npc : "", r.kills ? "kills " + r.kills : "", r.watched ? r.watched + " watched" : ""].filter(Boolean).join(" · ")}${(r.jumpers || []).length ? ' <b style="color:#3ddc84" title="in jump range">⤳✓</b>' : ""}</td></tr>`).join("") || `<tr><td class="sub">No activity data yet.</td></tr>`;
  $("best").querySelectorAll("tr.cl").forEach(tr => tr.onclick = () => select(+tr.dataset.id, true));
}
function drawPulses() {
  const g = $("gPulse"); g.innerHTML = "";
  const by = {};
  RA.evs.forEach(e => { const m = ageMin(e); if (m > 30) return; const hit = interest(e).hit; const o = by[e.sys]; if (!o || hit > o.hit || (hit === o.hit && m < o.m)) by[e.sys] = { hit, m }; });
  for (const sid in by) {
    const s = S[sid], o = by[sid], op = Math.max(.15, 1 - o.m / 30); if (!s) continue;
    el("circle", { cx: s.px, cy: s.py, r: o.hit ? 46 : 38, fill: o.hit ? "#ff3bd4" : "none", "fill-opacity": o.hit ? op * .18 : 0, stroke: o.hit ? "#ff3bd4" : "#c9d1d9", "stroke-width": o.hit ? 4 : 2, "stroke-opacity": op * (o.hit ? 1 : .6) }, g);
  }
  // jump range: dashed violet ring on lowsec systems in range of a jump toon
  new Set(RA.jumpReach || []).forEach(sid => { const s = S[sid]; if (s) el("circle", { cx: s.px, cy: s.py, r: 30, fill: "none", stroke: "#a78bfa", "stroke-width": 2, "stroke-dasharray": "5 4" }, g); });
  // your characters
  const byS = {}; RA.chars.forEach(c => { if (S[c.sys] && c.running) (byS[c.sys] = byS[c.sys] || []).push(c); });
  for (const sid in byS) {
    const s = S[sid];
    el("circle", { cx: s.px, cy: s.py, r: 34, fill: "none", stroke: "#3ddc84", "stroke-width": 3 }, g);
    const t = el("text", { x: s.px, y: s.py - 38, "text-anchor": "middle", "font-size": 11, "font-weight": 800, fill: "#3ddc84" }, g);
    t.textContent = byS[sid].map(c => c.name).join(", ");
  }
}
// ---- heat: ranked, lowsec only. Top 3 = red, 4-10 = orange, rest = grey ----
function heatVal(r, m) { return !r ? 0 : m === "j" ? r[0] : m === "k" ? r[1] + r[2] : r[3]; }
function heatRank() {
  const m = $("heatMode").value; if (m === "off") return { m, rank: {}, list: [] };
  const list = DATA.sys.filter(s => dispSec(s.s) < 0.5 && !window.IGNORED.has(s.id)).map(s => [s, heatVal(RA.heat[s.id], m)]).filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]);
  const rank = {}; list.forEach((x, i) => rank[x[0].id] = i + 1);
  return { m, rank, list };
}
const tierCol = r => r && r <= 3 ? "#ff3b30" : r && r <= 10 ? "#ff9a2b" : "#3a424b";
window.radarNode = (s, grp, w, h) => {
  const lc = RA.lc[s.id];
  if (lc && Date.now() / 1000 - lc[1] < 1800) {
    const tw = String(lc[0]).length * 7 + 22;
    el("rect", { x: -w / 2 - 6, y: h / 2 - 8, width: tw, height: 15, rx: 7, fill: "#14361f", stroke: "#3ddc84" }, grp);
    const t = el("text", { x: -w / 2 - 6 + tw / 2, y: h / 2 + 3, "text-anchor": "middle", "font-size": 10, "font-weight": 800, fill: "#3ddc84" }, grp); t.textContent = "👥" + lc[0];
  }
  const H = RA.hr; if (!H || H.m === "off") return;
  const rk = H.rank[s.id]; if (!rk) return;
  const v = heatVal(RA.heat[s.id], H.m), top = rk <= 10, fs = top ? 12 : 9.5, tw = String(v).length * fs * .62 + 12, th = top ? 18 : 14;
  el("rect", { x: w / 2 - tw + 8, y: -h / 2 - th + 4, width: tw, height: th, rx: th / 2, fill: tierCol(rk), stroke: "#0d1014", "stroke-width": 1.5 }, grp);
  const t = el("text", { x: w / 2 - tw / 2 + 8, y: -h / 2 + 4 - th / 2 + fs * .36, "text-anchor": "middle", "font-size": fs, "font-weight": 800, fill: top ? "#fff" : "#c9d1d9" }, grp); t.textContent = v;
};
function drawHeat() {
  RA.hr = heatRank();
  const g = $("gHeat"); g.innerHTML = "";
  const H = RA.hr, lbl = { j: "jumps", k: "ship+pod kills", n: "NPC kills" }[H.m];
  $("busy").innerHTML = H.m === "off" ? "" : H.list.slice(0, 10).map(([s, v], i) => `<tr class="cl" data-id="${s.id}"><td><span class="rk" style="background:${tierCol(i + 1)}">${i + 1}</span> <b>${esc(s.n)}</b> <span class="sub">${dispSec(s.s).toFixed(1)}</span></td><td class="n">${v} ${lbl}</td></tr>`).join("") || `<tr><td class="sub">No ${lbl} in lowsec this hour.</td></tr>`;
  $("busy").querySelectorAll("tr.cl").forEach(tr => tr.onclick = () => select(+tr.dataset.id, true));
  if (H.m === "off") return;
  const defs = el("defs", {}, g);
  [["hgR", "#ff3b30"], ["hgO", "#ff9a2b"]].forEach(([id, c]) => { const gr = el("radialGradient", { id }, defs);
    el("stop", { offset: "0%", "stop-color": c, "stop-opacity": .8 }, gr); el("stop", { offset: "50%", "stop-color": c, "stop-opacity": .35 }, gr); el("stop", { offset: "100%", "stop-color": c, "stop-opacity": 0 }, gr); });
  H.list.slice(0, 10).forEach(([s], i) => el("circle", { cx: s.px, cy: s.py, r: i < 3 ? 85 : 60, fill: i < 3 ? "url(#hgR)" : "url(#hgO)" }, g));
}
$("heatMode").onchange = () => { drawHeat(); drawNodes(); }; $("fOnly").onchange = renderFeed;

// ---- overlay & hotkey controls
const post = (u, b) => fetch(u, { method: "POST", body: JSON.stringify(b) });
$("ovEdit").onclick = () => post("/cmd", { cmd: RA.ui && RA.ui.edit ? "lock" : "edit" });
$("ovMode").onclick = () => post("/cmd", { cmd: "mode" });
$("ovTest").onclick = () => { const AC = new AudioContext(); const t0 = AC.currentTime; let t = t0;
  [[440, 220], [0, 50], [440, 220], [0, 50], [660, 380], [0, 400], [1000, 120], [1400, 120], [1000, 140]].forEach(([f, ms]) => { if (f) { const o = AC.createOscillator(), g = AC.createGain(); o.type = "triangle"; o.frequency.value = f; g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(.35, t + .015); g.gain.exponentialRampToValueAtTime(.001, t + ms / 1000); o.connect(g).connect(AC.destination); o.start(t); o.stop(t + ms / 1000 + .02); } t += ms / 1000 + .03; }); };
$("ovOp").oninput = () => { $("opV").textContent = Math.round($("ovOp").value * 100) + "%"; post("/settings", { overlay: { opacity: +$("ovOp").value } }); };
$("ovJ").onchange = () => post("/settings", { overlay: { mapJumps: +$("ovJ").value } });
$("sndOn").onchange = () => post("/settings", { sound: $("sndOn").checked });
$("snOn").onchange = () => post("/settings", { snapOn: $("snOn").checked });
$("luOn").onchange = () => post("/settings", { lookupOn: $("luOn").checked });
$("snMode").onchange = () => { post("/settings", { snapMode: $("snMode").value }); snHelp(); };
$("snPick").onclick = () => post("/cmd", { cmd: "pick" });
$("snTest").onclick = () => post("/cmd", { cmd: "snap" });
function snHelp() { $("snHelp").textContent = $("snMode").value === "Screenshot"
  ? "Screenshots the box you mark over Local's member list and reads it with Windows OCR. Nothing is sent to EVE. Only visible rows; small fonts can misread."
  : "Sends Ctrl+A, Ctrl+C to the EVE window in front (click into Local first). Gets everyone, but sends keystrokes into the client — grey area under CCP's rules, your own risk."; }
// hotkey capture boxes -> Electron accelerator strings
const KEYMAP = { " ": "Space", "ArrowUp": "Up", "ArrowDown": "Down", "ArrowLeft": "Left", "ArrowRight": "Right", "ScrollLock": "Scrolllock", "Pause": "Pause", "Insert": "Insert", "Delete": "Delete", "Home": "Home", "End": "End", "PageUp": "PageUp", "PageDown": "PageDown", "Escape": "Escape" };
function accel(e) {
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return null;
  const mods = []; if (e.ctrlKey) mods.push("Ctrl"); if (e.altKey) mods.push("Alt"); if (e.shiftKey) mods.push("Shift");
  let k = KEYMAP[e.key] || (e.code.startsWith("Numpad") ? "num" + e.code.slice(6).toLowerCase().replace("decimal", "dec").replace("add", "add").replace("subtract", "sub").replace("multiply", "mult").replace("divide", "div").replace("enter", "enter") : null)
    || (/^F\d+$/.test(e.key) ? e.key : null) || (e.key.length === 1 ? e.key.toUpperCase() : null);
  return k ? [...mods, k].join("+") : null;
}
[["kEdit", "keyEdit"], ["kMode", "keyMode"], ["kSnap", "keySnap"]].forEach(([id, key]) => {
  const inp = $(id); inp.readOnly = true;
  inp.addEventListener("keydown", e => { e.preventDefault(); const a = accel(e); if (!a) return; inp.value = a; post("/settings", { [key]: a }); });
});
// ---- jump drive toons
let jtSig = "";
function renderJump(d) {
  const rows = d.jumpToons || [];
  const sig = JSON.stringify(rows.map(r => [r.name, r.err, r.ship && r.ship.shipName, r.jdc, r.skillErr]));
  if (sig !== jtSig) {
    jtSig = sig;
    $("jt").innerHTML = rows.length ? rows.map(r => `<tr><td><b>${esc(r.name)}</b></td><td class="sub">${r.ship ? esc(r.ship.shipName) + (r.ship.key ? ' <b style="color:#c4b5fd">· jump drive</b>' : "") : esc(r.err || "reading ship…")} · ${r.jdc != null ? "JDC " + r.jdc : esc(r.skillErr || "JDC …")}</td><td><a href="#" data-out="${esc(r.name)}" class="rm" title="Log out">✕</a></td></tr>`).join("")
      : `<tr><td class="sub">No toons logged in.</td></tr>`;
    $("jt").querySelectorAll("[data-out]").forEach(a => a.onclick = ev => { ev.preventDefault(); post("/cmd", { cmd: "esilogout", name: a.dataset.out }); });
  }
  $("jumpSt").innerHTML = (d.jump || []).map(j => `<div><b style="color:#c4b5fd">⤳ ${esc(j.name)}</b> ${esc(j.clsName)} ${j.range} LY ${j.jdcKnown ? "(JDC " + j.jdc + ")" : "(JDC V assumed)"} @ ${esc(j.sysName || "?")}: ${j.known ? j.inRangeCount + " systems in range" : "locating…"}</div>`).join("");
}
$("esiSave").onclick = () => post("/settings", { esiClientId: $("esiCid").value.trim() });
$("esiLogin").onclick = () => post("/cmd", { cmd: "esilogin" });
$("updCheck").onclick = () => post("/cmd", { cmd: "update-check" });
$("updGo").onclick = () => post("/cmd", { cmd: "update-install" });
$("autoSt").onchange = () => post("/settings", { autostart: $("autoSt").checked });
$("impOld").onclick = () => post("/cmd", { cmd: "import" });
$("openData").onclick = () => post("/cmd", { cmd: "datadir" });
function renderApp(d) {
  const u = d.update || {};
  $("updSt").innerHTML = `Version <b>${esc(d.version)}</b> · ${u.state === "ready" ? `<b style="color:#3ddc84">v${esc(u.version)} downloaded — restart to install</b>` : esc(u.state || "")}`;
  $("updGo").style.display = u.state === "ready" ? "" : "none";
}
let uiLoaded = false;
function applyUi(d) {
  RA.ui = d.ui; const st = d.settings;
  $("ovEdit").textContent = d.ui.edit ? "Lock overlay 🔒" : "Edit / move overlay";
  const ks = d.ui.keys || {}; $("kEditS").textContent = ks.edit === "ok" ? "✓" : ks.edit || ""; $("kModeS").textContent = ks.mode === "ok" ? "✓" : ks.mode || ""; $("kSnapS").textContent = ks.snap === "ok" ? "✓" : ks.snap || "";
  const sn = d.snap; $("snMsg").textContent = sn.msg ? sn.msg + " · " + agoS(sn.t) + " ago" : (st.localArea ? "Local area set." : "No Local area marked yet.");
  if (uiLoaded) return; uiLoaded = true;
  $("ovOp").value = st.overlay.opacity; $("opV").textContent = Math.round(st.overlay.opacity * 100) + "%"; $("ovJ").value = String(st.overlay.mapJumps || 4);
  $("sndOn").checked = st.sound !== false; $("luOn").checked = st.lookupOn !== false; $("snOn").checked = !!st.snapOn; $("snMode").value = st.snapMode || "Screenshot";
  $("esiCid").value = st.esiClientId || ""; $("autoSt").checked = !!st.autostart;
  $("kEdit").value = st.keyEdit || ""; $("kMode").value = st.keyMode || ""; $("kSnap").value = st.keySnap || ""; snHelp();
}

async function poll() {
  try {
    const r = await fetch(`/state?since=${RA.last}&asince=${Math.max(RA.alast, 0)}`); const d = await r.json();
    RA.heat = d.heat || {}; RA.chars = d.chars || []; RA.local = d.local; RA.best = d.best || []; RA.lc = d.localCounts || {}; RA.cl = d.chatlogs;
    if (!RA.settingsLoaded) { RA.settingsLoaded = true; applySettings(d.settings); }
    const st = d.status, age = st.last_ok ? Math.round(d.now - st.last_ok) : null;
    $("rStatus").innerHTML = `Feed: <b>${esc(st.feed)}</b>${age !== null ? ` (${age}s ago)` : ""} · ${st.kept} lowsec kills · heat: ${esc(st.heat)}${d.heatAt ? " (" + Math.round((d.now - d.heatAt) / 60) + " min old)" : ""}${st.err ? `<br><span style="color:#ff6b6b">${esc(st.err)}</span>` : ""}`;
    for (const e of d.events) { RA.evs.push(e); RA.last = Math.max(RA.last, e.n); }
    if (RA.evs.length > 600) RA.evs.splice(0, RA.evs.length - 600);
    $("wCnt").textContent = `${d.watchCount} systems currently watched` + (d.watchCount ? "" : " — log in and jump once so the radar knows where you are");
    applyUi(d); renderApp(d); renderJump(d); RA.jump = d.jump || []; RA.jumpReach = d.jumpReach || []; RA.si = d.sysInfo || {}; window.IGNORED = new Set(d.ignoredIds || []);
    renderFeed(); renderChars(); renderLocal(); renderBest(); drawPulses(); drawHeat(); drawNodes();
  } catch (e) { $("rStatus").innerHTML = `<span style="color:#ff6b6b">Lost contact with the radar — is its window still open?</span>`; }
}
window.addEventListener("focus", () => document.title = "Hunt radar");
poll(); setInterval(poll, 3000); setInterval(drawPulses, 30000);
