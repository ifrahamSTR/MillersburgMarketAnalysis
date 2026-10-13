/**
 * Millersburg underwriting map: 62 Airbnb comps (Cleaned_Data entire homes)
 * drawn on one canvas (L.canvas, no DOM markers); acquisition targets (the
 * Zillow houses) as house markers (underwritten) and pins (new listings), both
 * coloured by low-case cash on cash, each with a hover summary and a popup
 * (Zillow link, numbers, scenario switch, actions); the selected
 * property's nearest comps get rank badges and a faint radius ring, and
 * everything else is dimmed. Area outlines: convex hull of each area's
 * listings, 0.35 km buffer. The village limits (US Census) set the zone, and
 * the 300 m ring round the courthouse marks Downtown.
 */
/* global L, UWGeo */
(function () {
  const UW = window.UW;
  let map, renderer, dots = [], areaLayer, labelLayer, villageLayer, propLayer, badgeLayer, ringLayer, placing = null, legendCtl;
  const M = (UW.mapApi = {});

  UW.colorOf = function (l) {
    const by = UW.ui.colorBy;
    if (by === "tier") return UW.TIER_COLORS[l.sizeTop];
    if (by === "area") return UW.areaById[l.area].color;
    if (by === "loc") return UW.LOC_COLORS[l.loc];
    return UW.REV_BANDS.find((b) => l.revenue >= b[0] && l.revenue < b[1])[3];
  };

  M.init = function () {
    map = L.map("uw-leaflet", { zoomSnap: 0.25, scrollWheelZoom: false, preferCanvas: true, keyboard: true });
    M.map = map;
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);
    L.control.scale({ imperial: true, metric: false }).addTo(map);
    // Scroll-zoom only once the map has been clicked or focused, so the page still scrolls past it.
    map.on("focus click", () => map.scrollWheelZoom.enable());
    map.on("blur mouseout", () => map.scrollWheelZoom.disable());
    renderer = L.canvas({ padding: 0.4, tolerance: 5 });

    areaLayer = L.layerGroup();
    labelLayer = L.layerGroup();
    UW.areas.forEach((a) => {
      L.polygon(a.hull, { color: a.color, weight: 1.6, dashArray: "6 4", fillColor: a.color, fillOpacity: 0.06, interactive: false, renderer }).addTo(areaLayer);
      L.marker(a.label, { interactive: false, keyboard: false, icon: L.divIcon({ className: "uw-area-label", iconSize: [190, 18], iconAnchor: [95, 9], html: '<span style="color:' + a.color + '">' + UW.esc(a.name) + "</span>" }) }).addTo(labelLayer);
    });
    const V = UW.data.village;
    villageLayer = L.layerGroup([
      L.polygon(V.rings, { color: "#22313a", weight: 1.8, dashArray: "2 5", fill: false, interactive: false, renderer }),
      L.circle([V.center.lat, V.center.lng], { renderer, radius: V.downtownKm * 1000, color: UW.LOC_COLORS.Downtown, weight: 1.4, dashArray: "3 4", fill: false, interactive: false }),
      L.marker([V.center.lat, V.center.lng], { interactive: false, keyboard: false, icon: L.divIcon({ className: "uw-area-label uw-village-label", iconSize: [190, 18], iconAnchor: [95, -6], html: "<span>Courthouse square</span>" }) }),
      L.marker([Math.max(...V.rings[0].map((r) => r[0])) + 0.0012, V.center.lng], { interactive: false, keyboard: false, icon: L.divIcon({ className: "uw-area-label uw-village-label", iconSize: [190, 18], iconAnchor: [95, 9], html: "<span>Village limits</span>" }) }),
    ]);

    UW.listings.forEach((l) => {
      const m = L.circleMarker([l.lat, l.lng], { renderer, radius: 5, weight: 1, color: "#fff", fillOpacity: 0.9, bubblingMouseEvents: false });
      m.listing = l;
      m.bindTooltip(() => UW.esc(UW.fmt.k(l.revenue) + " · " + UW.fmt.beds(l.bedrooms) + " · " + l.title), { direction: "top", offset: [0, -4], className: "uw-tip" });
      // Bottom-left padding keeps a popup clear of the legend.
      m.bindPopup(() => listingPopup(l), { maxWidth: 340, minWidth: 260, autoPanPaddingTopLeft: [24, 24], autoPanPaddingBottomRight: [24, 24], autoPanPaddingBottomLeft: [24, 70], className: "uw-popup" });
      m.addTo(map);
      dots.push(m);
    });
    propLayer = L.layerGroup().addTo(map);
    badgeLayer = L.layerGroup().addTo(map);
    ringLayer = L.layerGroup().addTo(map);

    const pts = UW.listings.map((l) => [l.lat, l.lng]);
    map.fitBounds(L.latLngBounds(pts).pad(0.02));
    legendCtl = L.control({ position: "bottomleft" });
    legendCtl.onAdd = () => { const d = L.DomUtil.create("div", "uw-legend"); L.DomEvent.disableClickPropagation(d); L.DomEvent.disableScrollPropagation(d); return d; };
    legendCtl.addTo(map);

    map.on("popupopen", () => { const d = legendCtl.getContainer().querySelector("details"); if (d) d.open = false; });
    map.getContainer().addEventListener("click", onMapClick);
    map.on("click", (e) => { if (placing) finishPlace(e.latlng); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && placing) cancelPlace(); });
    M.layers();
    M.refresh();
  };

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------
  function styleFor(l, state) {
    const c = UW.colorOf(l);
    // Only 62 comps here, so a filtered-out home stays easy to see (grey, smaller, outlined).
    if (state === "ghost") return UW.ui.layers.ghosts ? { radius: 3.4, fillColor: "#8d99a2", fillOpacity: 0.7, color: "#fff", weight: 0.8, opacity: 0.9 } : { radius: 0, fillOpacity: 0, opacity: 0, weight: 0 };
    if (state === "dim") return { radius: 3.6, fillColor: c, fillOpacity: 0.25, color: "#fff", weight: 0.5, opacity: 0.35 };
    if (state === "hl") return { radius: 7.5, fillColor: c, fillOpacity: 1, color: "#0b2f28", weight: 2.2, opacity: 1 };
    if (state === "am") return { radius: 7.5, fillColor: c, fillOpacity: 1, color: amRing(l._amFrac), weight: 4, opacity: 1 };
    if (state === "set") return { radius: 6.5, fillColor: c, fillOpacity: 1, color: "#ecaa4a", weight: 3, opacity: 1 };
    return { radius: 5, fillColor: c, fillOpacity: 0.92, color: "#fff", weight: 1, opacity: 1 };
  }

  // Amenity-mode results: a ring coloured by the share of the profile's preferred amenities the comp has.
  const AM_RING = [[1, "#1B7A43", "all preferred amenities"], [0.75, "#5f9e8f", "most"], [0.5, "#d99132", "about half"], [0, "#8b94a3", "few, or beds / sleeps / pool off"]];
  function amRing(frac) { return (AM_RING.find((r) => frac >= r[0]) || AM_RING[AM_RING.length - 1])[1]; }
  M.amRing = amRing;
  M.refresh = function () {
    if (!map) return;
    const p = UW.ui.selected ? UW.property(UW.ui.selected) : null;
    const near = p ? UW.nearest(p) : [];
    M.lastNearest = near;
    const amMode = p && UW.ui.mode === "amenity" && !UW.ui.pure;
    const hl = new Map(near.map((x) => [x.l.id, x]));
    // Ring: how well an amenity match fits. Bedrooms, sleeps or pool off the profile -> grey, whatever its amenities.
    near.forEach((x) => { x.l._amFrac = x.bedsTier || x.sleepsTier || x.poolOk === false ? -1 : x.info && x.info.prefTotal ? x.info.prefMatched / x.info.prefTotal : 1; });
    const inSet = new Set(p ? UW.activeVersion(p).comps.map((c) => UW.compId(c)).filter(Boolean) : []);
    const front = [];
    dots.forEach((m) => {
      const l = m.listing, match = UW.matchSet.has(l.id);
      let state = !match ? "ghost" : p ? "dim" : "match";
      if (hl.has(l.id)) state = amMode ? "am" : "hl";
      else if (inSet.has(l.id)) state = "set";
      m.setStyle(styleFor(l, state));
      m.options.interactive = !placing && (state !== "ghost" || inSet.has(l.id));  // while placing a pin every click places it
      if (state === "hl" || state === "am" || state === "set") front.push(m);
    });
    front.forEach((m) => m.bringToFront());

    badgeLayer.clearLayers();
    ringLayer.clearLayers();
    near.slice(0, 50).forEach((x) => {
      const b = L.marker([x.l.lat, x.l.lng], { keyboard: false, zIndexOffset: 500, title: "#" + x.rank + " " + x.l.title,
        icon: L.divIcon({ className: "uw-rank" + (amMode ? " uw-rank--am" : "") + (inSet.has(x.l.id) ? " uw-rank--set" : ""), iconSize: [20, 20], iconAnchor: [-3, 22], html: String(x.rank) }) });
      b.on("click", () => openListing(x.l.id));
      b.addTo(badgeLayer);
    });
    if (p && p.geo && near.length && !amMode) {
      const r = UW.ui.radius != null ? UW.ui.radius : near[near.length - 1].d * 1.03;
      // Same canvas as the dots: a second canvas on top would swallow their clicks.
      L.circle([p.geo.lat, p.geo.lng], { renderer, radius: r * 1609.344, color: "#0b4b40", weight: 1.2, dashArray: "4 5", fill: true, fillColor: "#0b4b40", fillOpacity: 0.035, interactive: false })
        .addTo(ringLayer).bringToBack();
    }
    drawProperties(p);
    drawLegend();
  };

  function houseIcon(color, selected, edited) {
    const s = selected ? 40 : 30;
    return L.divIcon({ className: "uw-house" + (selected ? " is-selected" : ""), iconSize: [s, s], iconAnchor: [s / 2, s - 2], popupAnchor: [0, -s + 4],
      html: '<svg viewBox="0 0 32 32" width="' + s + '" height="' + s + '" aria-hidden="true"><path d="M16 2.8 29.2 14.2V29H2.8V14.2Z" fill="' + color + '" stroke="#fff" stroke-width="2.4" stroke-linejoin="round"/>' +
        '<path d="M12.6 29v-7.4h6.8V29" fill="none" stroke="#fff" stroke-width="2"/>' + (edited ? '<circle cx="26" cy="7" r="4.4" fill="#ecaa4a" stroke="#fff" stroke-width="1.6"/>' : "") + "</svg>" });
  }
  function pinIcon(color, selected) {
    const w = selected ? 34 : 26, h = Math.round(w * 1.25);
    return L.divIcon({ className: "uw-pin" + (selected ? " is-selected" : ""), iconSize: [w, h], iconAnchor: [w / 2, h - 1], popupAnchor: [0, -h + 4],
      html: '<svg viewBox="0 0 32 40" width="' + w + '" height="' + h + '" aria-hidden="true"><path d="M16 38.5S28 26.4 28 16.2A12 12 0 0 0 4 16.2C4 26.4 16 38.5 16 38.5Z" fill="' + color + '" stroke="#fff" stroke-width="2.4"/>' +
        '<path d="m16 9 2 4.1 4.5.6-3.3 3.2.8 4.5-4-2.1-4 2.1.8-4.5-3.3-3.2 4.5-.6Z" fill="#fff"/></svg>' });
  }

  // Target markers are kept (not rebuilt) so an open popup survives a redraw, e.g. a scenario switch inside it.
  const targetMarkers = new Map();
  function targetTip(p) {
    const v = UW.activeVersion(p), d = v.details, F = UW.fmt;
    const bb = d.beds != null ? F.num(d.beds) + " / " + F.num(d.baths) : p.listing ? F.num(p.listing.facts.beds) + " / " + F.num(p.listing.facts.baths) : "—";
    const err = UW.compErrors(v).length;
    return "<strong>" + UW.esc(p.street) + "</strong>" + (p.versions.length > 1 ? " · " + UW.esc(UW.scenarioName(v)) : "") + "<br>" + F.money(v.inputs.price) + " · " + bb + " bed / bath projected" +
      "<br>Mid revenue " + F.k(v.inputs.revenue.mid) + " · low-case cash on cash " + F.pct(v.outputs.cases.low.coc) + (err ? '<br><span class="uw-tip__err">' + err + " comp error" + (err === 1 ? "" : "s") + "</span>" : "");
  }
  function drawProperties(sel) {
    const seen = new Set();
    UW.properties().forEach((p) => {
      if (!p.geo) return;
      const isNew = p.kind !== "underwritten";
      if ((isNew && !UW.ui.layers.newl) || (!isNew && !UW.ui.layers.uw)) return;
      seen.add(p.id);
      const v = UW.activeVersion(p), low = v.outputs.cases.low.coc, st = UW.cocStatus(low);
      const selected = sel && sel.id === p.id;
      const icon = isNew ? pinIcon(UW.COC_COLORS[st], selected) : houseIcon(UW.COC_COLORS[st], selected, v.edited.inputs);
      let m = targetMarkers.get(p.id);
      if (!m) {
        m = L.marker([p.geo.lat, p.geo.lng], { icon, keyboard: true, title: p.street, alt: "Acquisition target: " + p.street, riseOnHover: true });
        m.bindTooltip(() => targetTip(UW.property(p.id)), { direction: "top", offset: [0, -24], className: "uw-tip" });
        m.bindPopup(() => targetPopup(UW.property(p.id)), { maxWidth: 380, minWidth: 290, className: "uw-popup uw-popup--target", autoPanPaddingTopLeft: [24, 24], autoPanPaddingBottomLeft: [24, 24] });
        m.on("popupopen", () => m.closeTooltip());
        m.on("dragend", () => { const ll = m.getLatLng(); UW.setPropertyField(p.id, "pin", { lat: +ll.lat.toFixed(6), lng: +ll.lng.toFixed(6), source: "manual" }); });
        m.addTo(propLayer);
        targetMarkers.set(p.id, m);
      } else {
        m.setLatLng([p.geo.lat, p.geo.lng]);
        m.setIcon(icon);
        if (m.isPopupOpen()) m.setPopupContent(targetPopup(p));
      }
      m.setZIndexOffset(selected ? 2000 : 1000);
      const drag = !!(placing && placing.pid === p.id);
      if (m.dragging) { if (drag) m.dragging.enable(); else m.dragging.disable(); }
    });
    targetMarkers.forEach((m, id) => { if (!seen.has(id)) { propLayer.removeLayer(m); targetMarkers.delete(id); } });
    drawNoPin();
  }
  M.openTarget = function (pid) {
    const m = targetMarkers.get(pid);
    if (m) { if (!map.getBounds().contains(m.getLatLng())) map.panTo(m.getLatLng()); m.openPopup(); }
  };

  function targetPopup(p) {
    const v = UW.activeVersion(p), d = v.details, F = UW.fmt, E = UW.esc, o = v.outputs, rev = v.inputs.revenue || {}, L_ = p.listing && p.listing.facts;
    const bb = d.beds != null ? F.num(d.beds) + " / " + F.num(d.baths) : L_ ? F.num(L_.beds) + " / " + F.num(L_.baths) : "—";
    const tgt = v.target.beds != null && (v.target.beds !== d.beds || v.target.baths !== d.baths) ? " (target " + F.num(v.target.beds) + " / " + F.num(v.target.baths) + ")" : "";
    const sqft = d.size != null ? Number(d.size).toLocaleString("en-US") + " sqft" : L_ && L_.sqft ? Number(L_.sqft).toLocaleString("en-US") + " sqft" : null;
    const lot = d.lot != null ? "lot " + Number(d.lot).toLocaleString("en-US") + " sqft" : L_ && L_.lot ? "lot " + Number(L_.lot).toLocaleString("en-US") + " sqft" : null;
    const scen = p.versions.length > 1 ? '<div class="uw-seg uw-seg--sm uw-tpop__scen" role="group" aria-label="Scenario">' + p.versions.map((x) => '<button type="button" data-act="tp-ver" data-pid="' + E(p.id) + '" data-v="' + E(x.label) + '" aria-pressed="' + (x.label === v.label) + '">' + E(UW.scenarioName(x)) + "</button>").join("") + "</div>" : "";
    return '<div class="uw-tpop"><p class="uw-tpop__kicker">Acquisition target' + (p.kind !== "underwritten" ? " · new listing" : "") + (p.versions.length > 1 ? " · " + E(UW.scenarioName(v)) : "") + "</p>" +
      "<h3>" + E(p.street) + "</h3>" +
      (p.url ? '<a class="uw-btn uw-btn--primary uw-tpop__zl" href="' + E(p.url) + '" target="_blank" rel="noopener">Open on Zillow ↗</a>' : "") +
      '<p class="uw-tpop__facts"><strong>' + F.money(v.inputs.price) + "</strong> · " + bb + " bed / bath" + tgt + [sqft, lot].filter(Boolean).map((x) => " · " + x).join("") + "</p>" + scen +
      '<table class="uw-tpop__t"><thead><tr><th></th><th>Low</th><th>Mid</th><th>High</th></tr></thead><tbody>' +
      "<tr><th>Revenue</th>" + ["low", "mid", "high"].map((c) => "<td>" + F.k(rev[c]) + "</td>").join("") + "</tr>" +
      "<tr><th>Cash on cash</th>" + ["low", "mid", "high"].map((c) => '<td class="uw-coc--' + UW.cocStatus(o.cases[c].coc) + '">' + F.pct(o.cases[c].coc) + "</td>").join("") + "</tr></tbody></table>" +
      '<div class="uw-head__badges">' + UW.targetBadges(p, v) + "</div>" +
      (p.versions.length > 1 ? UW.scenarioTable(p, true) : "") +
      '<div class="uw-tpop__acts"><button type="button" class="uw-btn uw-btn--small uw-btn--primary" data-act="tp-rank" data-mode="location" data-pid="' + E(p.id) + '">Match by location</button>' +
      '<button type="button" class="uw-btn uw-btn--small uw-btn--primary" data-act="tp-rank" data-mode="amenity" data-pid="' + E(p.id) + '">Match by amenities</button>' +
      '<button type="button" class="uw-btn uw-btn--small uw-btn--ghost" data-act="tp-card" data-pid="' + E(p.id) + '">Open card</button>' +
      '<button type="button" class="uw-btn uw-btn--small uw-btn--ghost" data-act="tp-copy" data-pid="' + E(p.id) + '"' + (v.comps.length ? "" : " disabled") + ">Copy comps</button>" +
      '<button type="button" class="uw-btn uw-btn--small uw-btn--ghost" data-act="tp-rev" data-pid="' + E(p.id) + '">Copy revenue cases</button>' +
      '<button type="button" class="uw-btn uw-btn--small uw-btn--ghost" data-act="tp-csv" data-pid="' + E(p.id) + '">Download UW CSV</button></div></div>';
  }

  // Targets without a pin get a prompt at the top of the map (they're also listed, tagged, in the panel).
  function drawNoPin() {
    const host = map.getContainer();
    let bar = document.getElementById("uw-nopin-bar");
    const missing = UW.properties().filter((p) => !p.geo);
    if (!missing.length || placing) { if (bar) bar.hidden = true; return; }
    if (!bar) { bar = document.createElement("div"); bar.id = "uw-nopin-bar"; bar.className = "uw-nopin-bar"; host.appendChild(bar); L.DomEvent.disableClickPropagation(bar); L.DomEvent.disableScrollPropagation(bar); }
    bar.hidden = false;
    bar.innerHTML = missing.map((p) => '<span><strong>' + UW.esc(p.street) + "</strong> has no map pin" + (p.geocodeNote ? ' <span class="uw-nopin-bar__why" title="' + UW.esc(p.geocodeNote) + '">(geocoders couldn’t find the house)</span>' : "") +
      '</span><button type="button" class="uw-btn uw-btn--small" data-act="place-target" data-pid="' + UW.esc(p.id) + '">Place this target on the map</button>').join("");
  }

  function drawLegend() {
    const host = legendCtl && legendCtl.getContainer();
    if (!host) return;
    const by = UW.ui.colorBy;
    let items;
    if (by === "tier") items = Object.entries(UW.TIER_LABEL).map(([k, lab]) => [UW.TIER_COLORS[k], lab]);
    else if (by === "area") items = UW.areas.map((a) => [a.color, a.name]);
    else if (by === "loc") items = UW.data.comps.locOrder.map((l) => [UW.LOC_COLORS[l], l]);
    else items = UW.REV_BANDS.map((b) => [b[3], b[2]]);
    const title = { revenue: "Airbnb comps · revenue potential", tier: "Against same-size homes", area: "Area", loc: "Setting" }[by];
    const n = UW.matchSet.size;
    // Collapsed unless opened (state kept across redraws), so it never sits on a popup by default.
    const was = host.querySelector("details");
    const open = was ? was.open : false;
    host.innerHTML = '<details class="uw-legend__box"' + (open ? " open" : "") + "><summary>Legend · " + n + " of " + UW.listings.length + " Airbnb comps shown</summary>" +
      '<p class="uw-legend__t">' + title + "</p>" + items.map((i) => '<span class="uw-legend__i"><i style="background:' + i[0] + '"></i>' + UW.esc(i[1]) + "</span>").join("") +
      '<p class="uw-legend__t">Acquisition targets · colour = low-case cash on cash</p>' +
      '<span class="uw-legend__i"><svg width="14" height="14" viewBox="0 0 32 32" aria-hidden="true"><path d="M16 2.8 29.2 14.2V29H2.8V14.2Z" fill="' + UW.COC_COLORS.good + '"/></svg>Underwritten target · 4%+</span>' +
      '<span class="uw-legend__i"><svg width="14" height="14" viewBox="0 0 32 32" aria-hidden="true"><path d="M16 2.8 29.2 14.2V29H2.8V14.2Z" fill="' + UW.COC_COLORS.warn + '"/></svg>0–4%</span>' +
      '<span class="uw-legend__i"><svg width="14" height="14" viewBox="0 0 32 32" aria-hidden="true"><path d="M16 2.8 29.2 14.2V29H2.8V14.2Z" fill="' + UW.COC_COLORS.bad + '"/></svg>below 0%</span>' +
      '<span class="uw-legend__i"><svg width="12" height="15" viewBox="0 0 32 40" aria-hidden="true"><path d="M16 38.5S28 26.4 28 16.2A12 12 0 0 0 4 16.2C4 26.4 16 38.5 16 38.5Z" fill="' + UW.COC_COLORS.none + '"/></svg>New-listing target (grey = no revenue yet)</span>' +
      '<span class="uw-legend__i"><i class="uw-legend__ring"></i>In the selected comp set</span>' +
      (UW.ui.selected && UW.ui.mode === "amenity" && !UW.ui.pure ? '<p class="uw-legend__t">Amenity matches, best to worst · ring = how well it fits</p>' +
        AM_RING.map((r) => '<span class="uw-legend__i"><i class="uw-legend__am" style="--r:' + r[1] + '"></i>' + r[2] + "</span>").join("") : "") +
      (UW.ui.layers.ghosts ? '<span class="uw-legend__i"><i style="background:#8d99a2;width:7px;height:7px"></i>Filtered out (e.g. under the revenue floor)</span>' : "") + "</details>";
  }

  M.layers = function () {
    const Ly = UW.ui.layers;
    [[areaLayer, Ly.areas], [labelLayer, Ly.areas && Ly.labels], [villageLayer, Ly.village]].forEach(([layer, on]) => {
      if (on && !map.hasLayer(layer)) layer.addTo(map);
      if (!on && map.hasLayer(layer)) map.removeLayer(layer);
    });
    if (map.hasLayer(areaLayer)) areaLayer.eachLayer((l) => l.bringToBack && l.bringToBack());
    M.refresh();
  };

  // ---------------------------------------------------------------------------
  // Focus / popups
  // ---------------------------------------------------------------------------
  M.focus = function (pid) {
    const p = UW.property(pid);
    if (!p) return;
    const near = UW.nearest(p);
    const pts = (p.geo ? [[p.geo.lat, p.geo.lng]] : []).concat(near.map((x) => [x.l.lat, x.l.lng]));
    if (!pts.length) return;
    if (pts.length > 1) map.flyToBounds(L.latLngBounds(pts).pad(0.12), { maxZoom: 15.5, duration: 0.7 });
    else map.flyTo([p.geo.lat, p.geo.lng], 15, { duration: 0.7 });
  };
  M.invalidate = () => map && map.invalidateSize();

  function openListing(id) {
    const m = dots.find((d) => d.listing.id === id);
    if (!m) return;
    if (!map.getBounds().contains(m.getLatLng())) map.panTo(m.getLatLng());
    m.openPopup();
  }
  M.openListing = openListing;

  function listingPopup(l) {
    const p = UW.ui.selected ? UW.property(UW.ui.selected) : null;
    const v = p && UW.activeVersion(p);
    const inSet = v && v.comps.some((c) => UW.compId(c) === l.id);
    const full = v && v.comps.length >= 15;
    const d = p && p.geo ? UWGeo.miles(p.geo.lat, p.geo.lng, l.lat, l.lng) : null;
    const a = UW.areaById[l.area];
    const row = (k, val) => "<dt>" + k + "</dt><dd>" + val + "</dd>";
    const amen = UW.ICON_ORDER.concat(["movie_theater", "golf_simulator", "gym", "outdoor_dining_area", "crib", "pack_n_play_travel_crib", "lake_access"]).filter((k) => l.flagSet.has(k));
    let btn;
    if (!p) btn = '<p class="uw-pop__hint">Select an acquisition target to add this comp to its comp set.</p>';
    else if (inSet) btn = '<button type="button" class="uw-btn uw-btn--ghost" data-act="pop-remove" data-id="' + l.id + '">In the comp set for ' + UW.esc(p.street) + " · remove</button>";
    else if (full) btn = '<p class="uw-pop__hint">The comp set for ' + UW.esc(p.street) + " already has 15 rows (the sheet's limit).</p>";
    else btn = '<button type="button" class="uw-btn uw-btn--primary" data-act="pop-add" data-id="' + l.id + '">Add to comp set for ' + UW.esc(p.street) + "</button>";
    btn += '<button type="button" class="uw-btn uw-btn--ghost" data-act="pop-copy" data-id="' + l.id + '">Copy row</button>' +
      '<p class="uw-pop__hint">Copy row = the sheet’s 15 columns, note: ' + UW.esc(UW.noteFor(l, p)) + "</p>";
    return '<div class="uw-pop"><p class="uw-pop__kicker">Airbnb comp' + (l.quality === "Possibly Good" ? ' · <span class="uw-tag uw-tag--possibly">possibly good</span>' : "") + '</p><a class="uw-pop__title" href="' + UW.esc(l.url) + '" target="_blank" rel="noopener">' + UW.esc(l.title) + ' <span aria-hidden="true">↗</span></a>' +
      '<p class="uw-pop__rev"><strong>' + UW.fmt.money(l.revenue) + '</strong> revenue potential · <span class="uw-pop__tier" style="--c:' + UW.TIER_COLORS[l.sizeTop] + '">' + UW.TIER_LABEL[l.sizeTop] + "</span></p>" +
      '<dl class="uw-pop__dl">' +
      row("Earns vs. a typical home its size", UW.fmt.x(l.vsSize) + " the " + UW.esc(l.size.replace("Studio-1BR", "studio–1BR")) + " median") +
      row("Nightly rate · occupancy", UW.fmt.money2(l.adr) + " · " + UW.fmt.pct(l.occ, 1)) +
      row("Bedrooms · baths · sleeps · beds", UW.fmt.beds(l.bedrooms) + " · " + UW.fmt.num(l.baths) + " · " + UW.fmt.num(l.sleeps) + " · " + UW.fmt.num(l.beds)) +
      row("Setting", UW.esc(l.loc) + " · pin " + UW.fmt.km(l.centerKm) + " from the courthouse square") +
      row("Area", '<span class="region-dot" style="background:' + a.color + '"></span>' + UW.esc(a.name) + " · ZIP " + UW.esc(l.zip || "—")) +
      row("Rating", UW.fmt.num(l.rating) + " from " + (l.reviews == null ? "—" : l.reviews) + " reviews") +
      row("Data quality · listing", UW.esc(l.quality || "—") + " · " + UW.esc(l.status || "—") + (l.fav ? " · guest favourite" : "")) +
      row("Reviews: with kids · group trips", (l.kids == null ? "—" : Math.round(l.kids) + "%") + " · " + (l.group == null ? "—" : Math.round(l.group) + "%")) +
      row("Market-wide tier", { top10: "Top 10% of the market", top25: "Top 25% of the market", bottom75: "Below the top 25%" }[l.tier]) +
      (d != null ? row("Distance to " + UW.esc(p.street), UW.fmt.mi(d)) : "") +
      "</dl>" +
      '<p class="uw-pop__amen">' + (amen.length ? amen.map((k) => (UW.ICON_SVG[k] ? UW.icon(k) : "") + '<span class="uw-pop__amen-l">' + UW.esc(UW.AMEN_LABEL[k]) + "</span>").join("") : '<span class="muted">No amenity flags</span>') + "</p>" +
      btn + "</div>";
  }

  function onMapClick(e) {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act, id = b.dataset.id;
    const pid = b.dataset.pid;
    if (act === "pop-add" || act === "pop-remove") {
      const p = UW.property(UW.ui.selected), v = UW.activeVersion(p), l = UW.byId.get(id);
      if (act === "pop-add") UW.addComp(p.id, v.label, l);
      else UW.actions.removeComp(p.id, v.label, id);
      map.closePopup();
    }
    if (act === "pop-copy") UW.copyListings([UW.byId.get(id)], UW.ui.selected ? UW.property(UW.ui.selected) : null, "");
    if (act === "tp-ver") UW.setVersion(pid, b.dataset.v);
    if (act === "tp-rank") { map.closePopup(); UW.actions.rank(pid, b.dataset.mode); }
    if (act === "tp-card") { map.closePopup(); UW.actions.openCard(pid); }
    if (act === "tp-copy") UW.actions.copyComps(pid);
    if (act === "tp-rev") UW.actions.copyRevenue(pid);
    if (act === "tp-csv") UW.actions.downloadCsv(pid);
    if (act === "place-target") M.startPlace(pid);
    if (act === "place-cancel") cancelPlace();
  }

  // ---------------------------------------------------------------------------
  // Placing / adjusting a pin
  // ---------------------------------------------------------------------------
  M.startPlace = function (pid, label) {
    placing = { pid, label };
    map.closePopup();
    map.getContainer().classList.add("is-placing");
    const p = UW.property(pid);
    let bar = document.getElementById("uw-place-bar");
    if (!bar) { bar = document.createElement("div"); bar.id = "uw-place-bar"; bar.className = "uw-place-bar"; map.getContainer().appendChild(bar); L.DomEvent.disableClickPropagation(bar); }
    bar.innerHTML = "<span>" + (p && p.geo ? "Drag the marker for <strong>" + UW.esc(label || p.street) + "</strong> or click the map to move it." : "Click the map where <strong>" + UW.esc(label || (p && p.street) || "the property") + "</strong> is.") +
      '</span> <button type="button" class="uw-btn uw-btn--small" data-act="place-cancel">Done</button>';
    bar.hidden = false;
    drawNoPin();
    document.getElementById("uw-map").scrollIntoView({ behavior: "smooth", block: "start" });
    if (p && p.geo) map.flyTo([p.geo.lat, p.geo.lng], Math.max(map.getZoom(), 16), { duration: 0.6 });
    M.refresh();
  };
  function finishPlace(ll) {
    const pid = placing.pid;
    UW.setPropertyField(pid, "pin", { lat: +ll.lat.toFixed(6), lng: +ll.lng.toFixed(6), source: "manual" });
    UW.toast("Pin placed. Drag it to fine-tune, then press Done.");
    M.refresh();
  }
  function cancelPlace() {
    placing = null;
    map.getContainer().classList.remove("is-placing");
    const bar = document.getElementById("uw-place-bar");
    if (bar) bar.hidden = true;
    M.refresh();
    UW.emit("places");
  }
})();
