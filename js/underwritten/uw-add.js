/**
 * Add / edit a new Zillow listing. The address comes from the Zillow URL
 * slug; everything else (price, beds, baths, sizes, notes) is typed by the
 * user. The location comes from OpenStreetMap's Nominatim, used within its
 * policy: one request at a time, at least 1.1 s apart, results cached, the
 * page identified by its Referer (browsers can't set a User-Agent). If it
 * finds nothing, or only the street, the pin is placed or dragged by hand.
 *
 * A new listing starts from the blank template (underwriting/template/): the
 * team's financing and tax assumptions, with setup items, OPEX amounts and
 * revenue cases left blank for Millersburg numbers, and no comps. Once
 * Millersburg targets are underwritten, one of their sheets can be the start.
 */
/* global UWGeo, UWRules */
(function () {
  const UW = window.UW, E = UW.esc;
  const A = (UW.addApi = {});
  let dlg, editing = null, found = null;

  // ---------------------------------------------------------------------------
  // Nominatim queue
  // ---------------------------------------------------------------------------
  const GC_KEY = "millersburgUW.geocache";
  let chain = Promise.resolve(), last = 0;
  function cacheGet(q) { try { return (JSON.parse(localStorage.getItem(GC_KEY) || "{}"))[q]; } catch (e) { return undefined; } }
  function cacheSet(q, v) { try { const c = JSON.parse(localStorage.getItem(GC_KEY) || "{}"); c[q] = v; localStorage.setItem(GC_KEY, JSON.stringify(c)); } catch (e) { /* storage blocked */ } }
  A.geocode = function (address) {
    const q = String(address || "").trim();
    if (!q) return Promise.resolve(null);
    const hit = cacheGet(q);
    if (hit !== undefined) return Promise.resolve(hit);
    chain = chain.then(async () => {
      const wait = 1100 - (Date.now() - last);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      const params = new URLSearchParams({ q, format: "jsonv2", limit: "1", countrycodes: "us", addressdetails: "1", viewbox: "-82.25,40.72,-81.62,40.36", bounded: "1" });
      const r = await fetch("https://nominatim.openstreetmap.org/search?" + params, { headers: { "Accept-Language": "en" }, referrerPolicy: "strict-origin-when-cross-origin" });
      if (!r.ok) throw new Error("OpenStreetMap lookup failed (" + r.status + ")");
      const js = await r.json();
      const h = js[0];
      const out = h ? { lat: +(+h.lat).toFixed(6), lng: +(+h.lon).toFixed(6), source: "nominatim", matched: h.display_name,
        approximate: h.category === "highway" || ["road", "street"].includes(h.addresstype) || !(h.address && h.address.house_number) } : null;
      cacheSet(q, out);
      return out;
    });
    const p = chain;
    chain = chain.catch(() => null);
    return p;
  };

  A.lookupFor = async function (p) {
    UW.toast("Looking up " + p.address + " on OpenStreetMap…");
    try {
      const g = await A.geocode(p.address);
      if (!g) { UW.toast("OpenStreetMap has no match. Click the map to place the pin.", "warn"); UW.mapApi.startPlace(p.id); return; }
      UW.setPropertyField(p.id, "pin", g);
      UW.toast(g.approximate ? "OpenStreetMap only knows the street. Drag the pin to the house." : "Pin placed from OpenStreetMap.", g.approximate ? "warn" : "");
      UW.select(p.id, { focus: true });
      if (g.approximate) UW.mapApi.startPlace(p.id);
    } catch (e) { UW.toast(e.message + ". Click the map to place the pin.", "warn"); UW.mapApi.startPlace(p.id); }
  };

  // ---------------------------------------------------------------------------
  // Notes in the sheet's Analyst Notes format
  // ---------------------------------------------------------------------------
  const n = (v) => (v == null || v === "" ? "" : String(v));
  A.buildNotes = function (f) {
    const pb = f.projBeds != null ? f.projBeds : f.beds, pba = f.projBaths != null ? f.projBaths : f.baths;
    const now = (f.projBeds != null || f.projBaths != null) && f.beds != null && (pb !== f.beds || pba !== f.baths) ? " (currently " + n(f.beds) + " / " + n(f.baths) + ")" : "";
    const why = String(f.why || "").split("\n").map((s) => s.trim().replace(/^(--|[-•*])\s*/, "")).filter(Boolean);
    const has = [f.pool && "pool", f.hotTub && "hot tub"].filter(Boolean);
    if (has.length) why.push("Existing " + has.join(" and "));
    return ["Property Details:", "-- Bed / Bath (projected): " + n(pb) + " / " + n(pba) + now, "-- Lot Size (sqft): " + n(f.lot), "-- Prop Size (sqft): " + n(f.sqft), "Why This Property?"]
      .concat((why.length ? why : [""]).map((w) => "-- " + w)).join("\n");
  };

  // ---------------------------------------------------------------------------
  // Dialog
  // ---------------------------------------------------------------------------
  A.init = function () {
    dlg = document.getElementById("uw-add-dialog");
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
    dlg.addEventListener("submit", onSubmit);
    dlg.addEventListener("input", onInput);
    dlg.addEventListener("click", onClick);
  };

  const field = (id, label, type, attrs, hint) => '<div class="uw-field"><label for="' + id + '">' + label + "</label><input id=\"" + id + '" name="' + id + '" type="' + type + '" ' + (attrs || "") + ">" + (hint ? '<p class="uw-hint" id="' + id + '-hint">' + hint + "</p>" : "") + "</div>";
  A.open = function (id) {
    editing = id ? UW.property(id) : null;
    const l = editing && editing.listing;
    const f = (l && l.facts) || {};
    found = l ? l.pin || null : null;
    const tpl = UW.templates;
    const defTpl = tpl.find((t) => t.file === UW.data.uw.templateFile) || tpl[0];
    const whyText = l ? UW.parseNotes(l.notes).why.filter((w) => !/^Existing (pool|hot tub)/.test(w)).join("\n") : "";
    dlg.innerHTML = '<form method="dialog" class="uw-dlg" novalidate><div class="uw-dlg__head"><h2>' + (editing ? "Edit " + E(editing.street) : "Add a Zillow listing") + "</h2>" +
      '<button type="button" class="uw-btn uw-btn--icon" data-act="close" aria-label="Close">×</button></div>' +
      '<div class="uw-dlg__body">' +
      field("f-url", "Zillow URL", "url", 'placeholder="https://www.zillow.com/homedetails/…" value="' + E(l ? l.url : "") + '" autocomplete="off"', "The address is read from the link.") +
      field("f-addr", "Address", "text", 'required value="' + E(l ? l.address : "") + '" autocomplete="off"') +
      '<div class="uw-fgrid">' +
      field("f-price", "List / purchase price ($)", "number", 'required min="1" step="1000" inputmode="numeric" value="' + n(l ? l.inputs.price : "") + '"') +
      field("f-beds", "Bedrooms", "number", 'min="0" step="1" inputmode="numeric" value="' + n(f.beds) + '"') +
      field("f-baths", "Bathrooms", "number", 'min="0" step="0.5" inputmode="decimal" value="' + n(f.baths) + '"') +
      field("f-sqft", "Property size (sqft)", "number", 'min="0" step="1" inputmode="numeric" value="' + n(f.sqft) + '"') +
      field("f-lot", "Lot size (sqft)", "number", 'min="0" step="1" inputmode="numeric" value="' + n(f.lot) + '"') + "</div>" +
      '<div class="uw-field"><label for="f-why">Why this property? <span class="muted">one point per line</span></label><textarea id="f-why" rows="4">' + E(whyText) + "</textarea></div>" +
      '<details class="uw-dlg__more"' + (f.projBeds != null || f.pool || f.hotTub ? " open" : "") + "><summary>After conversion, existing amenities</summary><div class=\"uw-fgrid\">" +
      field("f-pbeds", "Projected bedrooms", "number", 'min="0" step="1" inputmode="numeric" value="' + n(f.projBeds) + '"') +
      field("f-pbaths", "Projected bathrooms", "number", 'min="0" step="0.5" inputmode="decimal" value="' + n(f.projBaths) + '"') +
      '<div class="uw-field uw-field--checks"><label class="uw-check"><input type="checkbox" id="f-pool"' + (f.pool ? " checked" : "") + "> Existing pool</label>" +
      '<label class="uw-check"><input type="checkbox" id="f-tub"' + (f.hotTub ? " checked" : "") + "> Existing hot tub</label></div></div></details>" +
      (editing ? "" : '<div class="uw-field"><label for="f-tpl">Start the underwriting from</label><select id="f-tpl">' + tpl.map((t) => '<option value="' + E(t.file) + '"' + (t === defTpl ? " selected" : "") + ">" +
        (t.blank ? "Blank sheet: the team’s financing assumptions only" : E(t.street) + " · file " + E(t.label)) + (t === defTpl ? " (default)" : "") + "</option>").join("") + '</select><p class="uw-hint">' +
        "The blank sheet keeps the UW sheet’s financing and tax assumptions (20% down, 7.25%, 3% closing, 30-year amortization) and leaves setup items and OPEX amounts empty for Millersburg numbers. " +
        "An underwritten target’s sheet copies its financing, OPEX and setup items. Revenue cases and comps start empty either way.</p></div>") +
      '<div class="uw-field"><span class="uw-flabel">Location</span><div class="uw-locrow"><button type="button" class="uw-btn uw-btn--small" data-act="find">Find on the map</button><span id="f-loc" class="uw-hint" aria-live="polite">' +
      (found ? locText(found) : "Not looked up yet. If OpenStreetMap can’t find it, you’ll click the map to place it.") + "</span></div></div>" +
      '<p class="uw-error" id="f-err" role="alert" hidden></p></div>' +
      '<div class="uw-dlg__foot"><button type="button" class="uw-btn uw-btn--ghost" data-act="close">Cancel</button><button type="submit" class="uw-btn uw-btn--primary">' + (editing ? "Save changes" : "Add listing") + "</button></div></form>";
    dlg.showModal();
    setTimeout(() => document.getElementById(editing ? "f-price" : "f-url").focus(), 30);
  };

  function locText(g) {
    const c = UWGeo.classify(g.lat, g.lng);
    return (g.source === "manual" ? "Placed by hand" : "Found: " + E(g.matched || "")) + (g.approximate ? ' <span class="uw-warn">(street only; drag the pin to the house after saving)</span>' : "") +
      " · " + E(UW.areaById[c.area].name) + ", " + E(c.loc) + ", " + c.centerKm.toFixed(2) + " km from the courthouse square";
  }

  function onInput(e) {
    if (e.target.id === "f-url") {
      const a = UWGeo.zillowAddress(e.target.value.trim());
      const hint = document.getElementById("f-url-hint");
      if (a) {
        document.getElementById("f-addr").value = a.address;
        hint.textContent = "Address read from the link: " + a.address;
        const dupe = UW.properties().find((p) => p.id !== (editing && editing.id) && p.url && UWGeo.zillowKey(p.url) === UWGeo.zillowKey(e.target.value.trim()));
        if (dupe) hint.innerHTML = '<span class="uw-warn">' + E(dupe.street) + " is already on this page.</span>";
        found = null;
        document.getElementById("f-loc").textContent = "Not looked up yet.";
      } else if (e.target.value.trim()) hint.textContent = "Couldn’t read an address from this link; type it below.";
    }
    if (e.target.id === "f-addr") found = null;
  }

  async function onClick(e) {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    if (b.dataset.act === "close") { dlg.close(); return; }
    if (b.dataset.act === "find") {
      const addr = document.getElementById("f-addr").value.trim(), out = document.getElementById("f-loc");
      if (!addr) { out.textContent = "Type the address first."; return; }
      out.textContent = "Looking it up on OpenStreetMap…";
      b.disabled = true;
      try {
        found = await A.geocode(addr);
        out.innerHTML = found ? locText(found) : '<span class="uw-warn">No match on OpenStreetMap.</span> After you save, click the map to place it.';
      } catch (err) { out.innerHTML = '<span class="uw-warn">' + E(err.message) + ".</span> After you save, click the map to place it."; }
      b.disabled = false;
    }
  }

  function onSubmit(e) {
    e.preventDefault();
    const g = (id) => document.getElementById(id);
    const v = (id) => (g(id) && g(id).value !== "" ? Number(g(id).value) : null);
    const err = g("f-err");
    const url = g("f-url").value.trim(), address = g("f-addr").value.trim(), price = v("f-price");
    const problems = [];
    if (!address) problems.push("an address");
    if (!(price > 0)) problems.push("a price");
    if (url && !/^https?:\/\/(www\.)?zillow\.com\//i.test(url)) problems.push("a zillow.com link (or leave it blank)");
    if (problems.length) { err.hidden = false; err.textContent = "Please add " + problems.join(", ") + "."; return; }
    const za = UWGeo.zillowAddress(url) || {};
    const parts = address.split(",").map((s) => s.trim());
    const facts = { beds: v("f-beds"), baths: v("f-baths"), sqft: v("f-sqft"), lot: v("f-lot"), projBeds: v("f-pbeds"), projBaths: v("f-pbaths"),
      pool: g("f-pool").checked, hotTub: g("f-tub").checked, why: g("f-why").value };
    const common = { url: url || null, address, street: parts[0], city: parts[1] || za.city || null, zip: (address.match(/\b(\d{5})\b/) || [])[1] || za.zip || null,
      zpid: za.zpid || null, facts, notes: A.buildNotes(facts) };
    let id;
    if (editing) {
      id = editing.id;
      const inputs = UW.clone(editing.listing.inputs);
      inputs.price = price;
      UW.updateListing(id, Object.assign(common, { inputs }, found ? { pin: found } : {}));
    } else {
      const t = UW.templates.find((x) => x.file === g("f-tpl").value);
      const base = t.blank ? t : UW.data.uw.properties.find((p) => p.id === t.pid).versions.find((x) => x.label === t.label);
      const inputs = UW.clone(base.inputs);
      inputs.price = price;
      inputs.revenue = { low: null, mid: null, high: null };
      inputs.setup = UWRules.withStandardSetup(inputs.setup);  // the five lines every sheet carries
      Object.assign(inputs, UWRules.withStandardOpex(inputs));  // every OPEX line priced, never empty
      id = za.zpid ? "z" + za.zpid : "n" + Date.now().toString(36);
      if (UW.property(id)) id += "-" + Date.now().toString(36);
      UW.addListing(Object.assign(common, { id, kind: "new", created: new Date().toISOString().slice(0, 10), template: t.file, templateLabel: t.label, inputs, comps: [],
        pin: found, promoted: false, downloaded: false }));
    }
    dlg.close();
    UW.ui.expanded.add(id);
    UW.cardsApi.renderList();
    UW.select(id, { focus: true });
    if (!found && !UW.property(id).geo) UW.mapApi.startPlace(id, address);
    else if (found && found.approximate) UW.mapApi.startPlace(id, address);
    else document.getElementById("uw-card-" + id).scrollIntoView({ behavior: "smooth", block: "start" });
    UW.toast(editing ? "Saved" : "Added " + common.street + ". Saved in this browser; use Export to share it.");
  }
})();
