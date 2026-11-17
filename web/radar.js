// ================= RADAR (talks to hunt_radar.py) =================
const SHIPDB = __SHIPS__;                       // { types: {typeID: [groupID, name]}, groups: {groupID: name} }
const RA = { evs: [], last: 0, alast: -1, heat: {}, armed: false, ctx: null, chars: [], local: null, best: [], lc: {}, settingsLoaded: false, ws: { g: new Set(), t: new Set() } };
let WL = [];                                   // ship watchlists (edited in the popup, saved to the radar)
function pushSettings() {
  fetch("/settings", { method: "POST", body: JSON.stringify({ watched: $("tCamp").value, ignore: $("tIgn").value, victim: $("pVictim").checked, range: +$("pRange").value, near: $("pNear").checked, nearRange: +$("pNearR").value,
    watchJumpsOn: $("wJOn").checked, watchJumps: +$("wJ").value || 20, watchLyOn: $("wLOn").checked, watchLy: +$("wL").value || 16,
    space: { low: $("spL").checked, null: $("spN").checked, poch: $("spP").checked }, beepGap: +$("bGap").value }) }).catch(() => {});
}
function applySettings(st) {
  $("tCamp").value = st.watched || ""; $("tIgn").value = st.ignore || ""; $("pVictim").checked = !!st.victim; $("pRange").value = String(st.range); $("pNear").checked = st.near !== false; $("pNearR").value = String(st.nearRange || 5);
  $("wJOn").checked = st.watchJumpsOn !== false; $("wJ").value = st.watchJumps || 20; $("wLOn").checked = st.watchLyOn !== false; $("wL").value = st.watchLy || 16;
  const sp = st.space || {}; $("spL").checked = sp.low !== false; $("spN").checked = sp.null !== false; $("spP").checked = sp.poch !== false; $("bGap").value = String(st.beepGap ?? 10);
  WL = JSON.parse(JSON.stringify(st.watchlists || [])); wlSummary();
  renderAll();
}
// target edits go to the radar process too
const _apply = $("apply").onclick; $("apply").onclick = () => { _apply(); pushSettings(); };
const _defs = $("defaults").onclick; $("defaults").onclick = () => { _defs(); pushSettings(); };
$("pVictim").onchange = () => { pushSettings(); renderFeed(); drawPulses(); };
$("pRange").onchange = pushSettings;
$("tIgn").addEventListener("input", () => computeTargets());
["wJOn", "wJ", "wLOn", "wL", "spL", "spN", "spP", "bGap"].forEach(id => $(id).addEventListener("change", pushSettings)); $("pNear").onchange = pushSettings; $("pNearR").onchange = pushSettings;

const watched = p => RA.ws.t.has(p.ship) || RA.ws.g.has(p.group);

// ---------------- ship watchlist editor (popup) ----------------
const TYPES = Object.entries(SHIPDB.types).map(([id, [g, n]]) => ({ id: +id, g: +g, n })).sort((a, b) => a.n.localeCompare(b.n));
const GROUPS = Object.entries(SHIPDB.groups).map(([id, n]) => ({ id: +id, n, types: TYPES.filter(t => t.g === +id) })).sort((a, b) => a.n.localeCompare(b.n));
let wlSel = 0, wlOpenG = new Set(), wlQ = "";
function wlSummary() {
  const on = WL.filter(l => l.on !== false);
  const n = l => ["groups", "types", "pgroups", "ptypes"].map(k => (l[k] || []).length);
  $("wlSum").textContent = on.length ? on.map(l => { const [g, t, pg, pt] = n(l); return `${l.name}: ✗ ${pg + pt} pinged, ✓ ${g + t} watched`; }).join(" · ") : "No watchlist enabled — nothing is watched.";
}
function wlSave() {
  fetch("/settings", { method: "POST", body: JSON.stringify({ watchlists: WL }) }).catch(() => {});
  const g = new Set(), t = new Set(); WL.filter(l => l.on !== false).forEach(l => { ["groups", "pgroups"].forEach(k => (l[k] || []).forEach(x => g.add(+x))); ["types", "ptypes"].forEach(k => (l[k] || []).forEach(x => t.add(+x))); });
  RA.ws = { g, t }; wlSummary(); renderFeed(); drawPulses();
}
document.body.insertAdjacentHTML("beforeend", `<div id="wlPop"><div id="wlBox">
  <div class="wlh"><b>Ship watchlists</b><span class="sub">Click a box: <span class="tri s1">✓</span> watched (feed &amp; map) → <span class="tri s2">✗</span> pinged (beeps) → off. Set a whole class, or open it for single ships.</span><span id="wlX" title="Close">✕</span></div>
  <div class="wlb"><div id="wlLists"></div>
    <div id="wlRight"><input id="wlQ" type="text" placeholder="Search ships or classes…"><div id="wlTree"></div></div></div>
  <div id="wlAsk"><div class="ab"><div id="wlAskMsg"></div><div class="row" style="justify-content:flex-end"><button id="wlNo">Cancel</button><button id="wlYes" class="danger">OK</button></div></div></div></div></div>`);
function wlRender() {
  if (!WL.length) WL.push({ name: "My list", on: true, groups: [], types: [], pgroups: [], ptypes: [] });
  if (wlSel >= WL.length) wlSel = 0;
  $("wlLists").innerHTML = WL.map((l, i) => `<div class="wli ${i === wlSel ? "sel" : ""}" data-i="${i}"><input type="checkbox" data-on="${i}" ${l.on !== false ? "checked" : ""} title="Enabled">
      <input type="text" class="wln" data-n="${i}" value="${esc(l.name)}"><span class="sub">✗${(l.pgroups || []).length + (l.ptypes || []).length} ✓${(l.groups || []).length + (l.types || []).length}</span>${WL.length > 1 ? `<span class="wld" data-d="${i}" title="Delete list">✕</span>` : ""}</div>`).join("")
    + `<button id="wlNew">+ New list</button><button id="wlDef" title="Reset the selected list to the original ships: battleships, marauders, Black Ops, T3Cs, capitals, battlecruisers, command ships, Orca/Porpoise, exhumers — all pinged">Restore default ships</button>`;
  const L = WL[wlSel], q = wlQ.trim().toLowerCase();
  const gs = id => stateOf(L, "groups", id), ts_ = id => stateOf(L, "types", id);
  const box = (st, attr, inh) => `<span class="tri s${st}${inh ? " inh" : ""}" ${attr}>${st === 2 ? "✗" : st === 1 ? "✓" : ""}</span>`;
  let html = "";
  for (const g of GROUPS) {
    const gm = !q || g.n.toLowerCase().includes(q), ts = q && !gm ? g.types.filter(t => t.n.toLowerCase().includes(q)) : g.types;
    if (!gm && !ts.length) continue;
    const gst = gs(g.id), open = wlOpenG.has(g.id) || (q && !gm);
    const np = g.types.filter(t => ts_(t.id) === 2).length, nw = g.types.filter(t => ts_(t.id) === 1).length;
    html += `<div class="wlg"><span class="tw" data-tw="${g.id}">${open ? "▾" : "▸"}</span>${box(gst, `data-g="${g.id}"`)} <b>${esc(g.n)}</b>
      <span class="sub">${gst === 2 ? "whole class pinged" : gst === 1 ? "whole class watched" : (np || nw) ? [np && np + " pinged", nw && nw + " watched"].filter(Boolean).join(", ") + " of " + g.types.length : g.types.length + (g.types.length === 1 ? " ship" : " ships")}</span></div>`;
    if (open) html += `<div class="wlt">` + ts.map(t => { const st = ts_(t.id), eff = Math.max(st, gst); return `<label>${box(eff, `data-t="${t.id}"`, st < gst)} ${esc(t.n)}</label>`; }).join("") + `</div>`;
  }
  $("wlTree").innerHTML = html || `<div class="sub">No ships match "${esc(wlQ)}".</div>`;
}
function stateOf(L, kind, id) { return (L["p" + kind] || []).map(Number).includes(id) ? 2 : (L[kind] || []).map(Number).includes(id) ? 1 : 0; }
function setState(L, kind, id, st) {
  L[kind] = (L[kind] || []).map(Number).filter(x => x !== id); L["p" + kind] = (L["p" + kind] || []).map(Number).filter(x => x !== id);
  if (st === 1) L[kind].push(id); if (st === 2) L["p" + kind].push(id);
}
$("wlPop").addEventListener("click", e => {
  const d = e.target.dataset, L = WL[wlSel];
  if (d.g !== undefined || d.t !== undefined) {                       // cycle: off -> ✓ watched -> ✗ pinged -> off
    const kind = d.g !== undefined ? "groups" : "types", id = +(d.g ?? d.t), next = (stateOf(L, kind, id) + 1) % 3;
    setState(L, kind, id, next); wlSave(); wlRender(); return;
  }
  if (e.target.id === "wlPop" || e.target.id === "wlX") { $("wlPop").classList.remove("on"); return; }
  if (e.target.id === "wlNew") { WL.push({ name: "List " + (WL.length + 1), on: true, groups: [], types: [], pgroups: [], ptypes: [] }); wlSel = WL.length - 1; wlSave(); wlRender(); return; }
  if (d.d !== undefined) { const i = +d.d;
    wlAsk(`Delete the list "${esc(WL[i].name)}"? This can't be undone.`, "Delete", () => { WL.splice(i, 1); wlSel = 0; wlSave(); wlRender(); }); return; }
  if (e.target.id === "wlDef") { const L = WL[wlSel];
    wlAsk(`Reset "${esc(L.name)}" to the default ships? Your changes to this list are replaced.`, "Restore", () => {
      Object.assign(L, { groups: [], types: [], ptypes: [], pgroups: (SHIPDB.defaults || []).slice() }); wlSave(); wlRender(); }); return; }
  if (e.target.id === "wlYes") { const f = wlAskFn; wlAskFn = null; $("wlAsk").classList.remove("on"); if (f) f(); return; }
  if (e.target.id === "wlNo") { wlAskFn = null; $("wlAsk").classList.remove("on"); return; }
  if (d.tw !== undefined) { const g = +d.tw; wlOpenG.has(g) ? wlOpenG.delete(g) : wlOpenG.add(g); wlRender(); return; }
  const row = e.target.closest(".wli"); if (row && d.on === undefined && d.n === undefined) { wlSel = +row.dataset.i; wlRender(); }
});
// in-window confirm box (browser dialogs don't work in this window)
let wlAskFn = null;
function wlAsk(msg, yes, fn) { wlAskFn = fn; $("wlAskMsg").innerHTML = msg; $("wlYes").textContent = yes; $("wlAsk").classList.add("on"); $("wlYes").focus(); }
$("wlPop").addEventListener("change", e => {
  const d = e.target.dataset, L = WL[wlSel];
  if (d.on !== undefined) { WL[+d.on].on = e.target.checked; }
  else if (d.n !== undefined) { WL[+d.n].name = e.target.value.trim() || "List"; }
  else return;
  wlSave(); wlRender();
});
$("wlQ").addEventListener("input", e => { wlQ = e.target.value; wlRender(); });
document.addEventListener("keydown", e => { if (e.key !== "Escape") return; if ($("wlAsk").classList.contains("on")) { wlAskFn = null; $("wlAsk").classList.remove("on"); } else $("wlPop").classList.remove("on"); });
$("wlOpen").onclick = () => { wlRender(); $("wlPop").classList.add("on"); $("wlQ").focus(); };
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
$("luOn").onchange = () => post("/settings", { lookupOn: $("luOn").checked });
$("snPick").onclick = () => post("/cmd", { cmd: "pick" });
// hotkey capture boxes -> Electron accelerator strings
const KEYMAP = { " ": "Space", "ArrowUp": "Up", "ArrowDown": "Down", "ArrowLeft": "Left", "ArrowRight": "Right", "ScrollLock": "Scrolllock", "Pause": "Pause", "Insert": "Insert", "Delete": "Delete", "Home": "Home", "End": "End", "PageUp": "PageUp", "PageDown": "PageDown", "Escape": "Escape" };
function accel(e) {
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return null;
  const mods = []; if (e.ctrlKey) mods.push("Ctrl"); if (e.altKey) mods.push("Alt"); if (e.shiftKey) mods.push("Shift");
  let k = KEYMAP[e.key] || (e.code.startsWith("Numpad") ? "num" + e.code.slice(6).toLowerCase().replace("decimal", "dec").replace("add", "add").replace("subtract", "sub").replace("multiply", "mult").replace("divide", "div").replace("enter", "enter") : null)
    || (/^F\d+$/.test(e.key) ? e.key : null) || (e.key.length === 1 ? e.key.toUpperCase() : null);
  return k ? [...mods, k].join("+") : null;
}
[["kEdit", "keyEdit"], ["kMode", "keyMode"]].forEach(([id, key]) => {
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
  const ks = d.ui.keys || {}; $("kEditS").textContent = ks.edit === "ok" ? "✓" : ks.edit || ""; $("kModeS").textContent = ks.mode === "ok" ? "✓" : ks.mode || "";
  const hp = d.helper; $("hlpErr").style.display = hp && hp.ok === false ? "block" : "none";
  if (hp && hp.ok === false) $("hlpErr").textContent = "⚠ Windows helper failed, so active character, window titles and middle-click lookup are off. Send this to Amund: " + hp.err;
  const sn = d.snap; $("snMsg").textContent = sn.msg ? sn.msg + " · " + agoS(sn.t) + " ago" : (st.localArea ? "Local area set." : "No Local area marked yet.");
  if (uiLoaded) return; uiLoaded = true;
  $("ovOp").value = st.overlay.opacity; $("opV").textContent = Math.round(st.overlay.opacity * 100) + "%"; $("ovJ").value = String(st.overlay.mapJumps || 4);
  $("sndOn").checked = st.sound !== false; $("luOn").checked = st.lookupOn !== false;
  $("esiCid").value = st.esiClientId || ""; $("autoSt").checked = !!st.autostart;
  $("kEdit").value = st.keyEdit || ""; $("kMode").value = st.keyMode || "";
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
    RA.ws = { g: new Set((d.watch || {}).g || []), t: new Set((d.watch || {}).t || []) };
    applyUi(d); renderApp(d); renderJump(d); RA.jump = d.jump || []; RA.jumpReach = d.jumpReach || []; RA.si = d.sysInfo || {}; window.IGNORED = new Set(d.ignoredIds || []);
    renderFeed(); renderChars(); renderLocal(); renderBest(); drawPulses(); drawHeat();
    // nodes are 5k+ elements: only rebuild when what they show changed (Local counts, ignore list)
    const sig = JSON.stringify([RA.lc, [...window.IGNORED].sort(), Math.floor(Date.now() / 300000)]);
    if (sig !== RA.nodeSig) { RA.nodeSig = sig; drawNodes(); }
    // first load: start zoomed on the character you're flying
    if (!RA.centered) { const c = RA.chars.find(c => c.active && S[c.sys]) || RA.chars.find(c => c.running && S[c.sys]); if (c) { RA.centered = true; centerOn(S[c.sys], .8); } }
  } catch (e) { $("rStatus").innerHTML = `<span style="color:#ff6b6b">Lost contact with the radar — is its window still open?</span>`; }
}
window.addEventListener("focus", () => document.title = "Hunt radar");
poll(); setInterval(poll, 3000); setInterval(drawPulses, 30000);
