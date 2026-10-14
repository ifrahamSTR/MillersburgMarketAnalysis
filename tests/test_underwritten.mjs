// Tests for the Millersburg underwriting map. Run: node tests/test_underwritten.mjs
// (scripts/build_underwritten.py runs it automatically.)
//  1. Formula check: the template sheet (and every underwritten sheet, once there are any)
//     recomputed from its own inputs vs its own outputs.
//  2. CSV export: the template exported with its own inputs comes back byte-identical; a new
//     listing exported from the blank template keeps the amortization block and every
//     non-input row byte for byte, clears the template's setup / OPEX / cleaning / revenue
//     cells, and writes its comps in revenue order.
//  3. The blank template: only the team's financing and tax assumptions carry over.
//  4. Location rules in the browser (uw-geo.js) match the Python build on every point of
//     tests/fixtures/place_check.json, and every listing's own zone / setting / area.
//  5. Comp classes, the picker (Cleaned_Data entire homes only) and copy rows.
//  6. The two matching modes: location keeps to the target's zone, bedrooms +/-1, nearest
//     first; amenities rank the whole market (nothing excluded); comp-set tags, no
//     duplicates, the cap of 15.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const M = require(join(ROOT, "js/underwritten/uw-math.js"));
const C = require(join(ROOT, "js/underwritten/uw-csv.js"));
const G = require(join(ROOT, "js/underwritten/uw-geo.js"));
const R = require(join(ROOT, "js/underwritten/uw-rules.js"));
const UW = JSON.parse(readFileSync(join(ROOT, "data/underwritten.json"), "utf8"));
const COMPS = JSON.parse(readFileSync(join(ROOT, "data/comps.json"), "utf8"));
const VILLAGE = JSON.parse(readFileSync(join(ROOT, "data/village.json"), "utf8"));
const FIX = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/place_check.json"), "utf8"));
const src = (f) => readFileSync(join(ROOT, "underwriting/source_csv", f), "utf8");
const tpl = (f) => readFileSync(join(ROOT, "underwriting/template", f), "utf8");

let failures = 0, checks = 0;
const fail = (msg) => { failures++; console.log("  FAIL " + msg); };
const ok = (cond, msg) => { checks++; if (!cond) fail(msg); return cond; };

// ---------------------------------------------------------------------------
console.log("1. FORMULA CHECK: sheets recomputed from their own inputs\n");
const versions = UW.properties.flatMap((p) => p.versions.map((v) => ({ name: "file " + v.label, v })));
const T = UW.templates[0];
versions.push({ name: "template " + T.file, v: { inputs: T.sheetInputs, sheet: T.sheet } });
for (const { name, v } of versions) {
  const res = M.verify(v);
  const a = v.sheet.amort, excess = (a.paidLast || 0) - a.loan;
  // The amortization block's Total Paydown column runs a few dollars ahead from its month-2 row
  // in these sheets; the sheet's Principal Pay Down reads it. Reported, not a formula failure.
  const bad = res.rows.filter((r) => r.result === "FAIL" &&
    !(r.key === "principal" && Math.abs(v.sheet.cases.mid.principal - a.paid12) <= 1 && Math.abs(r.diff) <= Math.abs(excess) + 1.5));
  bad.forEach((r) => fail(`${name} ${r.group} ${r.label}: sheet ${r.sheet} vs recomputed ${r.calc}`));
  checks++;
  const quirk = res.rows.filter((r) => r.result === "FAIL").length - bad.length;
  console.log(`  ${bad.length ? "FAIL" : "ok  "} ${name}: ${res.rows.length} outputs, ${res.rows.filter((r) => r.result === "exact").length} exact, ` +
    `${res.rows.filter((r) => r.result === "rounding").length} within display rounding` +
    (quirk ? `, ${quirk} Principal Pay Down cells that read the block's Total Paydown column (a sheet quirk, reported)` : ""));
}

// ---------------------------------------------------------------------------
console.log("\n2. CSV EXPORT\n");
const TEXT = tpl(T.file);
const S = C.parse(TEXT), L = C.locate(S.rows);
const inputRows = new Set([L.notes[0], L.url[0], L.price[0], L.dpPct[0], L.rate[0], L.closingPct[0], L.cleaningCost[0], L.cleaningTurns[0], L.revenue[0][0]]);
for (let i = L.setup.first; i <= L.setup.last; i++) inputRows.add(i);
for (let i = L.opex.first; i <= L.opex.last; i++) inputRows.add(i);
for (let i = L.comps.first; i <= L.comps.last; i++) inputRows.add(i);
{
  const same = C.exportSheet(TEXT, { notes: S.rows[L.notes[0]][L.notes[1]], url: S.rows[L.url[0]][L.url[1]], ...T.sheetInputs,
    comps: undefined });
  ok(same === TEXT, "the template exported with its own inputs is not byte-identical");
  console.log("  ok   template with its own inputs: byte-identical (" + Buffer.byteLength(TEXT) + " bytes)");
}
const listings = COMPS.listings;
const pick = [listings[5], listings[0], listings[12], listings[40]];
const newModel = Object.assign(JSON.parse(JSON.stringify(T.inputs)), {
  notes: "Property Details:\n-- Bed / Bath (projected): 2 / 1\n-- Lot Size (sqft): 43560\n-- Prop Size (sqft): 1200\nWhy This Property?\n-- Hot tub cabin, \"quotes\", commas",
  url: "https://www.zillow.com/homedetails/123-Example-Rd-Millersburg-OH-44654/12345678_zpid/", price: 289000,
  comps: pick.map((l) => R.rowFromListing(l, "note\twith tab")),
});
{
  const out = C.exportSheet(TEXT, newModel), O = C.parse(out);
  ok(C.amortBlock(out) === C.amortBlock(TEXT), "new listing: amortization block differs from the template");
  ok(O.rows.length === S.rows.length && O.rows.every((r) => r.length === 22), "new listing: row count or the 22 columns changed");
  let other = 0;
  S.spans.forEach((s, i) => { if (!inputRows.has(i) && s !== O.spans[i]) other++; });
  ok(other === 0, `new listing: ${other} non-input rows changed`);
  const cell = (rc) => O.rows[rc[0]][rc[1]];
  ok(cell(L.price) === " $ 289,000 " && cell(L.dpPct) === "20%" && cell(L.rate) === "7.25%" && cell(L.closingPct) === "3.00%", "new listing: purchase inputs not written as the sheet formats them");
  ok(cell(L.cleaningCost) === "" && cell(L.cleaningTurns) === "", "new listing: the template's cleaning cost / turns were not cleared");
  ok(L.revenue.every((rc) => cell(rc) === ""), "new listing: revenue cases not empty");
  let setupLeft = 0, opexLeft = 0;
  for (let i = L.setup.first; i <= L.setup.last; i++) if ((O.rows[i][L.setup.col] || O.rows[i][L.setup.col + 1]) && !R.STANDARD_SETUP.some((s) => R.setupKey(s.label) === R.setupKey(O.rows[i][L.setup.col]))) setupLeft++;
  for (let i = L.opex.first; i <= L.opex.last; i++) if (O.rows[i][L.opex.col] && O.rows[i][L.opex.col + 1]) opexLeft++;
  ok(setupLeft === 0, `new listing: ${setupLeft} setup rows from the Galveston template left in (besides the five standard lines)`);
  ok(opexLeft === 0, `new listing: ${opexLeft} OPEX amounts from the Galveston template left in`);
  const revs = [];
  for (let i = L.comps.first; i <= L.comps.last; i++) if (O.rows[i][L.comps.col]) revs.push(+O.rows[i][L.comps.col + 1].replace(/[$,]/g, ""));
  ok(revs.length === 4 && revs.every((r, i) => !i || r <= revs[i - 1]), "new listing: comp rows missing or not revenue high to low");
  ok(O.rows[L.comps.first][L.comps.col + 14] === "note\twith tab", "new listing: comp note not written as typed");
  console.log(`  ${failures ? "see above" : "ok  "} new listing from the blank template: amortization rows ${L.amort.first + 1}-${L.amort.last + 1} identical, ` +
    "template setup / OPEX / cleaning / revenue cleared, 4 comps in revenue order");
}

// ---------------------------------------------------------------------------
console.log("\n3. BLANK TEMPLATE\n");
{
  const I = T.inputs, K = T.kept;
  ok(I.price == null && I.setup.length === 5 && I.setup.every((x) => R.STANDARD_SETUP.some((s) => s.label === x.label && s.amount === x.amount)) && I.cleaningCost == null && I.cleaningTurns == null, "template: price / cleaning not blank, or setup isn't exactly the five standard lines");
  ok(I.opex.length > 0 && I.opex.every((o) => o.amount == null), "template: OPEX amounts not blank (labels should stay)");
  ok(["low", "mid", "high"].every((c) => I.revenue[c] == null), "template: revenue not blank");
  ok(Object.keys(K).every((k) => I[k] === K[k] && K[k] === T.sheetInputs[k]), "template: financing / tax assumptions differ from the sheet's");
  const out = M.compute(Object.assign({}, I, { price: 300000 }));
  ok(Math.abs(out.down - 60000) < 0.01 && Math.abs(out.loan - 240000) < 0.01 && Math.abs(out.closing - 9000) < 0.01 && out.opexMonthly === 0 && out.setupTotal === 121750,
    "template: $300k purchase does not give 20% down / 3% closing / no OPEX / the five standard setup lines ($121,750)");
  console.log(`  ok   kept: ${Object.entries(K).map(([k, v]) => k + " " + v).join(", ")}; OPEX amounts, cleaning and revenue blank; setup = the five standard lines`);
}

// ---------------------------------------------------------------------------
console.log("\n4. LOCATION RULES: browser vs build\n");
G.init(VILLAGE, listings);
{
  let bad = 0;
  for (const p of FIX.points) {
    const c = G.classify(p.lat, p.lng);
    if (c.loc !== p.loc || c.zone !== p.zone || c.town !== p.town || c.area !== p.area || Math.abs(c.centerKm - p.centerKm) > 0.0015) {
      bad++;
      if (bad <= 5) fail(`point ${p.lat},${p.lng}: browser ${c.loc}/${c.zone}/${c.area}/${c.centerKm} vs build ${p.loc}/${p.zone}/${p.area}/${p.centerKm}`);
    }
  }
  checks++;
  if (bad) fail(`${bad} of ${FIX.points.length} points disagree`);
  const counts = {};
  FIX.points.forEach((p) => (counts[p.loc] = (counts[p.loc] || 0) + 1));
  console.log(`  ${bad ? "FAIL" : "ok  "} ${FIX.points.length} points agree on setting, zone, area and distance (${Object.entries(counts).map(([k, v]) => k + " " + v).join(", ")})`);
  let own = 0;
  listings.forEach((l) => { const c = G.classify(l.lat, l.lng); if (c.loc === l.loc && c.town === l.town && c.zone === l.zone && c.area === l.area) own++; });
  ok(own === listings.length, `listings: ${own} of ${listings.length} get their own setting / zone / area`);
  console.log(`  ok   every listing's own point gives its setting, zone and area (${own} of ${listings.length})`);
  const a = G.zillowAddress("https://www.zillow.com/homedetails/4567-State-Route-39-Millersburg-OH-44654/98765432_zpid/");
  ok(a && a.street === "4567 State Route 39" && a.city === "Millersburg" && a.state === "OH" && a.zip === "44654" && a.zpid === "98765432", "Zillow slug not read: " + JSON.stringify(a));
  const b = G.zillowAddress("https://www.zillow.com/homedetails/5000-Twp-Rd-366-Walnut-Creek-OH-44687/11111111_zpid/");
  ok(b && b.city === "Walnut Creek" && b.street === "5000 Twp Rd 366", "two-word city not read: " + JSON.stringify(b));
}

// ---------------------------------------------------------------------------
console.log("\n5. COMP CLASSES, PICKER, COPY ROWS\n");
const byId = new Map(listings.map((l) => { l.flagSet = new Set(l.flags); return [l.id, l]; }));
const ctx = { byId, index: UW.audit.index || {}, badUrls: UW.audit.badUrls || {} };
{
  const l = listings[0];
  ok(R.classify({ url: "https://www.zillow.com/homedetails/1-Main-St-Millersburg-OH-44654/1_zpid/" }, ctx).cls === "zillow", "a Zillow URL is not an error");
  ok(R.classify({ url: "Cozy cabin - Cabins for Rent in Millersburg" }, ctx).cls === "badurl", "a title is not flagged as a bad URL");
  ok(["usable", "possibly"].includes(R.classify(R.rowFromListing(l, ""), ctx).cls), "a listing's own row is not usable");
  ok(R.classify(R.rowFromListing(l, ""), ctx).changes.length === 0, "a listing's own row shows value changes");
  ok(!R.canPick(COMPS.otherRooms[0], byId) && COMPS.otherRooms.length === 1, "the private room can be picked as a comp");
  const tsv = C.compsTSV([R.rowFromListing(listings[3], "a"), R.rowFromListing(listings[0], "b")]).split("\n");
  ok(tsv.length === 2 && tsv.every((r) => r.split("\t").length === 15) && +tsv[0].split("\t")[1] >= +tsv[1].split("\t")[1], "copied rows are not 15 columns in revenue order");
  ok(COMPS.n === 62 && listings.every((x) => x.quality === "Good" || x.quality === "Possibly Good"), "comps.json is not the 62 Good / Possibly Good entire homes");
  console.log("  ok   Zillow URL / title / workbook row classes; private room not pickable; copy rows 15 columns, revenue high to low");
}

// ---------------------------------------------------------------------------
console.log("\n6. MATCHING\n");
{
  const prof = (beds, flags) => ({ beds, baths: 1, sleeps: beds * 2 + 2, flags: Object.fromEntries(R.PROFILE_FLAGS.map((f) => [f, (flags || []).includes(f) ? 1 : 0])) });
  const ctr = VILLAGE.center;
  // A village target (near the courthouse) and a countryside target (by the Berlin-side cabins).
  const vt = Object.assign({ lat: ctr.lat + 0.004, lng: ctr.lng + 0.002 }, G.classify(ctr.lat + 0.004, ctr.lng + 0.002));
  const ct = Object.assign({ lat: 40.5665, lng: -81.8515 }, G.classify(40.5665, -81.8515));
  ok(vt.zone === "Village" && ct.zone === "Countryside", "test targets are not in the expected zones");
  const above = listings.filter((l) => l.revenue >= COMPS.minRevDefault);
  const vm = R.matchLocation(above, { lat: vt.lat, lng: vt.lng, zone: vt.zone, beds: 2 }, { zone: true });
  const cm = R.matchLocation(above, { lat: ct.lat, lng: ct.lng, zone: ct.zone, beds: 2 }, { zone: true });
  ok(vm.length > 0 && vm.every((x) => x.l.town && Math.abs(x.l.bedrooms - 2) <= 1), "village target: a match outside the village or beyond bedrooms +/-1");
  ok(cm.length > 0 && cm.every((x) => !x.l.town && Math.abs(x.l.bedrooms - 2) <= 1), "countryside target: a match inside the village or beyond bedrooms +/-1");
  ok([vm, cm].every((m) => m.every((x, i) => !i || x.d >= m[i - 1].d)), "location matches are not nearest first");
  const off = R.matchLocation(above, { lat: vt.lat, lng: vt.lng, zone: vt.zone, beds: 2 }, { zone: false });
  ok(off.length > vm.length && off.some((x) => !x.l.town), "turning 'same zone' off does not widen the match");
  console.log(`  ok   location: village target ${vm.length} matches (all in the village), countryside target ${cm.length} (all outside), nearest first; zone off widens to ${off.length}`);
  const am = R.matchAmenity(listings, prof(2, ["hot_tub"]), { bedsExact: true, sleepsWindow: 2, pool: null, prefs: Object.fromEntries(R.AMENITY_ORDER.map((f) => [f, "prefer"])) });
  ok(am.length === listings.length, "amenity ranking dropped homes (it must rank the whole market)");
  const firstOff = am.findIndex((x) => x.bedsTier > 0);
  ok(firstOff < 0 || am.slice(firstOff).every((x) => x.bedsTier > 0), "amenity ranking: an off-bedroom home ranks above an exact one");
  ok(am[0].l.bedrooms === 2 && am[0].l.flagSet.has("hot_tub") && !am[0].l.flagSet.has("pool"), "amenity ranking: the top home is not a 2BR with a hot tub and no pool");
  console.log(`  ok   amenities: all ${am.length} homes ranked, bedrooms first; top: ${am[0].l.title} (${am[0].l.bedrooms}BR, hot tub)`);
  // Comp set: tags, no duplicates, cap of 15.
  const t = { lat: ct.lat, lng: ct.lng, street: "123 Example Rd" };
  const note = (mode) => (l) => R.autoNote(l, "East, toward Berlin", t, mode, null);
  let rows = [];
  ({ rows } = R.addToSet(rows, cm[0].l, { byId, mode: "location", note: note("location") }));
  let r2 = R.addToSet(rows, cm[0].l, { byId, mode: "location", note: note("location") });
  ok(r2.result === "duplicate" && r2.rows.length === 1, "adding the same comp twice duplicated it");
  r2 = R.addToSet(rows, cm[0].l, { byId, mode: "amenity", note: note("amenity") });
  ok(r2.result === "both" && /^\[Location \+ Amenity match\] /.test(r2.rows[0].notes), "a comp found by both modes is not retagged");
  ok(/^\[Location match\] \d+\.\d mi from 123 Example Rd · \d+BR\/[\d.]+BA · sleeps \d+/.test(rows[0].notes) && / · Countryside · East, toward Berlin$/.test(rows[0].notes),
    "auto note not in the expected form: " + rows[0].notes);
  let full = [];
  listings.slice(0, 20).forEach((l) => { full = R.addToSet(full, l, { byId, mode: "location", note: note("location") }).rows; });
  ok(full.length === 15, "the comp set is not capped at 15");
  console.log("  ok   comp set: no duplicates, retag to [Location + Amenity match], note: " + rows[0].notes);
}

// ---------------------------------------------------------------------------
console.log("\nSTANDARD SETUP LINES: every new sheet carries the five, at Galveston file 101's amounts\n");
{
  const bad = (m) => fail("standard setup: " + m);
  const WANT = [["Furniture / Decor / Essentials", 50000, 5], ["Misc", 25000, 16], ["CoHost Essentials", 3500, 17], ["Design/Project Management", 25000, 18], ["Install/Staging/Warehousing", 18250, 19]];
  const key = (s) => R.setupKey(s);
  const fresh = R.withStandardSetup([]);
  if (!(fresh.length === 5 && WANT.every(([l, a]) => fresh.some((x) => key(x.label) === key(l) && x.amount === a)))) bad("an empty setup doesn't get the five lines at 101's amounts");
  const kept = R.withStandardSetup([{ label: "Furniture / Decor / Essentials", amount: 15000 }, { label: "Hot Tub", amount: 16000 }, { label: "Misc", amount: 50000 }, { label: "Misc", amount: null }]);
  if (!(kept.find((x) => key(x.label) === key("Furniture / Decor / Essentials")).amount === 15000 && kept.filter((x) => key(x.label) === "misc").map((x) => x.amount).join() === "50000," && kept.length === 7))
    bad("a priced line was changed, or a second Misc was filled");
  const filled = R.withStandardSetup([{ label: "Misc", amount: null }]);
  if (filled.find((x) => key(x.label) === "misc").amount !== 25000) bad("a blank Misc line wasn't given 101's amount");
  // Exported from this site's new-listing template, the five land in rows 5 and 16-19 with their amounts.
  const tdir = (UW.templates || []).some((t) => t.file === UW.templateFile) ? "underwriting/template" : "underwriting/source_csv";
  const TT = readFileSync(join(ROOT, tdir, UW.templateFile), "utf8"), P0 = C.parse(TT), L0 = C.locate(P0.rows);
  const base = (UW.templates || []).find((t) => t.file === UW.templateFile);
  const inputs = base ? JSON.parse(JSON.stringify(base.inputs)) : JSON.parse(JSON.stringify(UW.properties.flatMap((p) => p.versions).find((v) => v.file === UW.templateFile).inputs));
  inputs.setup = R.withStandardSetup(inputs.setup);
  const out = C.parse(C.exportSheet(TT, Object.assign(inputs, { notes: "n", url: "https://www.zillow.com/homedetails/1-Test-Rd/1_zpid/", price: 400000, comps: [] })));
  const cell = (r) => [out.rows[r - 1][L0.setup.col].trim(), out.rows[r - 1][L0.setup.col + 1].trim()];
  const placed = WANT.every(([l, a, r]) => key(cell(r)[0]) === key(l) && (base ? cell(r)[1].replace(/[$\s,]/g, "") === String(a) : cell(r)[1] !== ""));
  if (!placed) bad("exported template rows 5/16-19: " + WANT.map(([, , r]) => cell(r).join(" ")).join(" | "));
  console.log("  " + (placed ? "ok  " : "FAIL") + " " + UW.templateFile + ": rows 5, 16, 17, 18, 19 hold " + WANT.map(([, , r]) => cell(r).join(" ")).join(" · "));
}

console.log(`\n${failures ? failures + " FAILURE" + (failures === 1 ? "" : "S") : "All " + checks + " checks passed"}.`);
process.exit(failures ? 1 : 0);
