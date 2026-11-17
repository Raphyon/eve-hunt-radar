"""Builds src/universe.json from CCP static data (scripts/sde/*.csv) + system positions (pos.json).
Keeps gated known space only (no wormholes / abyssal). Positions in light years, 2 decimals."""
import csv, json, os
D = os.path.join(os.path.dirname(__file__), "sde"); OUT = os.path.join(os.path.dirname(__file__), "..", "src", "universe.json")
LY = 9.4607e15
R = {r["regionID"]: r["regionName"] for r in csv.DictReader(open(f"{D}/mapRegions.csv"))}
C = {r["constellationID"]: r["constellationName"] for r in csv.DictReader(open(f"{D}/mapConstellations.csv"))}
J = [(int(r["fromSolarSystemID"]), int(r["toSolarSystemID"])) for r in csv.DictReader(open(f"{D}/mapSolarSystemJumps.csv"))]
gated = {a for a, _ in J} | {b for _, b in J}
P = json.load(open(f"{D}/pos.json"))
S = [s for s in csv.DictReader(open(f"{D}/mapSolarSystems.csv")) if int(s["solarSystemID"]) < 31000000 and int(s["solarSystemID"]) in gated]
regions = sorted({s["regionID"] for s in S}); consts = sorted({s["constellationID"] for s in S})
ri = {r: i for i, r in enumerate(regions)}; ci = {c: i for i, c in enumerate(consts)}
idx = {int(s["solarSystemID"]): i for i, s in enumerate(S)}
sys = []
for s in S:
    p = P.get(s["solarSystemID"])
    sys.append([int(s["solarSystemID"]), s["solarSystemName"], round(float(s["security"]), 4), ri[s["regionID"]], ci[s["constellationID"]],
                *( [round(v / LY, 2) for v in p] if p else [None, None, None])])
gates = sorted({tuple(sorted((idx[a], idx[b]))) for a, b in J if a in idx and b in idx})
out = {"v": 1, "regions": [[int(r), R.get(r, r)] for r in regions], "consts": [[int(c), C.get(c, c)] for c in consts],
       "sys": sys, "gates": [list(g) for g in gates]}
json.dump(out, open(OUT, "w"), separators=(",", ":"))
print(f"{len(sys)} systems, {len(gates)} gates, {len(regions)} regions, {os.path.getsize(OUT)//1024} KB; no position: {sum(1 for s in sys if s[5] is None)}")
