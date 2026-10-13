/**
 * Data checks: first the comp audit, one table of every comp row in every
 * sheet, classed against the workbook (only Cleaned_Data entire homes are
 * valid comps; Zillow targets never are), filterable by target and class,
 * errors first, then large revenue / bedroom changes; per-target summaries;
 * reports/comp_audit.csv. Then the other sheet checks (formula check, the
 * Total Paydown column, duplicates, mortgage years, geocoding), and saved
 * edits: export / import / clear, plus pins for data/geocode_overrides.json.
 */
/* global UWMath */
(function () {
  const UW = window.UW, F = UW.fmt, E = UW.esc;
  const K = (UW.checksApi = {});

  K.init = function () {
    render();
    const host = document.getElementById("uw-checks-body");
    host.addEventListener("click", onClick);
    host.addEventListener("change", onChange);
    host.addEventListener("input", onFilter);
    UW.on("saved", renderSaved);
    UW.on("places", renderSaved);
    UW.on("listings", renderSaved);
  };

  const fileLink = (f) => '<span class="uw-filetag">' + E(f) + "</span>";
  const room = (id, url) => '<a href="' + E(url || "https://www.airbnb.com/rooms/" + id) + '" target="_blank" rel="noopener">' + E(id || "—") + "</a>";
  const fmtCh = (c) => {
    const f = (x, field) => (x == null ? "blank" : field === "revenue" ? F.money(x) : field === "adr" ? F.money2(x) : field === "occupancy" ? F.num(x) + "%" : F.num(x));
    return E(c.field.replace(/^HAS_/, "").replace(/_/g, " ")) + " " + f(c.sheet, c.field) + " → " + f(c.current, c.field);
  };

  function render() {
    const V = UW.data.uw.validation, uw = UW.data.uw;
    const versions = uw.properties.flatMap((p) => p.versions.map((v) => ({ p, v })));
    const nComps = versions.reduce((s, x) => s + x.v.comps.length, 0);
    const formula = versions.map(({ p, v }) => {
      const r = UWMath.verify(v);
      const a = v.sheet.amort;
      const fails = r.rows.filter((x) => x.result === "FAIL" && !(x.key === "principal" && Math.abs(v.sheet.cases.mid.principal - a.paid12) <= 1));
      const pFail = r.rows.some((x) => x.key === "principal" && x.result === "FAIL");
      const rounding = r.rows.some((x) => x.result === "rounding");
      return { p, v, r, ok: !fails.length, fails, pFail, rounding };
    });
    const pass = formula.filter((x) => x.ok).length;
    const tile = (val, lab, kind) => '<div class="uw-stat' + (kind ? " uw-stat--" + kind : "") + '"><strong>' + val + "</strong><span>" + lab + "</span></div>";
    const sec = (title, n, body, open) => '<details class="uw-check-sec"' + (open ? " open" : "") + "><summary>" + title + (n == null ? "" : ' <span class="uw-count' + (n ? "" : " uw-count--zero") + '">' + n + "</span>") + "</summary>" + body + "</details>";

    const formulaTable = '<div class="table-scroll"><table class="data-table uw-ftable"><thead><tr><th>File</th><th>Property</th><th>Sheet: cash on cash<br><span class="muted">low · mid · high</span></th><th>Recalculated here<br><span class="muted">low · mid · high</span></th><th>Result</th></tr></thead><tbody>' +
      formula.map((x) => {
        const s = x.v.sheet.cases, c = x.r.calc.cases, coc = (o) => ["low", "mid", "high"].map((k) => F.pct(o[k].coc)).join(" · ");
        const res = !x.ok ? '<span class="uw-badge uw-badge--bad">Doesn’t match: ' + x.fails.map((f) => E(f.label)).join(", ") + "</span>" :
          '<span class="uw-badge uw-badge--good">Matches</span>' + (x.rounding ? ' <span class="muted">within input rounding</span>' : "") + (x.pFail ? ' <span class="muted">· principal: see below</span>' : "");
        return "<tr><td>" + E(x.v.label) + '</td><th scope="row">' + E(x.p.street) + "</th><td>" + coc(s) + "</td><td>" + coc(c) + "</td><td>" + res + "</td></tr>";
      }).join("") + "</tbody></table></div>" +
      '<p class="caption">Every output (down payment through the 5-year total, 38 numbers per sheet) is recalculated from the sheet’s inputs and compared with the sheet. “Within input rounding” means a displayed input hides decimals ' +
      "(for example an HOA of $3.33 shown as $3). Principal Pay Down is the one formula that differs, and the next check explains why.</p>";

    const dupes = V.duplicateProperties.length ? '<ul class="uw-checklist">' + V.duplicateProperties.map((d) => "<li>" + d.properties.map((x) => "<strong>" + E(x.address) + "</strong> (file " + E(x.file) + ", " + F.money(x.price) + ")").join(" and ") +
      " list the same " + F.num(d.details.beds) + " / " + F.num(d.details.baths) + " bed / bath, " + Number(d.details.lot).toLocaleString() + " sqft lot and " + Number(d.details.size).toLocaleString() + " sqft size. Possibly the same house under two addresses, or details copied from another sheet.</li>").join("") + "</ul>" : '<p class="uw-empty">None.</p>';
    const files = V.duplicateFiles.length ? '<ul class="uw-checklist">' + V.duplicateFiles.map((d) => "<li>" + d.files.map(fileLink).join(" = ") + ": " + E(d.note) + "</li>").join("") + "</ul>" : '<p class="uw-empty">None.</p>';
    const myears = V.mortgageYears.length ? '<ul class="uw-checklist">' + V.mortgageYears.map((x) => "<li>File " + E(x.file) + " (" + E(x.address) + "): “Mortgage Years” says " + x.mortgageYears + ", but the amortization block and Debt Service use " + x.amortYears + " years. Reported, not changed.</li>").join("") + "</ul>" : '<p class="uw-empty">None.</p>';
    const ds = V.debtService.length ? '<p class="uw-hint">Debt Service matches 12 × the amortization block’s payment on every sheet. The block’s Total Paydown column does not:</p><ul class="uw-checklist">' +
      V.debtService.map((x) => "<li>File " + E(x.file) + " (" + E(x.address) + "): " + E(x.issue) + "</li>").join("") + "</ul><p class=\"uw-hint\">This page’s own calculation uses the principal actually repaid. The sheets and their amortization blocks are left exactly as they are.</p>" : '<p class="uw-empty">None.</p>';
    const geo = V.geocode.length ? '<ul class="uw-checklist">' + V.geocode.map((x) => "<li><strong>" + E(x.address) + "</strong>: " + E(x.issue) + ". On its card, use “Place pin on the map” or “Look up with OpenStreetMap”.</li>").join("") + "</ul>" : '<p class="uw-empty">Every address matched.</p>';
    const C = UW.data.comps;
    const wb = '<ul class="uw-checklist"><li>' + C.n + " entire homes are used as comps, out of " + C.nCleaned + " listings in Cleaned_Data. The " + C.nOtherRooms + " private room" + (C.nOtherRooms === 1 ? " is" : "s are") + " left out (comps are entire homes).</li>" +
      "<li>Exclude_Comp is 0 on every row, so it filters nothing.</li>" + (C.guestFavoriteAny ? "" : "<li>is_guest_favorite is 0 on every row, so the guest-favourite filter matches nothing on “Yes”.</li>") +
      "<li>Occupancy typed to one decimal in a sheet (57.9% for 57.93%) counts as the same value: differences under 0.05 points are ignored.</li>" +
      "<li>Locations: underwritten addresses are geocoded with the US Census geocoder, which interpolates along the street; new listings use OpenStreetMap or a pin placed by hand. " +
      "Zone and setting use the same rules as the listings: inside or outside the Millersburg village limits (US Census), and within " + Math.round(C.downtownKm * 1000) + " m of the courthouse square for Downtown. " +
      "The area is the nearest Airbnb listing’s; " + E(uw.rules.area.replace(/^the nearest Airbnb listing's area \((.*)\)$/, "$1")) + ".</li></ul>";
    const committed = V.committed && V.committed.length ? sec("Committed browser edits (data/underwritten_local.json)", V.committed.length, '<ul class="uw-checklist">' + V.committed.map((x) => "<li>" + E(x.id) + ": " + E(x.issue) + "</li>").join("") + "</ul>") : "";

    const AU = uw.audit, rows = AU.rows;
    void nComps;
    const nErr = rows.filter((r) => !r.valid).length, nBig = rows.filter((r) => r.valid && (r.bigRevenue || r.bedroomsChanged)).length;
    const targets = [...new Map(rows.map((r) => [r.targetId, r.target])).entries()];
    const classes = Object.entries(AU.classes);
    const audit = '<div class="uw-audit">' +
      '<p class="uw-audit__src">Checked against <strong>' + E(AU.workbooks[0].file) + "</strong> (snapshot " + E(AU.workbooks[0].snapshot) + ", the source of truth)" +
      (AU.workbooks.length > 1 ? "; also scanned " + AU.workbooks.slice(1).map((w) => E(w.file) + " (snapshot " + E(w.snapshot) + ")").join(", ") + " to say where else a comp appears" : "") +
      '. Matched by Airbnb room ID. Only <strong>Cleaned_Data entire homes</strong> are valid comps; Zillow listings are acquisition targets and never comps.</p>' +
      (versions.length ? "" : '<p class="uw-hint"><strong>No Millersburg underwriting sheets yet.</strong> Once “New Market UW’ing” CSVs are added to <code>underwriting/source_csv/</code> and the build is run, every comp row in them is checked here. Comps you add to a new listing on this page can only come from the workbook’s Cleaned_Data entire homes.</p>') +
      '<div class="uw-stats uw-stats--wide">' + tile(rows.length, "comp rows in " + versions.length + " sheets") + tile(rows.filter((r) => r.cls === "usable").length, "usable") +
      tile(rows.filter((r) => r.cls === "possibly").length, "usable, possibly good") + tile(nErr, "errors (not valid comps)", nErr ? "bad" : "good") +
      tile(nBig, "valid rows with a >15% revenue or bedroom change", nBig ? "warn" : "") + tile(pass + " of " + formula.length, "sheets match the formulas", pass === formula.length ? "good" : "bad") + "</div>" +
      '<h3 class="uw-h3">By target</h3><ul class="uw-audit__sum">' + AU.summaries.map((x) => '<li class="' + (x.errors ? "has-err" : "") + '"><strong>' + E(x.target) + "</strong>" +
        (x.scenario && x.scenario !== "File " + x.file ? " · " + E(x.scenario) : "") + ' <span class="muted">file ' + E(x.file) + "</span>: " + E(x.summary) + "</li>").join("") + "</ul>" +
      '<div class="uw-audit__ctl"><label>Target <select data-af="target"><option value="">All targets</option>' + targets.map(([id, t]) => '<option value="' + E(id) + '">' + E(t) + "</option>").join("") + "</select></label>" +
      '<label>Class <select data-af="cls"><option value="">All classes</option><option value="errors">Errors only</option><option value="changed">Changed by more than 15%, or bedrooms</option>' +
      classes.map(([k, lab]) => '<option value="' + k + '">' + E(lab) + "</option>").join("") + "</select></label>" +
      '<span class="uw-audit__n" id="uw-audit-n"></span><a class="uw-btn uw-btn--small uw-btn--primary" href="' + E(AU.report) + "?v=" + UW.VERSION + '" download="comp_audit.csv">Download comp_audit.csv</a></div>' +
      '<div class="table-scroll uw-audit__scroll"><table class="data-table uw-audit__t"><thead><tr><th>Target</th><th>File / scenario</th><th>Row</th><th>Comp</th><th>Title</th><th>Class</th><th>Reason</th><th>Sheet revenue</th><th>Current revenue</th><th>Change</th></tr></thead><tbody>' +
      rows.map((r) => {
        const chg = r.valid ? [r.revenueChangePct != null && Math.abs(r.revenueChangePct) >= 0.05 ? (r.revenueChangePct > 0 ? "+" : "") + r.revenueChangePct + "%" : "", r.bedroomsChanged ? F.num(r.sheetBedrooms) + "→" + F.num(r.currentBedrooms) + " BR" : "",
          r.changes.filter((c) => !["revenue", "bedrooms", "adr", "occupancy"].includes(c.field)).map((c) => c.field.replace(/^HAS_/, "") + " " + (c.sheet == null ? "blank" : c.sheet) + "→" + c.current).join(", ")].filter(Boolean).join(" · ") : "";
        const cand = r.candidates && r.candidates.length ? '<span class="cell-sub">Same title: ' + r.candidates.map((c) => '<a href="' + E(c.url) + '" target="_blank" rel="noopener">' + E(c.id) + "</a> (" + E(AU.classes[c.cls]) + ")").join(", ") + "; not substituted</span>" : "";
        const where = r.appearsIn && r.appearsIn.length ? '<span class="cell-sub">In: ' + r.appearsIn.map(E).join("; ") + "</span>" : "";
        return '<tr data-target="' + E(r.targetId) + '" data-cls="' + r.cls + '" data-err="' + (r.valid ? 0 : 1) + '" data-big="' + (r.valid && (r.bigRevenue || r.bedroomsChanged) ? 1 : 0) + '" class="' + (!r.valid ? "uw-audit--err" : r.bigRevenue || r.bedroomsChanged ? "uw-audit--big" : "") + '">' +
          '<th scope="row">' + E(r.target) + "</th><td>" + E(r.file) + (r.scenario && r.scenario !== "File " + r.file ? '<span class="cell-sub">' + E(r.scenario) + "</span>" : "") + "</td><td>" + r.row + "</td>" +
          "<td>" + (r.id ? room(r.id, r.url) : '<span class="uw-comp__bad">' + E((r.url || "").slice(0, 60)) + (r.url && r.url.length > 60 ? "…" : "") + "</span>") + "</td>" +
          '<td class="uw-audit__title">' + E(r.title || "—") + "</td>" +
          '<td><span class="uw-badge uw-badge--' + (r.valid ? (r.cls === "possibly" ? "warn" : "good") : "err") + '">' + E(r.label) + "</span></td>" +
          '<td class="uw-audit__reason">' + E(r.reason || "") + cand + where + "</td>" +
          "<td>" + F.money(r.sheetRevenue) + "</td><td>" + (r.valid ? F.money(r.currentRevenue) : "—") + '</td><td class="uw-audit__chg">' + E(chg) + "</td></tr>";
      }).join("") + "</tbody></table></div></div>";
    document.getElementById("uw-checks-body").innerHTML = audit +
      '<details class="uw-check-sec uw-other"><summary>Other sheet checks <span class="uw-count">' + (V.debtService.length + V.duplicateProperties.length + V.duplicateFiles.length + V.mortgageYears.length + V.geocode.length) + "</span></summary>" +
      sec("Formula check, recalculated in this browser", formula.length, formulaTable, true) +
      sec("Amortization block: the Total Paydown column", V.debtService.length, ds) +
      sec("Possible duplicate targets", V.duplicateProperties.length, dupes) +
      sec("Duplicate files", V.duplicateFiles.length, files) +
      sec("Mortgage Years vs. Amortization Years", V.mortgageYears.length, myears) +
      sec("Geocoding", V.geocode.length, geo) +
      sec("About the workbook and the rules", null, wb) + committed + "</details>" +
      '<div class="uw-saved" id="uw-saved"></div>';
    onFilter();
    renderSaved();
  }

  function renderSaved() {
    const host = document.getElementById("uw-saved");
    if (!host) return;
    const L = UW.local, ex = UW.exportLocal();
    const nEdits = Object.keys(ex.edits).length, nNew = ex.listings.length;
    const cm = UW.data.uw.committed || { listings: [], edits: {} };
    host.innerHTML = '<h3 class="uw-h3">Your edits and new listings</h3>' +
      "<p>" + (UW.storageOk ? "Saved in this browser only." : '<span class="uw-warn">This browser is blocking storage, so edits last only until the page is closed.</span>') +
      " Right now: <strong>" + nNew + "</strong> new listing" + (nNew === 1 ? "" : "s") + " and edits to <strong>" + nEdits + "</strong> underwritten target" + (nEdits === 1 ? "" : "s") + "." +
      (cm.listings.length || Object.keys(cm.edits).length ? " " + cm.listings.length + " listing(s) and " + Object.keys(cm.edits).length + " edit(s) come from the committed data/underwritten_local.json." : "") + "</p>" +
      '<div class="uw-actions"><button type="button" class="uw-btn uw-btn--primary" data-act="export">Export (JSON)</button>' +
      '<label class="uw-btn uw-btn--ghost uw-filebtn">Import JSON<input type="file" accept="application/json,.json" data-act="import"></label>' +
      '<button type="button" class="uw-btn uw-btn--ghost" data-act="export-pins"' + (pinsToExport().length ? "" : " disabled") + ">Export pins (geocode_overrides.json)</button>" +
      '<button type="button" class="uw-btn uw-btn--danger" data-act="clear"' + (L.listings.length || Object.keys(L.edits).length || L.deleted.length ? "" : " disabled") + ">Clear this browser’s edits</button></div>" +
      '<p class="uw-hint">To share them with everyone: Export, save the file as <code>data/underwritten_local.json</code> in the repo, run <code>python scripts/build_underwritten.py</code>, and commit. ' +
      "When a new listing’s CSV is later added to <code>underwriting/source_csv/</code>, the build drops the committed copy in favour of the sheet. " +
      "A pin you place by hand on an underwritten target goes into <em>Export pins</em>: save it as <code>data/geocode_overrides.json</code> and rebuild, and that pin is used for everyone.</p>";
  }

  // Hand-placed pins on underwritten targets, merged into the current overrides file.
  function pinsToExport() {
    return UW.properties().filter((p) => p.kind === "underwritten" && p.pinEdited && p.geo && p.geo.source === "manual");
  }
  async function exportPins() {
    let cur = { _readme: "Manual pins, keyed by Zillow zpid. Overrides win over the geocoders.", overrides: {} };
    try { cur = await fetch("data/geocode_overrides.json?v=" + Date.now()).then((r) => r.json()); } catch (e) { /* start fresh */ }
    cur.overrides = cur.overrides || {};
    pinsToExport().forEach((p) => { cur.overrides[p.id] = { lat: p.geo.lat, lng: p.geo.lng, note: "placed on the map for " + p.street + " on " + new Date().toISOString().slice(0, 10) }; });
    UW.download("geocode_overrides.json", JSON.stringify(cur, null, 1) + "\n", "application/json");
    UW.toast("Exported. Save it as data/geocode_overrides.json and rebuild.");
  }
  // Audit table filters (target, class).
  function onFilter() {
    const host = document.getElementById("uw-checks-body");
    const t = host.querySelector('[data-af="target"]'), c = host.querySelector('[data-af="cls"]');
    if (!t) return;
    let n = 0;
    host.querySelectorAll(".uw-audit__t tbody tr").forEach((tr) => {
      const ok = (!t.value || tr.dataset.target === t.value) &&
        (!c.value || (c.value === "errors" ? tr.dataset.err === "1" : c.value === "changed" ? tr.dataset.big === "1" : tr.dataset.cls === c.value));
      tr.hidden = !ok;
      if (ok) n++;
    });
    document.getElementById("uw-audit-n").textContent = n + " row" + (n === 1 ? "" : "s");
  }
  function onClick(e) {
    const b = e.target.closest("[data-act]");
    if (!b || b.disabled) return;
    if (b.dataset.act === "export-pins") { exportPins(); return; }
    if (b.dataset.act === "export") {
      UW.download("underwritten_local.json", JSON.stringify(UW.exportLocal(), null, 1) + "\n", "application/json");
      UW.toast("Exported. Commit it as data/underwritten_local.json.");
    } else if (b.dataset.act === "clear") {
      if (confirm("Clear every edit and new listing saved in this browser? Export first if you want to keep them.")) { UW.clearLocal(); UW.cardsApi.renderList(); UW.toast("Cleared"); }
    }
  }
  function onChange(e) {
    const t = e.target;
    if (t.dataset.af) { onFilter(); return; }
    if (t.dataset.act !== "import" || !t.files.length) return;
    const fr = new FileReader();
    fr.onload = () => {
      try {
        const js = JSON.parse(fr.result);
        const n = UW.importLocal(js);
        UW.cardsApi.renderList();
        UW.toast("Imported " + n.listings + " listing(s) and edits to " + n.edits + " propert" + (n.edits === 1 ? "y" : "ies"));
      } catch (err) { UW.toast("Import failed: " + err.message, "warn"); }
      t.value = "";
    };
    fr.readAsText(t.files[0]);
  }
})();
