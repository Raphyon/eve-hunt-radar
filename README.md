# Hunt Radar

Lowsec hunting overlay for EVE Online — Genesis, Kor-Azor and Kador (plus the Armi pocket in Domain).
A translucent, click-through strip or mini-map on top of EVE with live PvP kills, ratting activity,
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
| **Strip** | your character · system · 👥 Local count (⚠ known killers) · ◉ near-me alerts · newest alert or best nearby · jump range |
| **Mini-map** | systems around you: ratting glow, kill rings (magenta = watched ship), 👥 Local, ⤳ jump range |
| `Ctrl+Shift+O` | unlock the overlay to move/resize/click it (again to lock) |
| `Ctrl+Shift+M` | strip ↔ mini-map |
| Tray icon | map & settings, edit overlay, mark Local area, updates, quit |

**Sounds** — bright triple beep: a watched ship (battleship, marauder, Black Ops, T3C, capital,
battlecruiser, Orca/Porpoise, exhumer) near your targets or characters. Low klaxon: any lowsec PvP
kill within 5 jumps of the character you're flying.

**Local** — in EVE click Local, `Ctrl+A`, `Ctrl+C`: the radar reads your clipboard and shows
corps/alliances, zKill danger and pilots it has seen killing in watched ships.
Optional snapshot key: screenshot + Windows OCR of the Local area you mark, or `Ctrl+A, Ctrl+C`
sent to EVE (grey area under CCP's input rules — your own risk).

**Pilot lookup** — mark the Local area once (tray → *Mark Local area*), then middle-click a name in
Local for a zKill card (danger, gang/solo, kills, top ships/systems). The click still reaches EVE.

**Jump range** — log your blops/capital toons in with ESI (Map & settings → Jump drive toons).
While one sits in a jump-drive hull, alerts and Best nearby get ⤳✓ when in range, using its real
Jump Drive Calibration level. Needs your own app from
[developers.eveonline.com](https://developers.eveonline.com): callback
`http://localhost:8765/callback`, scopes `esi-location.read_ship_type.v1` and `esi-skills.read_skills.v1`.

**Ignore systems** — Map & settings → Targets → Ignore, or click a system on the map → *Ignore*.

## What it reads

zKillboard's public kill feed (R2Z2), CCP's public ESI data, EVE's own chat log files
(`Documents\EVE\logs\Chatlogs` — *Log Chat to File* must be on), EVE window titles, your clipboard,
and — only if you enable them — a screenshot of the Local area you mark, middle-clicks, and ESI
logins for ship type and skills. It never reads or modifies the EVE client.

## Development

```
npm install
npm start            # run from source (settings in ./data)
npm run dist         # build the installer into dist/ without publishing
```

Release: bump `version` in `package.json`, commit, then `git tag vX.Y.Z && git push --tags`.
The *Release* workflow builds the installer on Windows and publishes it; installed copies update.

Map page sources are in `web/` and are assembled into `src/map.html` by `scripts/build-map.js`.
