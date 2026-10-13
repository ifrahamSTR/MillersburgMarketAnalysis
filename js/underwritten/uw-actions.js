/**
 * Actions shared by a target's card, its map popup and the side panel, so the
 * three always behave the same: copy comps, copy revenue cases, download the
 * UW CSV, add comps, remove flagged comps, scenario helpers.
 *
 * Copying or downloading a comp set that holds error rows (anything not in
 * Cleaned_Data as an entire home) asks first; the default is to leave them out.
 */
/* global UWCsv, UWRules */
(function () {
  const UW = window.UW, E = UW.esc;
  const A = (UW.actions = {});
  const ctx = (pid, label) => { const p = UW.property(pid); return { p, v: label ? p.versions.find((x) => x.label === label) : UW.activeVersion(p) }; };

  // A small modal with labelled choices; resolves to the chosen value (or "cancel").
  UW.choose = function (title, bodyHtml, choices) {
    return new Promise((resolve) => {
      let d = document.getElementById("uw-choice");
      if (!d) { d = document.createElement("dialog"); d.id = "uw-choice"; d.className = "uw-dialog uw-choice"; document.body.appendChild(d); }
      d.innerHTML = '<form method="dialog" class="uw-dlg"><div class="uw-dlg__head"><h2>' + E(title) + '</h2></div><div class="uw-dlg__body">' + bodyHtml + "</div>" +
        '<div class="uw-dlg__foot">' + choices.map((c) => '<button type="button" class="uw-btn ' + (c.primary ? "uw-btn--primary" : c.danger ? "uw-btn--danger" : "uw-btn--ghost") + '" data-v="' + c.value + '"' + (c.primary ? " autofocus" : "") + ">" + E(c.label) + "</button>").join("") + "</div></form>";
      const done = (v) => { d.close(); resolve(v); };
      d.querySelectorAll("[data-v]").forEach((b) => b.addEventListener("click", () => done(b.dataset.v)));
      d.addEventListener("cancel", () => resolve("cancel"), { once: true });
      d.showModal();
      const def = d.querySelector("[autofocus]");
      if (def) def.focus();
    });
  };
  const rowList = (rows) => '<ul class="uw-checklist">' + rows.map((c) => "<li><strong>" + E(c.id || c.url.slice(0, 60)) + "</strong>: " + E(c.label) + (c.reason ? " (" + E(c.reason) + ")" : "") + "</li>").join("") + "</ul>";

  // Ask what to do with error rows; resolves to the rows to use, or null to stop.
  async function validRowsOrAsk(v, verb) {
    const bad = v.comps.filter((c) => !c.valid);
    if (!bad.length) return v.comps;
    const n = bad.length;
    const pick = await UW.choose(n + " row" + (n === 1 ? " is" : "s are") + " not valid comps",
      "<p>These rows are not Airbnb entire homes in the workbook’s Cleaned_Data:</p>" + rowList(bad), [
        { value: "without", label: verb + " without them", primary: true },
        { value: "anyway", label: verb + " anyway" },
        { value: "cancel", label: "Cancel" }]);
    if (pick === "cancel") return null;
    return pick === "anyway" ? v.comps : v.comps.filter((c) => c.valid);
  }

  A.copyComps = async function (pid, label) {
    const { v } = ctx(pid, label);
    const rows = await validRowsOrAsk(v, "Copy");
    if (!rows) return;
    if (!rows.length) { UW.toast("No valid comps to copy", "warn"); return; }
    UW.copy(UWCsv.compsTSV(rows), rows.length + " comp row" + (rows.length === 1 ? "" : "s") + ", revenue high to low (15 columns, no header)");
  };
  A.copyRevenue = function (pid, label) {
    const { v } = ctx(pid, label);
    UW.copy(["low", "mid", "high"].map((k) => (UW.isNum(v.inputs.revenue[k]) ? Math.round(v.inputs.revenue[k]) : "")).join("\t"), "the revenue cases (low, mid, high)");
  };
  A.downloadCsv = async function (pid, label) {
    const { p, v } = ctx(pid, label);
    const isUW = p.kind === "underwritten";
    const comps = await validRowsOrAsk(v, "Download");
    if (!comps) return;
    const file = isUW ? v.file : UW.data.uw.templateFile;
    try {
      const text = await UW.sourceCsv(file);
      const model = Object.assign({}, UW.clone(v.inputs), { notes: v.notes, url: isUW ? v.url : p.url, comps });
      const out = UWCsv.exportSheet(text, model);
      const stamp = new Date().toISOString().slice(0, 10);
      const name = isUW ? file.replace(/( \(\d+\))?\.csv$/, "") + " - from site " + stamp + ".csv" : "New Market UW'ing - " + p.street.replace(/[\\/:*?"<>|]+/g, "-") + " " + stamp + ".csv";
      UW.download(name, out);
      if (!isUW && !p.listing.downloaded) UW.updateListing(p.id, { downloaded: true });
      UW.toast("Downloaded " + name + " (comps in revenue order)");
      UW.emit("comps", p.id);
    } catch (err) {
      UW.toast("CSV not written: " + err.message, "warn");
    }
  };

  /**
   * Add Airbnb comps to a target's comp set (the one that goes into the sheet): Cleaned_Data
   * entire homes only, 15 rows at most, notes tagged with the mode they came from and the
   * distance to this target. A comp already added from the other mode isn't duplicated: its
   * tag becomes [Location + Amenity match].
   */
  A.addComps = function (pid, label, listings, mode) {
    const { p, v } = ctx(pid, label);
    mode = mode || (UW.ui.pure ? "location" : UW.ui.mode);
    let rows = v.comps.map((c) => Object.assign({}, c));
    const n = { added: 0, both: 0, duplicate: 0, full: 0, invalid: 0 };
    listings.forEach((l) => {
      const r = UWRules.addToSet(rows, l, { byId: UW.byId, mode, note: (x) => UW.noteFor(x, p, mode) });
      rows = r.rows;
      n[r.result]++;
    });
    if (n.added || n.both) UW.setComps(p.id, v.label, rows);
    const msg = n.added ? "Added " + n.added + " comp" + (n.added === 1 ? "" : "s") + " to " + p.street + " (" + UW.scenarioName(v) + "), in revenue order" : n.both ? "" : "Nothing added";
    const extra = [n.both && n.both + " already added from the other mode, now tagged Location + Amenity", n.duplicate && n.duplicate + " already in the set",
      n.full && n.full + " over the sheet's 15 rows", n.invalid && n.invalid + " not a valid comp"].filter(Boolean);
    UW.toast([msg, extra.join("; ")].filter(Boolean).join("; "), n.added || n.both ? "" : "warn");
    return n.added + n.both;
  };
  // "Append distance to notes": only when clicked, and only for rows that came from the sheet.
  A.appendDistance = function (pid, label) {
    const { p, v } = ctx(pid, label);
    const before = v.comps.map((c) => c.notes);
    const rows = UWRules.appendDistance(v.comps.map((c) => Object.assign({}, c, { match: c.match || "sheet" })), UW.targetPos(p), UW.byId);
    const changed = rows.filter((r, i) => r.notes !== before[i]).length;
    if (!changed) { UW.toast("No sheet rows to add a distance to"); return; }
    UW.setComps(p.id, v.label, rows);
    UW.toast("Added the distance to " + changed + " sheet row" + (changed === 1 ? "" : "s"));
  };
  A.removeComp = function (pid, label, id) {
    const { p, v } = ctx(pid, label);
    UW.setComps(p.id, v.label, v.comps.filter((c) => UW.compId(c) !== id));
  };
  A.removeFlagged = async function (pid, label) {
    const { p, v } = ctx(pid, label);
    const bad = v.comps.filter((c) => !c.valid);
    if (!bad.length) return;
    const ok = await UW.choose("Remove " + bad.length + " flagged comp" + (bad.length === 1 ? "" : "s") + "?", "<p>From " + E(p.street) + " (" + E(UW.scenarioName(v)) + "):</p>" + rowList(bad) +
      '<p class="uw-hint">Only these rows go; the sheet file itself is untouched until you download a new CSV.</p>', [
        { value: "remove", label: "Remove them", danger: true }, { value: "cancel", label: "Keep them", primary: true }]);
    if (ok !== "remove") return;
    UW.setComps(p.id, v.label, v.comps.filter((c) => c.valid));
    UW.toast("Removed " + bad.length + " flagged comp" + (bad.length === 1 ? "" : "s"));
  };
  // Copy another scenario's comp rows as they are (then edit them).
  A.startFrom = function (pid, toLabel, fromLabel) {
    const { p } = ctx(pid);
    const from = p.versions.find((x) => x.label === fromLabel);
    UW.setComps(p.id, toLabel, from.comps.map((c) => Object.assign({}, c)));
    UW.toast("Copied " + from.comps.length + " rows from " + UW.scenarioName(from) + "; edit them for this scenario");
  };
  // "Find no-pool comps": Match by amenities with pool = 0.
  A.findComps = function (pid, label, mode, pool) {
    if (label) UW.ui.versions[pid] = label;
    UW.select(pid, { from: "card", mode: mode || "amenity" });
    if (pool != null) { UW.ui.amRules.pool = pool; UW.emit("near"); }
    UW.panelApi.showTab("comps");
    document.getElementById("uw-map").scrollIntoView({ behavior: "smooth", block: "start" });
  };
  /** Side-by-side scenarios (one column each): setup, out of pocket, revenue and cash on cash cases, the 20% and 4% checks. */
  UW.scenarioTable = function (p, compact) {
    const F = UW.fmt, vs = p.versions;
    const cell = (v, fn) => "<td>" + fn(v) + "</td>";
    const row = (label, fn, cls) => '<tr' + (cls ? ' class="' + cls + '"' : "") + '><th scope="row">' + label + "</th>" + vs.map((v) => cell(v, fn)).join("") + "</tr>";
    const ratio = (v) => (v.inputs.price && UW.isNum(v.inputs.revenue.mid) ? v.inputs.revenue.mid / v.inputs.price : null);
    const screen = (v) => { const r = ratio(v); return r == null ? "—" : '<span class="uw-badge uw-badge--' + (r >= UW.SCREEN ? "good" : "warn") + '">' + (r >= UW.SCREEN ? "✓ " : "") + F.pct(r, 1) + "</span>"; };
    const four = (v) => { const c = v.outputs.cases.low.coc, st = UW.cocStatus(c); return UW.isNum(c) ? '<span class="uw-badge uw-badge--' + st + '">' + (st === "good" ? "✓ meets" : "below") + "</span>" : "—"; };
    const coc = (k) => (v) => '<span class="uw-coc--' + UW.cocStatus(v.outputs.cases[k].coc) + '">' + F.pct(v.outputs.cases[k].coc) + "</span>";
    return '<div class="table-scroll uw-scen' + (compact ? " uw-scen--compact" : "") + '"><table class="data-table uw-scen__t"><thead><tr><th>Scenario</th>' +
      vs.map((v) => "<th>" + E(UW.scenarioName(v)) + '<span class="cell-sub">file ' + E(v.label) + (v.label === p.defaultVersion ? " · default" : "") + "</span></th>").join("") + "</tr></thead><tbody>" +
      row("Setup total", (v) => F.money(v.outputs.setupTotal)) + row("Total out of pocket", (v) => "<strong>" + F.money(v.outputs.oop) + "</strong>") +
      row("Revenue · low", (v) => F.k(v.inputs.revenue.low)) + row("Revenue · mid", (v) => F.k(v.inputs.revenue.mid)) + row("Revenue · high", (v) => F.k(v.inputs.revenue.high)) +
      row("Cash on cash · low", coc("low"), "uw-scen__coc") + row("Cash on cash · mid", coc("mid"), "uw-scen__coc") + row("Cash on cash · high", coc("high"), "uw-scen__coc") +
      row("20% screen (mid ÷ price)", screen) + row("Low case vs 4%", four) +
      row("Comp errors", (v) => { const n = UW.compErrors(v).length; return n ? '<span class="uw-badge uw-badge--err">' + n + " comp error" + (n === 1 ? "" : "s") + "</span>" : '<span class="uw-badge uw-badge--good">none</span>'; }) + "</tbody></table></div>";
  };
  A.openCard = function (pid, tab) { UW.cardsApi.open(pid, true, tab); };
  A.rank = function (pid, mode) {
    UW.select(pid, { from: "popup", mode: mode || "location" });
    UW.panelApi.showTab("comps");
  };
})();
