# Hunt Radar

Hunting overlay for EVE Online — all of known space (lowsec, nullsec, Pochven), never highsec or wormholes.
A translucent, click-through mini-map on top of EVE with live PvP kills, ratting activity,
Local intel, pilot lookups and jump range for blops/capitals.

## Install

Download **HuntRadar-Setup-x.y.z.exe** from [Releases](../../releases/latest) and run it.
Windows SmartScreen will warn because the installer isn't code-signed: *More info → Run anyway*.

Updates install themselves: the radar checks GitHub on start and every 6 hours, downloads in the
background and installs when you restart it (tray icon → *Restart to update*).
Settings live in `%APPDATA%\Hunt Radar` and survive updates and reinstalls.

Coming from the old zip versions? *Map & settings → App → Import settings from old zip version*
and pick the old `data` folder.

EVE must run windowed or in *Fixed window* mode — overlays can't draw over exclusive fullscreen.

## Using it

| | |
|---|---|
| **Mini-map** | your character · system · 👥 Local count · ◉ near-me alerts, then the systems around you on the in-game 2D map layout (ratting glow, kill rings, 👥 Local), "⤳ In range:" jump toons that can reach you, latest alerts |
| **Map & settings** | all of New Eden on the in-game 2D map layout (nullsec dark red, lowsec orange, highsec dimmed), kill feed, all settings |
| `Ctrl+Shift+O` | unlock the overlay to move/resize/click it (again to lock) |
| `Ctrl+Shift+M` | show / hide the mini-map |
| `Ctrl+Shift+B` | open / close the big map |
| Tray icon | map & settings, edit overlay, mark Local area, updates, quit |

**Watch range** — kills are kept within 20 gate jumps of any of your characters, or 16 LY of a jump toon.

**Sounds** — low klaxon: any PvP kill within 5 jumps of the character you're flying. Bright triple beep:
a *pinged* ship within 5 jumps of you or near your watched systems. Everything else is silent (feed + map).

**Ship watchlists** — Map & settings → Watched ships: every ship type in the game, several named lists.
Click a box to cycle: ✓ watched (highlighted, silent) → ✗ pinged (beeps) → off.

**Local** — in EVE click Local, `Ctrl+A`, `Ctrl+C`: the radar reads your clipboard and shows
corps/alliances, zKill danger and pilots it has seen killing in watched ships.

**Pilot lookup** — mark the Local area once (tray → *Mark Local area*), then middle-click a name in
Local for a pilot card: portrait, corp/alliance, zKill danger, recent PvP (last 7 days, else 30, else 90),
top ships/systems, links to zKillboard, Dotlan and EVE Who. The click still reaches EVE. OCR misreads
(l/I/1, O/0, rn/m…) are corrected by matching against your last Local `Ctrl+C`, pilots on recent kills,
and look-alike spellings that exist in ESI — copy Local once per system for the best hit rate.

**Jump range** — log your blops/capital toons in with ESI (Map & settings → Jump drive toons).
While one sits in a jump-drive hull, alerts and Best nearby get ⤳✓ when in range, using its real
Jump Drive Calibration level. Needs your own app from
[developers.eveonline.com](https://developers.eveonline.com): callback
`http://localhost:8765/callback`, scopes `esi-location.read_ship_type.v1` and `esi-skills.read_skills.v1`.

**Ignore systems** — Map & settings → Targets → Ignore, or click a system on the map → *Ignore*.

## What it reads

zKillboard's public kill feed (R2Z2), CCP's public ESI data, EVE's own chat log files
(`Documents\EVE\logs\Chatlogs` — *Log Chat to File* must be on), EVE window titles, your clipboard,
and — only if you enable them — middle-clicks plus a screenshot of the one Local row you clicked, and ESI
logins for ship type and skills. It never reads or modifies the EVE client and never sends keystrokes to it.

## Development

```
npm install
npm start            # run from source (settings in ./data)
npm run dist         # build the installer into dist/ without publishing
```

Release: bump `version` in `package.json`, commit, then `git tag vX.Y.Z && git push --tags`
(or run the *Release* workflow from the Actions tab — it tags the version itself).
The *Release* workflow builds the installer on Windows and publishes it; installed copies update.

Map page sources are in `web/` and are assembled into `src/map.html` by `scripts/build-map.js`.
Map layout: `scripts/build-map-data.py [mapSolarSystems.jsonl]` builds `src/data.json` from CCP's SDE
(`position2D`); a compact copy lives in `scripts/sde/pos2d.json`.
