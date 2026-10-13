/**
 * Rules shared by the page and the Node tests (window.UWRules / require):
 *  - comp audit classes. Comps are only Airbnb listings in the workbook's
 *    Cleaned_Data sheet (entire homes). Zillow listings are acquisition
 *    targets and never comps; a Zillow URL in a comp table is an error.
 *  - the auto-filled comp note, built from workbook data only, tagged with the
 *    matching mode ([Location match] / [Amenity match] / [Location + Amenity match]);
 *  - comp rows built from a listing (the one path every copy and add uses), and
 *    the comp-set rules (no duplicates, retag on re-add, 15 rows, append distance);
 *  - Analyst Notes parsing, including the target (after-conversion) bedrooms;
 *  - the target profile (bedrooms / baths / sleeps and 10 amenity flags, each
 *    with its source: a setup line item, the notes or a default);
 *  - the two matching modes: by location (distance within the same zone,
 *    Village or Countryside) and by amenities (the whole market ranked best to worst, nothing excluded,
 *    in strict priority: bedrooms, sleeps, pool, then the other flags as
 *    Must / Prefer / Ignore; never a blended score).
 * The build (scripts/build_underwritten.py) classifies the sheets' rows with
 * the same rules; tests/test_underwritten.mjs checks the two agree.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.UWRules = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const SHEET_FLAGS = ["hot_tub", "pool", "game_room", "pickleball", "mini_golf", "sauna", "playground", "waterfront"];
  const FLAG_LABEL = { hot_tub: "Hot tub", pool: "Pool", game_room: "Game room", pickleball: "Pickleball", mini_golf: "Mini golf", sauna: "Sauna", playground: "Playground", waterfront: "Waterfront" };
  const CLASSES = {
    usable: { label: "Usable", valid: true, short: "usable" },
    possibly: { label: "Usable, possibly good", valid: true, short: "possibly good" },
    excluded: { label: "Excluded for data quality", valid: false, short: "Not Good Data" },
    never: { label: "Never scored", valid: false, short: "never scored" },
    room: { label: "Not an entire home", valid: false, short: "not an entire home" },
    removed: { label: "In Removed_Listings", valid: false, short: "in Removed_Listings" },
    missing: { label: "Not in any workbook", valid: false, short: "not in any workbook" },
    badurl: { label: "Not a valid Airbnb URL", valid: false, short: "not a valid URL" },
    zillow: { label: "Zillow URL in a comp table", valid: false, short: "Zillow URL" },
  };
  const ROOM_RE = /airbnb\.[a-z.]+\/rooms\/(?:plus\/)?(\d+)/i;
  const roomId = (url) => { const m = String(url || "").match(ROOM_RE); return m ? m[1] : null; };
  const isZillow = (url) => /(^|[/.@])zillow\.com/i.test(String(url || ""));
  const round2 = (v) => Math.round(v * 100) / 100;
  const num = (v) => (v == null || isNaN(v) ? "—" : String(Math.round(v * 100) / 100));

  function valueChanges(c, cur) {
    const ch = [];
    const cmp = (field, label, old, neu, tol, fmt) => { if (old == null || neu == null || Math.abs(old - neu) > tol) ch.push({ field, label, sheet: old, current: neu, fmt }); };
    cmp("revenue", "Revenue", c.revenue, cur.revenue, 0.51, "money");
    cmp("bedrooms", "Bedrooms", c.bedrooms, cur.bedrooms, 0.01, "num");
    cmp("sleeps", "Sleeps", c.sleeps, cur.sleeps, 0.01, "num");
    cmp("adr", "ADR", c.adr, round2(cur.adr), 0.006, "money2");
    // Several sheets typed occupancy to one decimal (57.9 for 57.93): within 0.05 points is the same value.
    cmp("occupancy", "Occupancy", c.occupancy == null ? null : round2(c.occupancy * 100), round2(cur.occ * 100), 0.051, "pctpts");
    SHEET_FLAGS.forEach((f) => cmp("HAS_" + f, "HAS_" + f, c.flags && c.flags[f] ? 1 : 0, cur.flagSet.has(f) ? 1 : 0, 0, "flag"));
    return ch;
  }

  /**
   * Exactly one class per comp row.
   * ctx: { byId: Map(id -> listing in comps.json, i.e. Cleaned_Data entire homes),
   *        index: {id: {cls, reason}} from the build, badUrls: {cell text: {reason, candidates}} }
   */
  function classify(c, ctx) {
    const url = String(c.url || "").trim();
    const make = (cls, extra) => Object.assign({ cls, label: CLASSES[cls].label, valid: CLASSES[cls].valid, reason: "", id: null, changes: [],
      bigRevenue: false, bedroomsChanged: false, revenueChangePct: null, current: null }, extra || {});
    if (isZillow(url)) return make("zillow", { reason: "A Zillow listing is an acquisition target, never a comp" });
    const id = roomId(url);
    if (!id) {
      const b = (ctx.badUrls || {})[url];
      return make("badurl", { reason: b ? b.reason : url ? "The cell holds text, not an airbnb.com/rooms/ link" : "The cell is empty", candidates: b ? b.candidates : [] });
    }
    const cur = ctx.byId.get(id);
    if (cur) {
      const changes = valueChanges(c, cur);
      const pct = c.revenue ? (cur.revenue - c.revenue) / c.revenue : null;
      return make(cur.quality === "Good" ? "usable" : "possibly", { id, reason: cur.quality === "Good" ? "Good Data" : "Possibly Good Data", changes, current: cur,
        revenueChangePct: pct == null ? null : Math.round(pct * 1000) / 10, bigRevenue: pct != null && Math.abs(pct) > 0.15,
        bedroomsChanged: c.bedrooms != null && Math.abs(cur.bedrooms - c.bedrooms) > 0.01 });
    }
    const ix = (ctx.index || {})[id];
    if (ix && CLASSES[ix.cls] && !CLASSES[ix.cls].valid) return make(ix.cls, { id, reason: ix.reason, title: ix.title, appearsIn: ix.appearsIn || [] });
    return make("missing", { id, reason: "Not among the entire homes in the current workbook's Cleaned_Data" });
  }

  // The comp picker (map, lists, add-to-set) only ever offers Cleaned_Data entire homes.
  const canPick = (id, byId) => !!id && byId.has(String(id));

  function miles(lat1, lng1, lat2, lng2) {
    const R = 3958.8, rad = Math.PI / 180;
    const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lng2 - lng1) * rad) / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  const TAG = { location: "[Location match]", amenity: "[Amenity match]", both: "[Location + Amenity match]" };
  const TAG_RE = /^\[(?:Location \+ Amenity|Location|Amenity) match\]\s*/;
  function amenityWords(f) {
    const am = [];
    if (f.has("pool")) am.push(f.has("pool_heater") ? "heated pool" : "pool");
    [["hot_tub", "hot tub"], ["game_room", "game room"], ["pickleball", "pickleball"], ["mini_golf", "mini golf"], ["sauna", "sauna"], ["playground", "playground"]]
      .forEach(([k, t]) => { if (f.has(k)) am.push(t); });
    return am;
  }
  /**
   * Workbook data only:
   *   "[Location match] 0.8 mi from 123 Example Rd · 2BR/1BA · sleeps 6 · hot tub · Countryside · East, toward Berlin"
   *   "[Amenity match] 3.1 mi from … · 2BR/1BA · sleeps 6 · hot tub · 1 of 2 preferred · Village · Millersburg"
   * No target: no tag and no distance (there is nothing it was matched against).
   */
  function autoNote(l, areaName, target, mode, info) {
    const f = l.flagSet || new Set(l.flags || []);
    const parts = [];
    if (target && target.lat != null) parts.push(Math.max(0.1, Math.round(miles(target.lat, target.lng, l.lat, l.lng) * 10) / 10).toFixed(1) + " mi from " + target.street);
    parts.push((l.bedrooms === 0 ? "Studio" : num(l.bedrooms) + "BR") + "/" + num(l.baths) + "BA", "sleeps " + num(l.sleeps));
    const am = amenityWords(f);
    if (am.length) parts.push(am.join(" + "));
    if (mode === "amenity" && info && info.prefTotal != null) parts.push(info.prefMatched + " of " + info.prefTotal + " preferred");
    parts.push(l.loc);
    if (areaName) parts.push(areaName);
    const tag = target && TAG[mode] ? TAG[mode] + " " : "";
    return tag + parts.join(" · ");
  }
  const retag = (notes, mode) => TAG[mode] + " " + String(notes || "").replace(TAG_RE, "");

  /** The comp row a listing becomes, in the sheet's units (every copy and add path goes through here). */
  function rowFromListing(l, notes, match) {
    const f = l.flagSet || new Set(l.flags || []);
    const row = { url: l.url, id: l.id, revenue: l.revenue, bedrooms: l.bedrooms, sleeps: l.sleeps, adr: round2(l.adr), occupancy: Math.round(l.occ * 10000) / 10000,
      flags: Object.fromEntries(SHEET_FLAGS.map((k) => [k, f.has(k) ? 1 : 0])), notes: notes || "" };
    if (match) row.match = match;
    return row;
  }

  /**
   * Add a listing to a comp set (rows = the set as it is). Never duplicates a row:
   * a comp added from the other mode becomes "both" and its tag changes to
   * [Location + Amenity match]; rows from the sheet keep their notes. 15 rows at most.
   * ctx: { byId, mode: "location" | "amenity", note: (listing) => text }
   */
  function addToSet(rows, l, ctx) {
    if (!canPick(l.id, ctx.byId)) return { rows, result: "invalid" };
    const i = rows.findIndex((r) => (r.id || roomId(r.url)) === l.id);
    if (i >= 0) {
      const r = rows[i], m = r.match;
      if ((m === "location" && ctx.mode === "amenity") || (m === "amenity" && ctx.mode === "location")) {
        const out = rows.slice();
        out[i] = Object.assign({}, r, { match: "both", notes: retag(r.notes, "both") });
        return { rows: out, result: "both" };
      }
      return { rows, result: "duplicate" };
    }
    if (rows.length >= 15) return { rows, result: "full" };
    return { rows: rows.concat([rowFromListing(l, ctx.note(l), ctx.mode)]), result: "added" };
  }
  // "Append distance to notes" (only when the user clicks it): sheet rows gain "· 0.8 mi from <target>".
  function appendDistance(rows, target, byId) {
    return rows.map((r) => {
      const l = byId.get(r.id || roomId(r.url));
      if (!l || !target || target.lat == null || (r.match && r.match !== "sheet") || / mi from /.test(r.notes || "")) return r;
      const d = Math.max(0.1, Math.round(miles(target.lat, target.lng, l.lat, l.lng) * 10) / 10).toFixed(1) + " mi from " + target.street;
      return Object.assign({}, r, { notes: (r.notes ? r.notes + " · " : "") + d });
    });
  }

  // ---------------------------------------------------------------------------
  // Target profile
  // ---------------------------------------------------------------------------
  const PROFILE_FLAGS = ["pool", "hot_tub", "game_room", "waterfront", "pickleball", "mini_golf", "sauna", "playground", "pool_heater", "fire_pit"];
  const AMENITY_ORDER = ["hot_tub", "game_room", "waterfront", "pickleball", "mini_golf", "sauna", "playground", "pool_heater", "fire_pit"];
  const MATCH_ONLY = ["pool_heater", "fire_pit"];  // help matching; never copied into the sheet
  const PROFILE_LABEL = Object.assign({}, FLAG_LABEL, { pool_heater: "Pool heater", fire_pit: "Fire pit" });
  // A setup line item (col E) means the amenity is being added. Only the item's own words
  // count, not its "(...)" asides or a trailing " - ..." remark: "Hot Tub (beside the pool)" is a
  // hot tub, not a pool; "PickleBall Court (with hoops), Mini Golf, ..." is pickleball and mini golf.
  const SETUP_RULES = [
    ["pool", /\b(?:in-?ground\s+|plunge\s+|new\s+)?pool\b(?!\s*(?:table|heater|maint|clean|service|spill))/i],
    ["hot_tub", /hot\s*tub|spill-?over|\bspa\b|jacuzzi/i],
    ["game_room", /game\s*room|gameroom|arcade|air\s*hockey|foosball/i],
    ["mini_golf", /mini\s*golf|putting\s*green/i],
    ["pickleball", /pickle\s*ball/i],
    ["pool_heater", /pool\s*heater|heated\s*pool/i],
    ["fire_pit", /fire\s*pit/i],
    ["playground", /play\s*ground|swing\s*set|play\s*set/i],
    ["sauna", /sauna/i],
    ["waterfront", /\bdock\b|boat\s*slip/i],
  ];
  // The notes mean the house already has it ("comes with pool, hot tub", "pool ... installed", "waterfront", "on the pond").
  const HAVE = "(?:comes with|existing|already has|already|includes|private|heated|has an?|has)";
  const noteRule = (word) => new RegExp("\\b" + HAVE + "\\b[^.\\n;]{0,30}?(" + word + ")|(" + word + ")[^.\\n;]{0,30}?\\b(?:installed|set ?up|already)\\b", "i");
  const NOTE_RULES = [
    ["pool", noteRule("\\bpool\\b(?!\\s*table)")],
    ["hot_tub", noteRule("hot\\s*tub|\\bspa\\b|jacuzzi")],
    ["game_room", noteRule("game\\s*room|arcade")],
    ["mini_golf", noteRule("mini\\s*golf")],
    ["pickleball", noteRule("pickle\\s*ball")],
    ["sauna", noteRule("sauna")],
    ["playground", noteRule("play\\s*ground")],
    ["fire_pit", noteRule("fire\\s*pit")],
    ["pool_heater", /heated pool|pool heater/i],
    ["waterfront", /waterfront|lake ?front|pond ?front|creek ?front|on the (?:lake|pond|creek)|\bdock\b/i],
  ];
  const money0 = (v) => (v == null || isNaN(v) ? "" : " $" + Math.round(v).toLocaleString("en-US"));
  /**
   * The target as it will be run, read per scenario. Never sets a flag without a source:
   * setup line items first, then the notes; else 0. (No location rule sets waterfront here:
   * Millersburg has no water class, and only 6 of 62 homes are flagged waterfront.)
   * Sleeps, when the notes don't state it, defaults to the median of Cleaned_Data homes with
   * the target's bedroom count, labelled "default: edit".
   */
  function profilePrefill(o) {
    const d = o.details || parseNotes(o.notes || "");
    const flags = {}, src = {};
    PROFILE_FLAGS.forEach((f) => { flags[f] = 0; src[f] = null; });
    (o.setup || []).forEach((it) => {
      const head = String(it.label || "").replace(/\([^()]*\)/g, " ").split(/[()]| - /)[0];
      SETUP_RULES.forEach(([f, re]) => { if (!flags[f] && re.test(head)) { flags[f] = 1; src[f] = "setup: " + String(it.label || "").trim() + money0(it.amount); } });
    });
    const notes = String(o.notes || "");
    NOTE_RULES.forEach(([f, re]) => {
      if (flags[f]) return;
      const m = notes.match(re);
      if (m) { flags[f] = 1; src[f] = "notes: " + m[0].trim().replace(/\s+/g, " ").slice(0, 60); }
    });
    PROFILE_FLAGS.forEach((f) => { if (!flags[f]) src[f] = "nothing mentions it"; });
    const beds = d.targetBeds, baths = d.targetBaths;
    const sleeps = o.sleeps != null ? o.sleeps : o.sleepsMedian ? o.sleepsMedian(beds) : null;
    return { asListed: { beds: d.beds, baths: d.baths }, beds, baths, sleeps, flags,
      src: Object.assign({ beds: d.targetFrom || "—", baths: d.baths != null ? "as listed" : "—", sleeps: o.sleeps != null ? "notes" : sleeps != null ? "default: edit (median sleeps of " + beds + "BR comps)" : "—" }, { flags: src }) };
  }
  /** Overlay manual edits ({beds, baths, sleeps, flags}) on the prefill; edited values say "manual". */
  function profileWith(pre, edit) {
    const out = JSON.parse(JSON.stringify(pre));
    if (!edit) return out;
    ["beds", "baths", "sleeps"].forEach((k) => { if (edit[k] != null) { out[k] = edit[k]; out.src[k] = "manual"; } });
    Object.entries(edit.flags || {}).forEach(([f, v]) => { if (PROFILE_FLAGS.includes(f) && (v === 0 || v === 1)) { out.flags[f] = v; out.src.flags[f] = "manual"; } });
    return out;
  }

  // ---------------------------------------------------------------------------
  // Matching
  // ---------------------------------------------------------------------------
  const flagOf = (l, f) => ((l.flagSet || new Set(l.flags || [])).has(f) ? 1 : 0);
  const bedOk = (lb, tb, pm1) => tb == null || (pm1 ? Math.abs(lb - tb) <= 1 : lb === tb);
  /**
   * Match by location: candidates in the target's zone (Village = inside the Millersburg village
   * limits, or Countryside; a toggle), bedrooms within +/-1 of the target's, ranked by
   * straight-line distance. Amenities play no part. t: {lat, lng, zone, beds}; rules: {zone, radius}.
   */
  function matchLocation(cands, t, rules) {
    const out = [];
    cands.forEach((l) => {
      if (rules.zone && t.zone && (t.zone === "Village") !== !!l.town) return;
      if (!bedOk(l.bedrooms, t.beds, true)) return;
      const d = miles(t.lat, t.lng, l.lat, l.lng);
      if (rules.radius != null && d > rules.radius) return;
      out.push({ l, d });
    });
    return out.sort((a, b) => a.d - b.d || b.l.revenue - a.l.revenue);
  }
  /** How a comp's flags line up with the profile (for chips and the amenity ranking). */
  function amenityInfo(l, prof, prefs) {
    const state = {}, pref = AMENITY_ORDER.filter((f) => (prefs[f] || "prefer") === "prefer");
    PROFILE_FLAGS.forEach((f) => {
      const c = flagOf(l, f), t = prof.flags[f] ? 1 : 0;
      state[f] = c === t ? (c ? "match" : "none") : c ? "extra" : "missing";
    });
    // "Preferred amenities" = the profile's preferred flags that are 1; matched = the comp has it too.
    const has = pref.filter((f) => prof.flags[f]);
    const vec = has.map((f) => (state[f] === "match" ? 1 : 0));
    return { state, vec, prefTotal: has.length, prefMatched: vec.reduce((a, b) => a + b, 0), extra: pref.filter((f) => state[f] === "extra").length };
  }
  /**
   * Match by amenities: the whole market, ranked best to worst. Nothing the profile says is
   * used to exclude a home; the priorities are applied in strict order as sort keys (never one
   * blended score):
   *  1 bedrooms: exact first (or +/-1 counts as a match), then the closer the better;
   *  2 sleeps: within the window counts as a match, then the closer the better;
   *  3 pool: the same as the profile's first;
   *  4 the other flags: "must" (the comp's flag equals the profile's) ranks ahead of "prefer",
   *    which ranks by how many of the profile's preferred amenities the comp has (earlier flags
   *    break ties first); "ignore" plays no part;
   *  then the smaller sleeps difference, then revenue high to low.
   * rules: {bedsExact, sleepsWindow, prefs: {flag: must|prefer|ignore}, pool: null | 0 | 1}
   */
  function matchAmenity(cands, prof, rules) {
    const pool = rules.pool == null ? (prof.flags.pool ? 1 : 0) : rules.pool;
    const tolB = rules.bedsExact ? 0 : 1, win = rules.sleepsWindow == null ? Infinity : rules.sleepsWindow;
    const must = AMENITY_ORDER.filter((f) => rules.prefs[f] === "must");
    const lex = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return b[i] - a[i]; return 0; };
    return cands.map((l) => {
      const bedsDiff = prof.beds == null ? 0 : Math.abs(l.bedrooms - prof.beds);
      const sleepsDiff = prof.sleeps == null ? 0 : Math.abs(l.sleeps - prof.sleeps);
      return { l, info: amenityInfo(l, prof, rules.prefs), bedsDiff, bedsTier: Math.max(0, bedsDiff - tolB), sleepsDiff,
        sleepsTier: win === Infinity ? 0 : Math.max(0, sleepsDiff - win), poolOk: flagOf(l, "pool") === pool,
        mustMiss: must.filter((f) => flagOf(l, f) !== (prof.flags[f] ? 1 : 0)).length };
    }).sort((a, b) => a.bedsTier - b.bedsTier || a.sleepsTier - b.sleepsTier || (a.poolOk ? 0 : 1) - (b.poolOk ? 0 : 1) || a.mustMiss - b.mustMiss ||
      b.info.prefMatched - a.info.prefMatched || lex(a.info.vec, b.info.vec) || a.sleepsDiff - b.sleepsDiff || b.l.revenue - a.l.revenue || b.l.adr - a.l.adr);
  }

  /** Analyst Notes -> as-listed bed / bath, lot, size, "why" bullets, and the target bedrooms after conversion. */
  function parseNotes(text) {
    const t = text || "";
    const grab = (re) => { const m = t.match(re); return m ? m[1].trim() : null; };
    const bb = grab(/Bed\s*\/\s*Bath\s*\(projected\)\s*:\s*([^\n]*)/i), lot = grab(/Lot Size\s*\(sqft\)\s*:\s*([^\n]*)/i), size = grab(/Prop Size\s*\(sqft\)\s*:\s*([^\n]*)/i);
    const out = { bedBathText: bb, lotText: lot, sizeText: size, beds: null, baths: null, lot: null, size: null, targetBeds: null, targetBaths: null, targetFrom: null };
    const m = bb && bb.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*(.*)$/);
    if (m) { out.beds = +m[1]; out.baths = +m[2]; out.bedBathComment = m[3].trim() || null; }
    // "(I want 5)", "(5 BR with garage to bunk conversion)", "(4 BR ...)": the converted count is the target.
    const cm = out.bedBathComment || "";
    const w = cm.match(/\bwant\s+(\d+)/i) || cm.match(/(\d+)\s*(?:BR|bed(?:room)?s?)\b/i);
    out.targetBeds = w ? +w[1] : out.beds;
    out.targetFrom = w ? "notes: " + cm.replace(/^\(|\)$/g, "") : out.beds != null ? "as listed" : null;
    out.targetBaths = out.baths;
    [["lot", lot], ["size", size]].forEach(([k, s]) => { const n = (s || "").match(/^([\d,]+(?:\.\d+)?)\s*(.*)$/); if (n) { out[k] = +n[1].replace(/,/g, ""); out[k + "Comment"] = n[2].replace(/^[\s,]+|[\s,]+$/g, "") || null; } });
    const why = t.includes("Why This Property?") ? t.split("Why This Property?")[1] : "";
    out.why = why.split("\n").map((s) => s.trim()).filter((s) => s.startsWith("--")).map((s) => s.slice(2).replace(/^[\s,]+|[\s,]+$/g, "")).filter(Boolean);
    return out;
  }

  return { SHEET_FLAGS, FLAG_LABEL, CLASSES, TAG, roomId, isZillow, valueChanges, classify, canPick, miles, autoNote, retag, rowFromListing, addToSet, appendDistance, parseNotes,
    PROFILE_FLAGS, AMENITY_ORDER, MATCH_ONLY, PROFILE_LABEL, profilePrefill, profileWith, amenityInfo, matchLocation, matchAmenity, flagOf };
});
