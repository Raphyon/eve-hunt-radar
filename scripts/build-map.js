// Builds src/map.html (the in-app map & settings page) from the pieces in web/.
const fs = require("fs"), path = require("path");
const W = p => fs.readFileSync(path.join(__dirname, "..", "web", p), "utf8");
const page = W("page.html")
  .replace("__RADARPANEL__", () => W("radar_panel.html"))
  .replace("__RADARLEGEND__", () => W("radar_legend.html"))
  .replace("__RADARJS__", () => W("radar.js"))
  .replace("<title>Genesis · Kor-Azor · Kador — hunt map</title>", "<title>Hunt Radar</title>");
fs.writeFileSync(path.join(__dirname, "..", "src", "map.html"), page);
console.log("src/map.html", page.length, "bytes");
