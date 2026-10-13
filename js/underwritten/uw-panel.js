/**
 * Map side panel. Acquisition targets are the Zillow houses being bought;
 * Airbnb comps are only workbook (Cleaned_Data) entire homes.
 *   Targets: every target, underwritten and new, with its Zillow link, price,
 *     low-case cash on cash, comp-error badge and a "no pin" tag.
 *   Airbnb comps: the selected target's header (Zillow link, key numbers) and
 *     two separate ways to find comps: Match by location (distance within the
 *     same zone, Village or Countryside, bedrooms +/-1) and Match by amenities
 *     (the whole market ranked best to worst, nothing excluded, strict
 *     priority from the target profile). Each mode keeps
 *     its own rules and extra filters (removable chips). Rows can be ticked,
 *     copied as sheet rows (always revenue high -> low) or added to the comp set.
 *   Filters (the current mode's extra filters) / Map layers.
 */
/* global UWRules */
(function () {
  const UW = window.UW, F = UW.fmt, E = UW.esc;
  const P = (UW.panelApi = {});
  const CAP = 50;
  let root, editingNote = null;

  UW.addComp = (pid, label, l) => UW.actions.addComps(pid, label, [l]) > 0;

  // Re-render a host (after any click in flight) and put keyboard focus back on the same control.
  function render(host, html) { UW.afterPointer(() => renderNow(host, html)); }
  function renderNow(host, html) {
    const a = document.activeElement, key = a && host.contains(a) ? a.getAttribute("data-focus") : null;
    const top = host.scrollTop;
    host.innerHTML = html;
    host.scrollTop = top;
    if (key) { const n = host.querySelector('[data-focus="' + CSS.escape(key) + '"]'); if (n) n.focus(); }
  }
  P.render = render;

  P.init = function () {
    root = document.getElementById("uw-panel");
    const tab = (id, label, extra) => '<button type="button" role="tab" class="uw-tab" id="uw-t-' + id + '" aria-controls="uw-p-' + id + '" aria-selected="false" tabindex="-1">' + label + (extra || "") + "</button>";
    root.innerHTML = '<div class="uw-tabs" role="tablist" aria-label="Map panel">' + tab("targets", "Targets") + tab("comps", "Airbnb comps") +
      tab("filters", "Filters", ' <span class="uw-tab__n" id="uw-filter-n"></span>') + tab("layers", "Layers") + "</div>" +
      ["targets", "comps", "filters", "layers"].map((id) => '<div class="uw-tabpanel" role="tabpanel" id="uw-p-' + id + '" aria-labelledby="uw-t-' + id + '" hidden></div>').join("");
    const tabs = [...root.querySelectorAll(".uw-tab")];
    const show = (t) => tabs.forEach((x) => { const on = x === t; x.setAttribute("aria-selected", on); x.tabIndex = on ? 0 : -1; document.getElementById(x.getAttribute("aria-controls")).hidden = !on; });
    P.showTab = (id) => show(document.getElementById("uw-t-" + id));
    tabs.forEach((t, i) => {
      t.addEventListener("click", () => show(t));
      t.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        const n = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
        show(n); n.focus();
      });
    });
    root.addEventListener("click", onClick);
    root.addEventListener("change", onChange);
    root.addEventListener("input", onInput);
    P.showTab(UW.ui.selected ? "comps" : "targets");
    P.renderAll();
  };
  P.renderAll = function () { renderTargets(); renderComps(); renderFilters(); renderLayers(); };

  // ---------------------------------------------------------------------------
  // Shared bits
  // ---------------------------------------------------------------------------
  const zillow = (p, cls) => (p.url ? '<a class="uw-zl' + (cls ? " " + cls : "") + '" href="' + E(p.url) + '" target="_blank" rel="noopener" aria-label="Open the Zillow listing for ' + E(p.street) + ' (new tab)">Zillow ↗</a>' : "");
  UW.zillowLink = zillow;
  UW.errorBadge = (v) => { const n = UW.compErrors(v).length; return n ? '<span class="uw-badge uw-badge--err" title="Rows in the comp table that are not Cleaned_Data entire homes">' + n + " comp error" + (n === 1 ? "" : "s") + "</span>" : ""; };
  UW.targetBadges = function (p, v) {
    const rev = v.inputs.revenue || {}, price = v.inputs.price, low = v.outputs.cases.low.coc;
    const ratio = price && UW.isNum(rev.mid) ? rev.mid / price : null, st = UW.cocStatus(low);
    return UW.errorBadge(v) +
      (ratio == null ? '<span class="uw-badge uw-badge--none">Mid revenue not set</span>' : '<span class="uw-badge uw-badge--' + (ratio >= UW.SCREEN ? "good" : "warn") + '">' + (ratio >= UW.SCREEN ? "✓ " : "") + F.pct(ratio, 1) + " of price · 20% screen</span>") +
      (UW.isNum(low) ? '<span class="uw-badge uw-badge--' + st + '">' + (st === "good" ? "✓ " : "") + "Low case " + F.pct(low) + " vs 4%</span>" : "");
  };

  // ---------------------------------------------------------------------------
  // Targets
  // ---------------------------------------------------------------------------
  function renderTargets() {
    const host = document.getElementById("uw-p-targets");
    const all = UW.properties();
    const row = (p) => {
      const v = UW.activeVersion(p), low = v.outputs.cases.low.coc;
      return '<li class="uw-trow' + (p.id === UW.ui.selected ? " is-sel" : "") + '">' +
        '<button type="button" class="uw-trow__main" data-act="select" data-pid="' + E(p.id) + '" data-focus="t-' + E(p.id) + '"><span class="uw-dot" style="background:' + UW.COC_COLORS[UW.cocStatus(low)] + '"></span>' +
        '<span class="uw-trow__name">' + E(p.street) + "</span>" +
        '<span class="uw-trow__meta">' + F.money(v.inputs.price) + " · low case " + F.pct(low) + (p.versions.length > 1 ? " · " + E(UW.scenarioName(v)) : "") + (p.place ? " · " + E(p.place.areaName) : "") + "</span></button>" +
        '<span class="uw-trow__side">' + UW.errorBadge(v) + (p.geo ? "" : '<span class="uw-tag uw-tag--nopin">no pin</span>') + zillow(p) + "</span></li>";
    };
    const uw = all.filter((p) => p.kind !== "new"), nl = all.filter((p) => p.kind === "new");
    render(host, '<p class="uw-panel__intro">Acquisition targets: the houses being underwritten. Pick one to rank its nearest Airbnb comps.</p>' +
      '<p class="uw-tgroup">Underwritten <span class="uw-count">' + uw.length + '</span></p><ul class="uw-tlist">' + uw.map(row).join("") + "</ul>" +
      '<p class="uw-tgroup">New listings <span class="uw-count">' + nl.length + '</span></p>' + (nl.length ? '<ul class="uw-tlist">' + nl.map(row).join("") + "</ul>" :
        '<p class="uw-empty">None yet. <button type="button" class="uw-linkbtn" data-act="add-listing">Add a Zillow listing</button></p>'));
  }

  // ---------------------------------------------------------------------------
  // Airbnb comps
  // ---------------------------------------------------------------------------
  function chips() {
    const f = UW.ui.filters, out = [];
    const chip = (key, text, val) => out.push('<span class="uw-fchip">' + E(text) + '<button type="button" data-act="unchip" data-k="' + key + '"' + (val != null ? ' data-v="' + E(val) + '"' : "") + ' aria-label="Remove filter: ' + E(text) + '">×</button></span>');
    if (f.minRev != null) chip("minRev", "Revenue ≥ " + F.k(f.minRev));
    if (f.maxRev != null) chip("maxRev", "Revenue ≤ " + F.k(f.maxRev));
    if (f.beds.length) { const b = f.beds.slice().sort((a, c) => a - c), lab = (x) => (x === 1 ? "Studio–1" : x === 7 ? "7+" : String(x)); chip("beds", (b.length > 1 && b[b.length - 1] - b[0] === b.length - 1 ? lab(b[0]) + "–" + lab(b[b.length - 1]) : b.map(lab).join(", ")) + " BR"); }
    if (f.minSleeps != null) chip("minSleeps", "Sleeps ≥ " + f.minSleeps);
    if (f.minBaths != null) chip("minBaths", "Baths ≥ " + f.minBaths);
    Object.entries(f.am).forEach(([k, v]) => { if (v) chip("am", (UW.AMEN_LABEL[k] || k) + ": " + (v === 1 ? "must have" : "exclude"), k); });
    if (f.zone) chip("zone", f.zone);
    if (f.loc.length) chip("loc", f.loc.join(" or "));
    if (f.area.length) chip("area", f.area.map((a) => UW.areaById[a].name).join(", "));
    if (f.sizeTop.length) chip("sizeTop", f.sizeTop.map((x) => UW.TIER_LABEL[x]).join(", "));
    if (f.quality.length) chip("quality", "Data: " + f.quality.join(", "));
    if (f.fav) chip("fav", "Guest favourite: " + f.fav);
    return out.join("");
  }

  function shownListings(p) {
    if (UW.ui.compsView === "nearest" && p) {
      const res = UW.results(p);
      return UW.ui.sort === "revenue" ? res.slice().sort((a, b) => b.l.revenue - a.l.revenue || b.l.adr - a.l.adr) : res;
    }
    const all = UW.listings.filter((l) => UW.matchSet.has(l.id)).sort((a, b) => b.revenue - a.revenue || b.adr - a.adr);
    return all.slice(0, CAP).map((l, i) => ({ l, d: p && p.geo ? UW.geoMiles(p.geo, l) : null, rank: i + 1, info: p ? UWRules.amenityInfo(l, UW.activeVersion(p).profile, UW.ui.amRules.prefs) : null }));
  }
  P.shownListings = () => shownListings(UW.ui.selected ? UW.property(UW.ui.selected) : null).map((x) => x.l);

  const flagName = (f) => UWRules.PROFILE_LABEL[f] || f;
  // A chip per flag: green = both have it, red = the comp has it and the target doesn't, grey = the target has it and the comp doesn't.
  function flagChips(info, all) {
    if (!info) return "";
    return '<span class="uw-mchips">' + UWRules.PROFILE_FLAGS.filter((f) => all || info.state[f] !== "none").map((f) => {
      const s = info.state[f];
      const cls = s === "match" ? "ok" : s === "extra" ? "extra" : s === "missing" ? "miss" : "none";
      const t = s === "match" ? "both have " : s === "extra" ? "comp has, target doesn’t: " : s === "missing" ? "target has, comp doesn’t: " : "neither: ";
      return '<span class="uw-mchip uw-mchip--' + cls + '" title="' + E(t + flagName(f)) + '">' + E(flagName(f).toLowerCase()) + "</span>";
    }).join("") + "</span>";
  }
  const prefLabel = (info) => (info && info.prefTotal ? info.prefMatched + " of " + info.prefTotal + " preferred amenities" : "no preferred amenities in the profile");

  function modeHtml(p, v) {
    const prof = v.profile, R = UW.ui.amRules, L = UW.ui.locRules, f = UW.ui.filters, mode = UW.ui.mode;
    const btn = (m, t) => '<button type="button" data-act="mode" data-v="' + m + '" aria-pressed="' + (mode === m && !UW.ui.pure) + '" data-focus="md-' + m + '">' + t + "</button>";
    const bar = '<div class="uw-seg uw-seg--wide uw-modebar" role="group" aria-label="How to find comps">' + btn("location", "Match by location") + btn("amenity", "Match by amenities") + "</div>";
    const pf = Object.entries(prof.flags).filter(([, x]) => x).map(([k]) => flagName(k).toLowerCase());
    const profile = '<p class="uw-profline"><span class="uw-flabel">Target profile' + (p.versions.length > 1 ? " · " + E(UW.scenarioName(v)) : "") + "</span> " +
      F.num(prof.beds) + " bd / " + F.num(prof.baths) + " ba / sleeps " + (prof.sleeps == null ? "—" : prof.sleeps) + (/^default/.test(prof.src.sleeps) ? ' <span class="uw-tag uw-tag--possibly">default: edit</span>' : "") +
      " · " + (pf.length ? E(pf.join(", ")) : "no amenities") + ' <button type="button" class="uw-linkbtn" data-act="card-profile" data-focus="cprof">edit profile</button></p>';
    const rev = '<label>Revenue ≥ <span class="uw-money-in"><span>$</span><input type="number" min="0" step="5000" value="' + (f.minRev == null ? "" : f.minRev) + '" placeholder="off" data-k="minRev" data-focus="minRev2" inputmode="numeric"></span></label>';
    const n = '<label>' + (mode === "amenity" && !UW.ui.pure ? "Show the best" : "Nearest") + ' <input type="number" min="1" max="' + (mode === "amenity" ? UW.listings.length : 50) + '" step="1" value="' + UW.ui.n + '" data-k="n" data-focus="n" inputmode="numeric"></label>';
    let rules;
    if (UW.ui.pure) {
      rules = '<div class="uw-rules uw-rules--pure"><p><strong>Pure nearest:</strong> straight-line distance only. No zone, bedroom, amenity, revenue or other filters; still only Cleaned_Data entire homes.</p>' +
        '<div class="uw-sel__ctl">' + n + '<label>within <input type="number" min="0.1" step="0.5" value="' + (UW.ui.radius == null ? "" : UW.ui.radius) + '" placeholder="any" data-k="radius" data-focus="radius" inputmode="decimal"> mi</label></div>' +
        '<button type="button" class="uw-linkbtn" data-act="unpure" data-focus="unpure">Back to Match by location</button></div>';
    } else if (mode === "location") {
      rules = '<div class="uw-rules"><div class="uw-rules__row"><label class="uw-check uw-check--inline"><input type="checkbox" data-rule="zone"' + (L.zone ? " checked" : "") + ' data-focus="rz"> Same zone <span class="muted">(' +
        E(p.place ? (p.place.zone === "Village" ? "in the village limits" : "countryside, outside the village limits") : "no pin") + ")</span></label></div>" +
        '<p class="uw-rules__fixed">Bedrooms <strong>' + (prof.beds == null ? "any" : Math.max(0, prof.beds - 1) + "–" + (prof.beds + 1)) + "</strong> (target " + F.num(prof.beds) + " ±1) · ranked by distance; amenities don’t change the ranking.</p>" +
        '<div class="uw-sel__ctl">' + rev + n + '<label>within <input type="number" min="0.1" step="0.5" value="' + (UW.ui.radius == null ? "" : UW.ui.radius) + '" placeholder="any" data-k="radius" data-focus="radius" inputmode="decimal"> mi</label></div>' +
        '<button type="button" class="uw-linkbtn" data-act="pure" data-focus="pure">Show pure nearest</button></div>';
    } else {
      const poolV = R.pool == null ? (prof.flags.pool ? 1 : 0) : R.pool;
      const prio = UWRules.AMENITY_ORDER.map((fl, i) => '<div class="uw-prio__row"><span class="uw-prio__n">' + (i + 1) + '</span><span class="uw-prio__l">' + E(flagName(fl)) +
        ' <span class="uw-flag uw-flag--' + (prof.flags[fl] ? 1 : 0) + '" title="Target profile">' + (prof.flags[fl] ? 1 : 0) + "</span></span>" +
        '<span class="uw-seg uw-seg--sm" role="group" aria-label="' + E(flagName(fl)) + '">' + [["must", "Must match"], ["prefer", "Prefer"], ["ignore", "Ignore"]].map(([k, t]) =>
          '<button type="button" data-act="prio" data-f="' + fl + '" data-v="' + k + '" aria-pressed="' + ((R.prefs[fl] || "prefer") === k) + '" data-focus="pr-' + fl + k + '">' + t + "</button>").join("") + "</span></div>").join("");
      rules = '<div class="uw-rules"><p class="uw-rules__fixed">The whole market, <strong>best to worst</strong>; nothing is excluded. Ranked in strict order: <strong>1</strong> bedrooms, <strong>2</strong> sleeps, <strong>3</strong> pool, <strong>4</strong> the other amenities, then revenue. Never one blended score.</p>' +
        '<div class="uw-rules__row"><span class="uw-flabel">1 Bedrooms</span><span class="uw-seg uw-seg--sm" role="group" aria-label="Bedrooms">' +
        '<button type="button" data-act="beds" data-v="1" aria-pressed="' + R.bedsExact + '" data-focus="be1">' + F.num(prof.beds) + " first</button>" +
        '<button type="button" data-act="beds" data-v="0" aria-pressed="' + !R.bedsExact + '" data-focus="be0">' + F.num(prof.beds) + " ±1 counts</button></span></div>" +
        '<div class="uw-rules__row"><span class="uw-flabel">2 Sleeps</span><span>' + (prof.sleeps == null ? "target not set" : "target " + prof.sleeps + " ±") +
        ' <input type="number" min="0" step="1" value="' + (R.sleepsWindow == null ? "" : R.sleepsWindow) + '" placeholder="any" data-k="sleepsWindow" data-focus="sw" inputmode="numeric" aria-label="Sleeps window"> counts, then closest</span></div>' +
        '<div class="uw-rules__row"><span class="uw-flabel">3 Pool</span><span><span class="uw-flag uw-flag--' + poolV + '">' + poolV + "</span> first " +
        (R.pool == null ? '<span class="muted">(the profile’s)</span>' : '<span class="muted">(set by “Find no-pool comps”)</span> <button type="button" class="uw-linkbtn" data-act="pool-reset">use the profile’s</button>') + "</span></div>" +
        '<details class="uw-prio"' + (UW._prioOpen ? " open" : "") + '><summary>4 Other amenities: Must match / Prefer / Ignore</summary>' + prio +
        '<p class="uw-hint">“Must match” ranks homes whose flag equals the profile’s ahead of the rest (it doesn’t exclude). “Prefer” ranks by how many of the profile’s preferred amenities the home has, earlier flags breaking ties first. Then the smaller sleeps difference, then revenue.</p></details>' +
        '<div class="uw-sel__ctl">' + rev + n + "</div></div>";
    }
    return bar + profile + rules;
  }

  function renderComps() {
    const host = document.getElementById("uw-p-comps");
    const p = UW.ui.selected ? UW.property(UW.ui.selected) : null;
    if (!p && UW.ui.compsView === "nearest") UW.ui.compsView = "filtered";
    let head = "";
    const v = p && UW.activeVersion(p);
    if (p) {
      const o = v.outputs, t = v.profile, rev = v.inputs.revenue || {};
      const all = UW.properties(), idx = all.findIndex((x) => x.id === p.id);
      head = '<div class="uw-sel"><div class="uw-sel__top"><div class="uw-sel__id"><p class="uw-sel__kicker">Acquisition target' + (p.versions.length > 1 ? " · " + E(UW.scenarioName(v)) : "") + (p.kind !== "underwritten" ? " · new listing" : "") + "</p>" +
        '<h3 class="uw-sel__name">' + E(p.street) + "</h3>" + zillow(p, "uw-zl--big") + "</div>" +
        '<button type="button" class="uw-btn uw-btn--icon" data-act="clear" aria-label="Clear the selection" data-focus="clear">×</button></div>' +
        '<p class="uw-sel__meta"><strong>' + F.money(v.inputs.price) + "</strong> · target " + F.num(t.beds) + " bd / " + F.num(t.baths) + " ba" + (t.sleeps ? " / sleeps " + t.sleeps : "") +
        (p.place ? " · " + E(p.place.areaName) + " · " + E(p.place.loc) : " · no map pin yet") + "</p>" +
        '<p class="uw-sel__kpi"><span>Revenue <b>' + ["low", "mid", "high"].map((c) => F.k(rev[c])).join(" · ") + "</b></span><span>Cash on cash <b>" +
        ["low", "mid", "high"].map((c) => '<span class="uw-coc--' + UW.cocStatus(o.cases[c].coc) + '">' + F.pct(o.cases[c].coc) + "</span>").join(" · ") + "</b></span></p>" +
        '<div class="uw-head__badges">' + UW.targetBadges(p, v) + "</div>" +
        '<div class="uw-switch"><button type="button" class="uw-btn uw-btn--icon" data-act="step" data-v="-1" aria-label="Previous target" data-focus="sw-prev">‹</button>' +
        '<select data-k="switch" aria-label="Go to another target" data-focus="sw-sel">' + all.map((x) => '<option value="' + E(x.id) + '"' + (x.id === p.id ? " selected" : "") + ">" + E(x.street) + (x.kind === "new" ? " (new listing)" : "") + "</option>").join("") + "</select>" +
        '<button type="button" class="uw-btn uw-btn--icon" data-act="step" data-v="1" aria-label="Next target" data-focus="sw-next">›</button><span class="uw-switch__n">' + (idx + 1) + " of " + all.length + "</span></div>" +
        '<div class="uw-btnrow"><button type="button" class="uw-btn uw-btn--small uw-btn--ghost" data-act="card" data-focus="card">Open its card ↓</button>' +
        '<button type="button" class="uw-btn uw-btn--small uw-btn--ghost" data-act="copy-comps" data-focus="cc">Copy its comp set</button></div></div>' + modeHtml(p, v);
    } else {
      head = '<p class="uw-panel__intro">No target selected. Pick one in <button type="button" class="uw-linkbtn" data-act="tab-targets">Targets</button> to match comps to it by location or by amenities, or copy from every Airbnb comp that passes the filters.</p>';
    }
    const ch = chips();
    const extra = '<div class="uw-fchips"><span class="uw-fchips__l">' + (UW.ui.pure ? "Filters (not applied to pure nearest):" : "Extra filters" + (p ? " · " + (UW.ui.mode === "amenity" ? "amenity" : "location") + " mode" : "") + ":") + "</span>" +
      (ch || '<span class="muted">none</span>') + ' <button type="button" class="uw-linkbtn" data-act="tab-filters">add</button></div>';
    const resLabel = UW.ui.pure ? "Pure nearest" : UW.ui.mode === "amenity" ? "Amenity matches" : "Location matches";
    const view = '<div class="uw-seg uw-seg--wide" role="group" aria-label="Which comps">' +
      '<button type="button" data-act="view" data-v="nearest" aria-pressed="' + (UW.ui.compsView === "nearest") + '"' + (p ? "" : " disabled") + ' data-focus="vn">' + resLabel + "</button>" +
      '<button type="button" data-act="view" data-v="filtered" aria-pressed="' + (UW.ui.compsView === "filtered") + '" data-focus="vf">All filtered · ' + UW.matchSet.size + "</button></div>";
    const rows = shownListings(p);
    const inSet = new Set(v ? v.comps.map((c) => UW.compId(c)).filter(Boolean) : []);
    const picked = [...UW.ui.picked].filter((id) => UW.byId.has(id));
    const filtered = UW.ui.compsView === "filtered";
    const tools = '<div class="uw-picktools"><button type="button" class="uw-btn uw-btn--small uw-btn--ghost" data-act="pickall" data-focus="pa">Select all shown</button>' +
      '<button type="button" class="uw-btn uw-btn--small uw-btn--ghost" data-act="pickclear"' + (picked.length ? "" : " disabled") + ' data-focus="pc">Clear</button>' +
      '<span class="uw-picktools__n" id="uw-pick-n">' + picked.length + " selected</span>" +
      '<button type="button" class="uw-btn uw-btn--small uw-btn--primary" data-act="copypicked"' + (picked.length ? "" : " disabled") + ' data-focus="cp">Copy selected</button>' +
      (p ? '<button type="button" class="uw-btn uw-btn--small" data-act="addpicked"' + (picked.length ? "" : " disabled") + ' data-focus="ap">Add selected to comp set</button>' : "") +
      (filtered ? '<button type="button" class="uw-btn uw-btn--small uw-btn--ghost" data-act="copyall"' + (rows.length ? "" : " disabled") + ' data-focus="ca">Copy all filtered (' + rows.length + ")</button>" : "") + "</div>" +
      '<p class="uw-hint">Copies are the sheet’s 15 columns, tab-separated, no header, always revenue high to low. Notes come from the workbook' + (p ? ", tagged with the mode and the distance to " + E(p.street) : "") + "; edit one with ✎ (kept for this session)." +
      (filtered ? " " + (UW.matchSet.size > CAP ? "Showing the top " + CAP + " of " + UW.matchSet.size + " by revenue; “Copy all filtered” is capped at " + CAP + " rows." : "Showing all " + UW.matchSet.size + ", highest revenue first.") : "") + "</p>" +
      (!filtered && p ? '<div class="uw-seg" role="group" aria-label="Order the list"><button type="button" data-act="sort" data-v="distance" aria-pressed="' + (UW.ui.sort !== "revenue") + '" data-focus="sd">' + (UW.ui.mode === "amenity" && !UW.ui.pure ? "Best match first" : "Nearest first") + "</button>" +
        '<button type="button" data-act="sort" data-v="revenue" aria-pressed="' + (UW.ui.sort === "revenue") + '" data-focus="sr">Highest revenue first</button></div>' : "");
    const noPin = p && !p.geo && !filtered && UW.ui.mode !== "amenity" ? '<p class="uw-empty">This target has no map pin, so matching by location can’t measure distance yet. Place it on the map, or match by amenities.</p>' : "";
    const more = p && !filtered && UW.ui.mode === "amenity" && !UW.ui.pure && rows.length >= UW.ui.n && UW.ui.n < UW.matchSet.size ?
      '<p class="uw-more"><button type="button" class="uw-btn uw-btn--small uw-btn--ghost" data-act="more">Show 50 more</button> <span class="muted">showing the best ' + rows.length + " of " + UW.matchSet.size + ", best to worst</span></p>" : "";
    const body = !rows.length ? (noPin || '<p class="uw-empty">No Airbnb comp passes these rules and filters. Remove a chip, widen a rule, or try the other mode.</p>') :
      '<ol class="uw-near-list">' + rows.map((x) => nearRow(x, p, inSet.has(x.l.id), v && v.comps.length >= 15)).join("") + "</ol>" + more;
    render(host, head + extra + view + tools + body);
  }

  // A row added from the other mode can be tagged "Location + Amenity" by adding it again from this one.
  function canRetag(p, l) {
    const c = UW.activeVersion(p).comps.find((r) => UW.compId(r) === l.id), mode = UW.ui.pure ? "location" : UW.ui.mode;
    return c && ((c.match === "location" && mode === "amenity") || (c.match === "amenity" && mode === "location"));
  }
  function nearRow(x, p, inSet, full) {
    const l = x.l, a = UW.areaById[l.area], picked = UW.ui.picked.has(l.id);
    const note = UW.noteFor(l, p);
    const am = p && UW.ui.mode === "amenity" && !UW.ui.pure && UW.ui.compsView === "nearest";
    const noteHtml = editingNote === l.id ?
      '<span class="uw-note uw-note--edit"><input type="text" value="' + E(note) + '" data-note="' + l.id + '" aria-label="Note for ' + E(l.title) + '" data-focus="ne' + l.id + '">' +
      '<button type="button" class="uw-linkbtn" data-act="note-done" data-id="' + l.id + '">done</button><button type="button" class="uw-linkbtn" data-act="note-reset" data-id="' + l.id + '">reset</button></span>' :
      '<span class="uw-note"><span class="uw-note__t">' + E(note) + "</span>" + (UW.noteEdited(l, p) ? '<span class="uw-tag uw-tag--edit">edited</span>' : "") +
      '<button type="button" class="uw-linkbtn" data-act="note-edit" data-id="' + l.id + '" aria-label="Edit the note for ' + E(l.title) + '" data-focus="nb' + l.id + '">✎</button></span>';
    const prof = p ? UW.activeVersion(p).profile : null;
    const breakdown = am ? '<p class="uw-mbreak"><span class="uw-mb uw-mb--' + (x.bedsTier ? "no" : "ok") + '">beds ' + (x.bedsTier ? "✗ " + F.num(l.bedrooms) : x.bedsDiff ? "≈ " + F.num(l.bedrooms) : "✓") + "</span>" +
      '<span class="uw-mb' + (prof.sleeps == null ? "" : x.sleepsTier ? " uw-mb--no" : " uw-mb--ok") + '">sleeps ' + (prof.sleeps == null ? F.num(l.sleeps) : (l.sleeps - prof.sleeps >= 0 ? "+" : "−") + Math.abs(l.sleeps - prof.sleeps)) + "</span>" +
      '<span class="uw-mb uw-mb--' + (x.poolOk ? "ok" : "no") + '">pool ' + (x.poolOk ? "✓" : "✗") + '</span><span class="uw-mb uw-mb--lab">' + E(prefLabel(x.info)) + "</span></p>" + flagChips(x.info) :
      p && x.info ? '<p class="uw-mbreak uw-mbreak--info"><span class="uw-mb uw-mb--lab" title="Information only: amenities don’t change the location ranking">amenities: ' + E(prefLabel(x.info)) + "</span></p>" + flagChips(x.info) : "";
    return '<li class="uw-near' + (inSet ? " is-in" : "") + (picked ? " is-picked" : "") + (am ? " uw-near--am" : "") + '">' +
      '<span class="uw-near__pick"><input type="checkbox" data-pick="' + l.id + '"' + (picked ? " checked" : "") + ' aria-label="Select ' + E(l.title) + '" data-focus="pk' + l.id + '">' +
      '<button type="button" class="uw-near__rank' + (am ? " uw-near__rank--am" : "") + '" data-act="open" data-id="' + l.id + '" aria-label="Show listing ' + x.rank + ' on the map" data-focus="o' + l.id + '">' + x.rank + "</button></span>" +
      '<div class="uw-near__main"><a class="uw-near__title" href="' + E(l.url) + '" target="_blank" rel="noopener">' + E(l.title) + "</a>" +
      '<p class="uw-near__meta"><strong>' + F.money(l.revenue) + "</strong> · " + F.beds(l.bedrooms) + " · " + F.num(l.baths) + " ba · sleeps " + F.num(l.sleeps) +
      " · " + F.money(l.adr) + "/night · " + F.pct(l.occ, 0) + " occupied" + (l.quality === "Possibly Good" ? ' · <span class="uw-tag uw-tag--possibly">possibly good</span>' : "") + "</p>" +
      '<p class="uw-near__meta2">' + (x.d != null ? "<strong>" + F.mi(x.d) + "</strong> · " : "") + E(l.loc) + ' · <span class="region-dot" style="background:' + a.color + '"></span>' + E(a.name) + "</p>" +
      breakdown + noteHtml + "</div>" +
      '<div class="uw-near__act">' + (p ? (inSet ? '<span class="uw-inset" title="In the comp set">✓ In set</span>' + (canRetag(p, l) ? '<button type="button" class="uw-linkbtn" data-act="add" data-id="' + l.id + '" data-focus="a' + l.id + '" title="Found by this mode too: tags it Location + Amenity">add as ' + (UW.ui.mode === "amenity" ? "amenity" : "location") + " match too</button>" : "") +
        '<button type="button" class="uw-linkbtn" data-act="remove" data-id="' + l.id + '" data-focus="r' + l.id + '">remove</button>' :
        '<button type="button" class="uw-btn uw-btn--small' + (full ? '" disabled title="15 rows is the sheet\'s limit"' : '"') + ' data-act="add" data-id="' + l.id + '" data-focus="a' + l.id + '">+ Add</button>') : "") +
      '<button type="button" class="uw-linkbtn" data-act="copyrow" data-id="' + l.id + '" data-focus="cr' + l.id + '">Copy row</button></div></li>';
  }

  // ---------------------------------------------------------------------------
  // Filters
  // ---------------------------------------------------------------------------
  const chip = (group, value, label, on, extra, title) => '<button type="button" class="uw-chip" aria-pressed="' + on + '" data-act="chip" data-g="' + group + '" data-v="' + E(value) + '" data-focus="c-' + group + "-" + E(value) + '"' + (title ? ' title="' + E(title) + '"' : "") + ">" + (extra || "") + E(label) + "</button>";
  function renderFilters() {
    const host = document.getElementById("uw-p-filters");
    const f = UW.ui.filters, C = UW.data.comps;
    const n = UW.countActiveFilters();
    document.getElementById("uw-filter-n").textContent = UW.matchSet.size;
    const p = UW.ui.selected ? UW.property(UW.ui.selected) : null;
    void p;
    const am = UW.AMENITIES.map(([k, lab]) => {
      const v = f.am[k] || 0;
      const seg = [[0, "Any"], [1, "Must have"], [-1, "Exclude"]].map(([val, t]) => '<button type="button" data-act="am" data-k="' + k + '" data-v="' + val + '" aria-pressed="' + (v === val) + '" data-focus="am-' + k + val + '">' + t + "</button>").join("");
      return '<div class="uw-amrow"><span class="uw-amrow__l">' + UW.icon(k) + E(lab) + '</span><span class="uw-seg uw-seg--sm" role="group" aria-label="' + E(lab) + '">' + seg + "</span></div>";
    }).join("");
    const bedOpts = [[1, "Studio–1"], [2, "2"], [3, "3"], [4, "4"], [5, "5"], [6, "6"], [7, "7+"]];
    render(host,
      '<p class="uw-fcount"><strong>' + UW.matchSet.size + "</strong> of " + UW.listings.length + " Airbnb comps pass" + (n ? " · " + n + " filter" + (n === 1 ? "" : "s") + " set" : "") + "</p>" +
      '<p class="uw-fnote">Extra filters for <strong>' + (UW.ui.mode === "amenity" ? "Match by amenities" : "Match by location") + "</strong>" + (p ? " (" + E(p.street) + ")" : "") +
      ". Each mode keeps its own; they narrow the mode’s own rules.</p>" +
      '<div class="uw-fbtns"><button type="button" class="uw-btn uw-btn--small uw-btn--ghost" data-act="reset" data-focus="freset">Reset these filters</button></div>' +
      '<fieldset class="uw-fs"><legend>Revenue potential</legend><div class="uw-row2">' +
      '<label>At least <span class="uw-money-in"><span>$</span><input type="number" min="0" step="5000" value="' + (f.minRev == null ? "" : f.minRev) + '" placeholder="any" data-k="minRev" data-focus="minRev" inputmode="numeric"></span></label>' +
      '<label>At most <span class="uw-money-in"><span>$</span><input type="number" min="0" step="5000" value="' + (f.maxRev == null ? "" : f.maxRev) + '" placeholder="any" data-k="maxRev" data-focus="maxRev" inputmode="numeric"></span></label></div>' +
      '<p class="uw-fnote">Also the highlight threshold for nearest comps.</p></fieldset>' +
      '<fieldset class="uw-fs"><legend>Size</legend><p class="uw-flabel">Bedrooms</p><div class="uw-chips">' + bedOpts.map(([v, t]) => chip("beds", v, t, f.beds.includes(v))).join("") + "</div>" +
      '<div class="uw-row2"><label>Sleeps at least <input type="number" min="1" step="1" value="' + (f.minSleeps == null ? "" : f.minSleeps) + '" placeholder="any" data-k="minSleeps" data-focus="minSleeps" inputmode="numeric"></label>' +
      '<label>Baths at least <input type="number" min="1" step="0.5" value="' + (f.minBaths == null ? "" : f.minBaths) + '" placeholder="any" data-k="minBaths" data-focus="minBaths" inputmode="decimal"></label></div></fieldset>' +
      '<fieldset class="uw-fs"><legend>Amenities</legend>' + am + "</fieldset>" +
      '<fieldset class="uw-fs"><legend>Location</legend><p class="uw-flabel">Setting</p><div class="uw-chips">' + C.locOrder.map((l) => chip("loc", l, l, f.loc.includes(l), '<span class="uw-dot" style="background:' + UW.LOC_COLORS[l] + '"></span>', C.locDef[l])).join("") + "</div>" +
      '<p class="uw-flabel">Village or countryside</p><div class="uw-seg" role="group" aria-label="Village or countryside">' + [["", "Either"], ["Village", "In the village limits"], ["Countryside", "Countryside"]].map(([v, t]) =>
        '<button type="button" data-act="zone" data-v="' + v + '" aria-pressed="' + (f.zone === v) + '" data-focus="z' + v + '">' + t + "</button>").join("") + "</div>" +
      '<p class="uw-flabel">Area</p><div class="uw-chips">' + UW.areas.map((a) => chip("area", a.id, a.name, f.area.includes(a.id), '<span class="uw-dot" style="background:' + a.color + '"></span>')).join("") + "</div></fieldset>" +
      '<fieldset class="uw-fs"><legend>Performance and data</legend><p class="uw-flabel">Against same-size homes</p><div class="uw-chips">' +
      [["top10", "Top 10%"], ["top25", "Top 11–25%"], ["rest", "Below the top 25%"]].map(([v, t]) => chip("sizeTop", v, t, f.sizeTop.includes(v), '<span class="uw-dot" style="background:' + UW.TIER_COLORS[v] + '"></span>')).join("") + "</div>" +
      '<p class="uw-flabel">Data quality</p><div class="uw-chips">' + [["Good", "Good"], ["Possibly Good", "Possibly good"]].map(([v, t]) => chip("quality", v, t, f.quality.includes(v))).join("") + "</div>" +
      '<p class="uw-flabel">Guest favourite</p><div class="uw-seg" role="group" aria-label="Guest favourite">' + [["", "Any"], ["yes", "Yes"], ["no", "No"]].map(([v, t]) =>
        '<button type="button" data-act="fav" data-v="' + v + '" aria-pressed="' + (f.fav === v) + '" data-focus="fv' + v + '">' + t + "</button>").join("") + "</div>" +
      (C.guestFavoriteAny ? "" : '<p class="uw-fnote">No listing in this workbook is flagged as a guest favourite, so “Yes” matches nothing.</p>') + "</fieldset>");
  }

  function renderLayers() {
    const host = document.getElementById("uw-p-layers"), Ly = UW.ui.layers;
    const radio = (v, t, sub) => '<label class="uw-radio"><input type="radio" name="uw-color" value="' + v + '"' + (UW.ui.colorBy === v ? " checked" : "") + ' data-k="colorBy" data-focus="col' + v + '"> <span>' + t + (sub ? "<small>" + sub + "</small>" : "") + "</span></label>";
    const tog = (k, t) => '<label class="uw-check"><input type="checkbox" data-layer="' + k + '"' + (Ly[k] ? " checked" : "") + ' data-focus="ly' + k + '"> ' + t + "</label>";
    render(host,
      '<fieldset class="uw-fs"><legend>Colour the Airbnb comps by</legend>' +
      radio("revenue", "Revenue potential", "Five bands, lightest under $30k") +
      radio("tier", "Against same-size homes", "Top 10% / top 11–25% / the rest, for its bedroom size") +
      radio("area", "Area", "West toward Killbuck, Millersburg, east toward Berlin") +
      radio("loc", "Setting", "Downtown, the rest of the village, countryside") + "</fieldset>" +
      '<fieldset class="uw-fs"><legend>Show</legend>' + tog("uw", "Acquisition targets: underwritten") + tog("newl", "Acquisition targets: new listings") + tog("areas", "Area outlines") + tog("labels", "Area names") +
      tog("village", "Village limits and the courthouse square (what zone and setting are measured against)") + tog("ghosts", "Filtered-out comps, as faint grey dots") + "</fieldset>" +
      '<p class="uw-fnote">' + UW.listings.length + " Airbnb entire homes from " + E(UW.data.comps.source.split(",")[0]) + " (Cleaned_Data), snapshot " + E(UW.data.comps.snapshot) +
      ". Airbnb pins are approximate, and whole complexes can share one pin.</p>");
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------
  const listingsOf = (ids) => ids.map((id) => UW.byId.get(id)).filter(Boolean);
  function onClick(e) {
    const b = e.target.closest("[data-act]");
    if (!b || b.disabled) return;
    const act = b.dataset.act, f = UW.ui.filters;
    const p = UW.ui.selected ? UW.property(UW.ui.selected) : null;
    const v = p && UW.activeVersion(p);
    if (act === "select") { UW.select(b.dataset.pid, { from: "panel" }); P.showTab("comps"); }
    else if (act === "clear") UW.select(null);
    else if (act === "tab-targets") P.showTab("targets");
    else if (act === "tab-filters") P.showTab("filters");
    else if (act === "mode") UW.setMode(b.dataset.v);
    else if (act === "beds") { UW.ui.amRules.bedsExact = b.dataset.v === "1"; UW.emit("near"); }
    else if (act === "prio") { UW.ui.amRules.prefs[b.dataset.f] = b.dataset.v; UW._prioOpen = true; UW.emit("near"); }
    else if (act === "pool-reset") { UW.ui.amRules.pool = null; UW.emit("near"); }
    else if (act === "unpure") UW.pureNearest(false);
    else if (act === "more") { UW.ui.n = Math.min(UW.listings.length, UW.ui.n + 50); UW.writeHash(); UW.emit("near"); }
    else if (act === "card-profile" && p) { UW.actions.openCard(p.id, "profile"); UW.afterPointer(() => setTimeout(() => { const n = document.getElementById("uw-profile-" + p.id); if (n) n.scrollIntoView({ behavior: "smooth", block: "center" }); }, 300)); }
    else if (act === "add-listing") UW.addApi.open();
    else if (act === "step" && p) { const all = UW.properties(), i = all.findIndex((x) => x.id === p.id); UW.select(all[(i + +b.dataset.v + all.length) % all.length].id, { from: "panel" }); }
    else if (act === "pure") UW.pureNearest(true);
    else if (act === "reset") UW.resetFilters();
    else if (act === "card") UW.actions.openCard(p.id);
    else if (act === "copy-comps" && p) UW.actions.copyComps(p.id, v.label);
    else if (act === "view") { UW.ui.compsView = b.dataset.v; renderComps(); }
    else if (act === "sort") { UW.ui.sort = b.dataset.v; UW.writeHash(); renderComps(); }
    else if (act === "open") UW.mapApi.openListing(b.dataset.id);
    else if (act === "add" && p) UW.actions.addComps(p.id, v.label, listingsOf([b.dataset.id]));
    else if (act === "remove" && p) UW.actions.removeComp(p.id, v.label, b.dataset.id);
    else if (act === "copyrow") UW.copyListings(listingsOf([b.dataset.id]), p, "");
    else if (act === "pickall") { P.shownListings().forEach((l) => UW.ui.picked.add(l.id)); renderComps(); }
    else if (act === "pickclear") { UW.ui.picked.clear(); renderComps(); }
    else if (act === "copypicked") UW.copyListings(listingsOf([...UW.ui.picked]), p, "selected");
    else if (act === "copyall") UW.copyListings(P.shownListings().slice(0, CAP), p, "(all shown" + (UW.matchSet.size > CAP ? ", capped at " + CAP : "") + ")");
    else if (act === "addpicked" && p) { if (UW.actions.addComps(p.id, v.label, listingsOf([...UW.ui.picked]))) { UW.ui.picked.clear(); renderComps(); } }
    else if (act === "note-edit") { editingNote = b.dataset.id; renderComps(); setTimeout(() => { const n = root.querySelector('[data-note="' + b.dataset.id + '"]'); if (n) { n.focus(); n.select(); } }, 30); }
    else if (act === "note-done") { editingNote = null; renderComps(); }
    else if (act === "note-reset") { UW.setSessionNote(UW.byId.get(b.dataset.id), p, null); editingNote = null; renderComps(); }
    else if (act === "unchip") {
      const k = b.dataset.k, d = UW.defaultFilters();
      if (k === "am") { const am = Object.assign({}, f.am); delete am[b.dataset.v]; UW.setFilters({ am }); }
      else if (k === "minRev") UW.setFilters({ minRev: null });
      else UW.setFilters({ [k]: d[k] });
    }
    else if (act === "chip") {
      const g = b.dataset.g, val = g === "beds" ? +b.dataset.v : b.dataset.v;
      const arr = f[g].includes(val) ? f[g].filter((x) => x !== val) : f[g].concat([val]);
      UW.setFilters({ [g]: arr });
    } else if (act === "am") {
      const am = Object.assign({}, f.am);
      const val = +b.dataset.v;
      if (val) am[b.dataset.k] = val; else delete am[b.dataset.k];
      UW.setFilters({ am });
    } else if (act === "zone") UW.setFilters({ zone: b.dataset.v });
    else if (act === "fav") UW.setFilters({ fav: b.dataset.v });
  }
  function onInput(e) {
    const t = e.target;
    if (t.dataset.note) UW.setSessionNote(UW.byId.get(t.dataset.note), UW.ui.selected ? UW.property(UW.ui.selected) : null, t.value);
  }
  function onChange(e) {
    const t = e.target;
    if (t.dataset.pick) {
      if (t.checked) UW.ui.picked.add(t.dataset.pick); else UW.ui.picked.delete(t.dataset.pick);
      renderComps();
      return;
    }
    if (t.dataset.layer) { UW.ui.layers[t.dataset.layer] = t.checked; UW.mapApi.layers(); return; }
    if (t.dataset.rule) { UW.ui.locRules[t.dataset.rule] = t.checked; UW.emit("near"); return; }
    const k = t.dataset.k;
    if (!k) return;
    const val = t.value === "" ? null : Number(t.value);
    if (k === "switch") { UW.select(t.value, { from: "panel" }); return; }
    if (k === "sleepsWindow") { UW.ui.amRules.sleepsWindow = val != null && val >= 0 ? Math.round(val) : null; UW.emit("near"); return; }
    if (k === "colorBy") { UW.ui.colorBy = t.value; UW.writeHash(); UW.mapApi.refresh(); return; }
    if (k === "n") { UW.ui.n = Math.max(1, Math.min(UW.ui.mode === "amenity" ? UW.listings.length : 50, Math.round(val || 12))); UW.writeHash(); UW.emit("near"); return; }
    if (k === "radius") { UW.ui.radius = val != null && val > 0 ? val : null; UW.writeHash(); UW.emit("near"); return; }
    if (["minRev", "maxRev", "minSleeps", "minBaths"].includes(k)) UW.setFilters({ [k]: val != null && val >= 0 ? val : null });
  }

  UW.on("filters", () => { renderFilters(); renderComps(); });
  UW.on("select", () => { const p = UW.ui.selected && UW.property(UW.ui.selected); if (p && p.geo) UW.ui.compsView = "nearest"; editingNote = null; renderComps(); renderTargets(); });
  UW.on("near", () => renderComps());
  UW.on("profile", () => renderComps());
  UW.on("comps", () => { renderComps(); renderTargets(); });
  UW.on("property", () => { renderComps(); renderTargets(); });
  UW.on("listings", () => { renderComps(); renderTargets(); });
  UW.on("places", () => { renderComps(); renderTargets(); });
})();
