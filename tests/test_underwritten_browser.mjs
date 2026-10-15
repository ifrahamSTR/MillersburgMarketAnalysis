// Browser tests for the Millersburg underwriting map (the rendered page, real clicks, real clipboard).
//   NODE_PATH=<dir with playwright-core's node_modules> node tests/test_underwritten_browser.mjs
// Uses the system Chrome (CHROME=/path/to/chrome to override) and serves this folder on a
// free local port. No request leaves the machine except map tiles: the new listing is placed
// by hand, not looked up on OpenStreetMap. Skips, with a message, if playwright-core is missing.
//  - the page loads with no console errors: 62 comp dots, hero tiles, village limits layer
//  - Add a Zillow listing: address read from the URL, saved, pin placed by clicking the map
//  - the new target's card: setting / zone / area from the pin; every OPEX line priced
//    (Galveston 101's amounts, rounded), so returns compute as soon as revenue is entered
//  - Match by location: only the target's zone, bedrooms +/-1, $40k+, nearest first; turning
//    "Same zone" off widens it; Match by amenities ranks all 62
//  - a comp popup's "Copy row" and the list's copy give the same 15-column line; adding
//    from the list puts it in the comp set; Download UW CSV keeps the template's
//    amortization block byte for byte and writes the comps in revenue order
//  - colour by setting, the village-limits toggle, a shared #p= link, and a 420 px phone
//    view without sideways scrolling
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let chromium;
try { ({ chromium } = require("playwright-core")); } catch (e) {
  console.log("SKIPPED: playwright-core not found (npm install playwright-core, then run with NODE_PATH pointing at its node_modules).");
  process.exit(0);
}
const C = require(join(ROOT, "js/underwritten/uw-csv.js"));
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const UWJ = JSON.parse(readFileSync(join(ROOT, "data/underwritten.json"), "utf8"));
const TEMPLATE = readFileSync(join(ROOT, "underwriting/template", UWJ.templateFile), "utf8");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".csv": "text/csv", ".webp": "image/webp", ".png": "image/png" };

const server = createServer(async (req, res) => {
  try {
    const path = normalize(decodeURIComponent(req.url.split("?")[0])).replace(/^(\.\.[/\\])+/, "");
    const file = join(ROOT, path === "/" ? "underwritten.html" : path);
    if (!(await stat(file)).isFile()) throw new Error("not a file");
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(await readFile(file));
  } catch (e) { res.writeHead(404); res.end("not found"); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = "http://127.0.0.1:" + server.address().port + "/";

let failures = 0;
const check = (ok, msg) => { console.log("  " + (ok ? "ok  " : "FAIL") + " " + msg); if (!ok) failures++; };
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 }, locale: "en-US", permissions: ["clipboard-read", "clipboard-write"], acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error" && !/favicon|tile\.openstreetmap/.test(m.text())) errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(e.message));
// Never let the page reach Nominatim from a test.
await page.route("https://nominatim.openstreetmap.org/**", (r) => r.abort());
const ev = (f, a) => page.evaluate(f, a);
const clip = () => ev(() => navigator.clipboard.readText());

console.log("1. LOAD\n");
await page.goto(BASE + "underwritten.html", { waitUntil: "networkidle" });
await page.waitForFunction(() => window.UW && UW.mapApi && UW.mapApi.map && UW.matchSet);
await page.waitForTimeout(400);
const s0 = await ev(() => ({ n: UW.listings.length, shown: UW.matchSet.size, hero: document.getElementById("uw-hero-stats").innerText, village: UW.ui.layers.village, minRev: UW.ui.filters.minRev }));
check(s0.n === 62, "62 Airbnb comps loaded (" + s0.n + ")");
check(s0.minRev === 40000 && s0.shown === 32, "default floor $40k: " + s0.shown + " of 62 pass");
check(/20 · 42/.test(s0.hero) && s0.village, "hero shows 20 in the village · 42 countryside; village limits layer on");

console.log("\n2. ADD A ZILLOW LISTING\n");
const URL_ = "https://www.zillow.com/homedetails/7000-County-Road-201-Millersburg-OH-44654/99999999_zpid/";
await page.click("#uw-add-btn");
await page.fill("#f-url", URL_);
await page.dispatchEvent("#f-url", "input");
check((await page.inputValue("#f-addr")) === "7000 County Road 201, Millersburg, OH 44654", "address read from the Zillow link: " + (await page.inputValue("#f-addr")));
check(/Blank sheet/.test(await page.locator("#f-tpl option:checked").innerText()), "starts from the blank template by default");
await page.fill("#f-price", "289000");
await page.fill("#f-beds", "2");
await page.fill("#f-baths", "1");
await page.click("details.uw-dlg__more summary");
await page.check("#f-tub");
await page.click(".uw-dlg__foot button[type=submit]");
await page.waitForSelector("#uw-place-bar:not([hidden])");
// Let the map finish flying (a click mid-animation can miss), then place the pin by the
// Berlin-side cabins (countryside), by clicking the map there.
await page.waitForTimeout(900);
await page.waitForFunction(() => { const m = UW.mapApi.map; return !m._animatingZoom && !(m._panAnim && m._panAnim._inProgress) && !m._flyToFrame; });
await ev(() => UW.mapApi.map.setView([40.5652, -81.8560], 15, { animate: false }));
await page.waitForTimeout(200);
const pt = await ev(() => { const p = UW.mapApi.map.latLngToContainerPoint([40.5652, -81.8560]); const r = document.getElementById("uw-leaflet").getBoundingClientRect(); return { x: r.left + p.x, y: r.top + p.y }; });
await page.mouse.click(pt.x, pt.y);
await page.waitForTimeout(300);
await page.click("#uw-place-bar [data-act=place-cancel]");
await page.waitForTimeout(400);
const pid = "z99999999";
const t1 = await ev((pid) => { const p = UW.property(pid); return p && { geo: p.geo, place: p.place, beds: p.versions[0].profile.beds, hotTub: p.versions[0].profile.flags.hot_tub, opexMissing: p.versions[0].outputs.opexMissing, checks: p.versions[0].checks.map((c) => c.kind) }; }, pid);
check(!!t1 && !!t1.geo, "the listing is saved and pinned");
const st1 = await ev((pid) => { const s = UW.property(pid).versions[0].inputs.setup; return UWRules.STANDARD_SETUP.map((x) => { const m = s.find((y) => UWRules.setupKey(y.label) === UWRules.setupKey(x.label)); return m ? m.label + " " + m.amount : "MISSING " + x.label; }); }, pid);
check(st1.every((x) => !/^MISSING|null$/.test(x)), "the new sheet carries the five standard setup lines: " + st1.join(" · "));
check(t1 && t1.place && t1.place.zone === "Countryside" && t1.place.loc === "Countryside" && t1.place.areaName === "East, toward Berlin", "pin reads Countryside, East toward Berlin: " + JSON.stringify(t1 && t1.place));
check(t1 && t1.beds === 2 && t1.hotTub === 1, "target profile: 2 bedrooms, hot tub from the notes (“Existing hot tub”)");
check(t1 && !t1.opexMissing, "OPEX starts priced (Galveston 101's amounts, rounded), so returns compute once revenue is set");

console.log("\n3. MATCH BY LOCATION / AMENITIES\n");
await ev((pid) => UW.select(pid), pid);
await page.waitForTimeout(500);
const loc = await ev((pid) => { const p = UW.property(pid); return UW.results(p).map((x) => ({ id: x.l.id, d: x.d, town: x.l.town, beds: x.l.bedrooms, rev: x.l.revenue })); }, pid);
check(loc.length > 0 && loc.every((x) => !x.town && Math.abs(x.beds - 2) <= 1 && x.rev >= 40000), loc.length + " location matches: all countryside, 1–3 BR, $40k+");
check(loc.every((x, i) => !i || x.d >= loc[i - 1].d), "nearest first");
const panelRows = await page.locator("#uw-p-comps .uw-near li, #uw-p-comps [data-id]").count();
check(panelRows > 0, "the panel lists the matches");
const all0 = await ev((pid) => { UW.ui.n = 50; return UW.results(UW.property(pid)).length; }, pid);
await page.click("#uw-p-comps input[data-rule=zone]");
await page.waitForTimeout(300);
const widerN = await ev((pid) => UW.results(UW.property(pid)).length, pid);
const widerTown = await ev((pid) => UW.results(UW.property(pid)).some((x) => x.l.town), pid);
check(widerN > all0 && widerTown, "“Same zone” off: " + widerN + " matches, village homes included (was " + all0 + ", countryside only)");
await page.click("#uw-p-comps input[data-rule=zone]");
await ev(() => { UW.ui.n = 12; });
await page.click('#uw-p-comps [data-act=mode][data-v=amenity]');
await page.waitForTimeout(300);
const am = await ev((pid) => { UW.ui.n = 100; return UW.results(UW.property(pid)).length; }, pid);
check(am === 62, "Match by amenities ranks all 62 homes");
await ev(() => { UW.ui.n = 12; UW.setMode("location"); });
await page.waitForTimeout(300);

console.log("\n4. COPY, ADD, DOWNLOAD\n");
const first = loc[0].id;
await ev((id) => UW.mapApi.openListing(id), first);
await page.waitForSelector(".uw-pop [data-act=pop-copy]");
await page.click(".uw-pop [data-act=pop-copy]");
await page.waitForTimeout(200);
const popLine = await clip();
check(popLine.split("\t").length === 15 && popLine.includes("/rooms/" + first) && /^\S+\t\d+\t/.test(popLine), "popup Copy row: one 15-column sheet row");
check(/\[Location match\] [\d.]+ mi from 7000 County Road 201 · /.test(popLine), "its note says how it was found and how far: " + popLine.split("\t")[14]);
await page.click(".uw-pop [data-act=pop-add]");
await page.waitForTimeout(300);
await ev(([pid, ids]) => UW.actions.addComps(pid, "Draft", ids.map((i) => UW.byId.get(i))), [pid, loc.slice(1, 4).map((x) => x.id)]);
await page.waitForTimeout(300);
const set = await ev((pid) => UW.property(pid).versions[0].comps.map((c) => c.revenue), pid);
check(set.length === Math.min(4, loc.length) && set.every((r, i) => !i || r <= set[i - 1]), "comp set holds " + set.length + " rows, revenue high to low");
await ev((pid) => UW.actions.copyComps(pid), pid);
await page.waitForTimeout(200);
const lines = (await clip()).split("\n");
check(lines.length === set.length && lines.some((l) => l.split("\t").slice(0, 14).join("\t") === popLine.split("\t").slice(0, 14).join("\t")), "Copy comps gives the same row as the popup");
const [dl] = await Promise.all([page.waitForEvent("download"), ev((pid) => UW.actions.downloadCsv(pid), pid)]);
const csv = readFileSync(await dl.path(), "utf8");
check(C.amortBlock(csv) === C.amortBlock(TEMPLATE), "Download UW CSV: amortization block byte-identical to the template");
const P = C.parse(csv), L = C.locate(P.rows);
const revs = [];
for (let i = L.comps.first; i <= L.comps.last; i++) if (P.rows[i][L.comps.col]) revs.push(+P.rows[i][L.comps.col + 1].replace(/[$,]/g, ""));
check(revs.length === set.length && revs.every((r, i) => !i || r <= revs[i - 1]), "its comp rows in revenue order (" + revs.length + ")");
check([[5, "Furniture / Decor / Essentials"], [16, "Misc"], [17, "CoHost Essentials"], [18, "Design/Project Management"], [19, "Install/Staging/Warehousing"]]
  .every(([r, lab]) => P.rows[r - 1][L.setup.col].trim() === lab && P.rows[r - 1][L.setup.col + 1].trim() !== ""), "the downloaded sheet has the five standard setup lines in rows 5 and 16–19, priced");
check(P.rows[L.price[0]][L.price[1]] === " $ 289,000 " && P.rows[L.url[0]][L.url[1]] === URL_, "price and Zillow URL written; file " + dl.suggestedFilename());

console.log("\n5. OPEX AND RETURNS\n");
await ev((pid) => { const v = UW.property(pid).versions[0]; const inp = JSON.parse(JSON.stringify(v.inputs)); inp.revenue = { low: 40000, mid: 50000, high: 60000 }; UW.setInputs(pid, "Draft", inp); }, pid);
const g1 = await ev((pid) => UW.property(pid).versions[0].outputs.cases.mid.coc, pid);
const ox = await ev((pid) => { const v = UW.property(pid).versions[0]; return { m: v.outputs.opexMonthly, lines: v.inputs.opex.filter((o) => !o.cleaning && o.amount == null).length }; }, pid);
check(g1 != null && ox.m === 4850 && ox.lines === 0, "revenue entered: cash on cash computes straight away; OPEX $" + ox.m + "/month, no empty line");
await ev((pid) => { const v = UW.property(pid).versions[0]; const inp = JSON.parse(JSON.stringify(v.inputs)); inp.opex.find((o) => /Utilities/i.test(o.label)).amount = 400; UW.setInputs(pid, "Draft", inp); }, pid);
const g2 = await ev((pid) => { const v = UW.property(pid).versions[0]; return { coc: v.outputs.cases.mid.coc, missing: !!v.outputs.opexMissing }; }, pid);
check(g2.coc != null && !g2.missing, "editing an OPEX line recalculates cash on cash (" + (g2.coc * 100).toFixed(2) + "% mid)");
await ev((pid) => { UW.ui.cardTab[pid] = "sheet"; UW.ui.expanded.add(pid); UW.cardsApi.renderCard(pid); }, pid);
await page.waitForTimeout(800);
check(await page.locator("#uw-card-" + pid).isVisible(), "the target's card renders with its Sheet tab");

console.log("\n6. LAYERS, LINKS, PHONE\n");
await ev(() => { UW.ui.colorBy = "loc"; UW.mapApi.refresh(); });
const legend = await ev(() => document.querySelector(".uw-legend").textContent);
check(/Setting/.test(legend) && /Downtown/.test(legend) && /Countryside/.test(legend), "colour by setting: legend lists Downtown / Village / Countryside");
await ev(() => { UW.ui.layers.village = false; UW.mapApi.layers(); UW.ui.layers.village = true; UW.mapApi.layers(); });
const hash = await ev(() => location.hash);
check(/p=z99999999/.test(hash), "the URL carries the selected target: " + hash);
const page2 = await ctx.newPage();
page2.on("pageerror", (e) => errors.push("page2: " + e.message));
await page2.goto(BASE + "underwritten.html" + hash, { waitUntil: "networkidle" });
await page2.waitForTimeout(600);
check(await page2.evaluate(() => UW.ui.selected === "z99999999"), "opening that link selects the same target (same browser)");
await page2.close();
const phone = await ctx.newPage();
await phone.setViewportSize({ width: 420, height: 860 });
phone.on("pageerror", (e) => errors.push("phone: " + e.message));
await phone.goto(BASE + "underwritten.html", { waitUntil: "networkidle" });
await phone.waitForTimeout(600);
const ph = await phone.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, mapH: document.getElementById("uw-leaflet").getBoundingClientRect().height }));
check(ph.sw <= ph.cw + 1 && ph.mapH > 250, "phone 420 px: no sideways scroll (" + ph.sw + " / " + ph.cw + "), map " + Math.round(ph.mapH) + " px tall");
await phone.close();
const redirect = await ctx.newPage();
await redirect.goto(BASE + "index.html#p=z99999999", { waitUntil: "networkidle" });
check(/underwritten\.html#p=z99999999$/.test(redirect.url()), "index.html forwards to the map, keeping the link: " + redirect.url().replace(BASE, ""));
await redirect.close();

check(errors.length === 0, "no console errors" + (errors.length ? ": " + errors.join(" | ") : ""));
await browser.close();
server.close();
console.log(`\n${failures ? failures + " FAILURE" + (failures === 1 ? "" : "S") : "All browser checks passed"}.`);
process.exit(failures ? 1 : 0);
