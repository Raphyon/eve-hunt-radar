#!/usr/bin/env python3
"""Builds src/data.json (the big map's layout) for all gated known space.

Layout = CCP's own schematic 2D map ("position2D" in the SDE's mapSolarSystems.jsonl) -
the same flat map the game uses. Names / security / regions / gates come from src/universe.json.

  python3 scripts/build-map-data.py [path/to/mapSolarSystems.jsonl]

With a path it refreshes scripts/sde/pos2d.json (id -> [x, y]) first; without one it reuses that file.
"""
import json, math, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
POS2D = os.path.join(HERE, "sde", "pos2d.json")

if len(sys.argv) > 1:
    pos = {}
    for line in open(sys.argv[1], encoding="utf-8"):
        d = json.loads(line)
        if "position2D" in d and 30000000 <= d["_key"] < 31000000:
            pos[str(d["_key"])] = [d["position2D"]["x"], d["position2D"]["y"]]
    json.dump(pos, open(POS2D, "w"), separators=(",", ":"))
    print("wrote", POS2D, len(pos), "systems")
pos = {int(k): v for k, v in json.load(open(POS2D)).items()}

U = json.load(open(os.path.join(ROOT, "src", "universe.json")))
regions = dict(U["regions"]) if isinstance(U["regions"], list) else U["regions"]
R = [r[1] for r in U["regions"]]
C = [c[1] for c in U["consts"]]
syss = U["sys"]                       # [id, name, sec, regionIdx, constIdx, x, y, z]

missing = [s[1] for s in syss if s[0] not in pos]
if missing:
    print("no 2D position for", len(missing), "systems (left off the big map):", ", ".join(missing[:12]), "…" if len(missing) > 12 else "")
keep = [s for s in syss if s[0] in pos]

# grid unit = smallest distance between two systems in the same constellation (the schematic is grid-based)
byc = {}
for s in keep: byc.setdefault(s[4], []).append(pos[s[0]])
unit = min(math.dist(a, b) for pts in byc.values() for i, a in enumerate(pts) for b in pts[i + 1:] if math.dist(a, b) > 0)
SX, SY = 105.0 / unit, 62.0 / unit   # px per grid step: room for a node box (~90 x 28) plus gaps
                                      # (the page multiplies x by 1.55 and y by 1.25 again)
SX, SY = SX / 1.55, SY / 1.25
xs = [pos[s[0]][0] for s in keep]; ys = [pos[s[0]][1] for s in keep]
x0, y1 = min(xs), max(ys)

out_sys = []
for s in keep:
    px, py = pos[s[0]]
    out_sys.append({"id": s[0], "n": s[1], "x": round((px - x0) * SX + 200, 1), "y": round((y1 - py) * SY + 200, 1),
                    "c": C[s[4]], "r": R[s[3]], "s": s[2]})
ids = {s[0] for s in keep}
gates = [[syss[a][0], syss[b][0]] for a, b in U["gates"] if syss[a][0] in ids and syss[b][0] in ids]
json.dump({"sys": out_sys, "gates": gates, "stubs": []}, open(os.path.join(ROOT, "src", "data.json"), "w"), separators=(",", ":"))
print("src/data.json:", len(out_sys), "systems,", len(gates), "gates, grid unit", unit)
