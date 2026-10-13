/**
 * Bootstraps underwritten.html (Millersburg): loads the data, restores filters / selection
 * from the URL hash, starts the map, panel, cards, add-listing dialog and
 * data checks, and wires the re-render events between them.
 */
(function () {
  const UW = window.UW, F = UW.fmt;

  function renderHero() {
    const props = UW.properties(), uw = props.filter((p) => p.kind !== "new"), nl = props.filter((p) => p.kind === "new");
    const meets = uw.filter((p) => UW.cocStatus(UW.activeVersion(p).outputs.cases.low.coc) === "good").length;
    const screen = uw.filter((p) => { const v = UW.activeVersion(p); return v.inputs.price && v.inputs.revenue.mid / v.inputs.price >= UW.SCREEN; }).length;
    const C = UW.data.comps, nMin = UW.listings.filter((l) => l.revenue >= UW.MIN_REV).length;
    const nVillage = UW.listings.filter((l) => l.town).length;
    const tile = (v, l) => '<div class="uw-hstat"><strong>' + v + "</strong><span>" + l + "</span></div>";
    document.getElementById("uw-hero-stats").innerHTML = (uw.length ?
      tile(uw.length, "acquisition targets underwritten") + tile(meets + " of " + uw.length, "meet the 4% low-case cash-on-cash target") +
      tile(screen + " of " + uw.length, "pass the 20% revenue-to-price screen (mid case)") :
      tile(UW.listings.length, "Airbnb comps: every entire home in the workbook’s Cleaned_Data") +
      tile(nVillage + " · " + (UW.listings.length - nVillage), "inside the village limits · out in the countryside") +
      tile(nl.length, nl.length === 1 ? "acquisition target added so far (new listing)" : "acquisition targets added so far (new listings)")) +
      tile(nMin, "Airbnb comps earning " + F.k(UW.MIN_REV) + "+, the default floor (the market median is " + F.k(C.marketMedian) + ")");
    const files = UW.data.uw.generatedFrom.files.map((f) => (f.match(/- (\d+)/) || [])[1]).filter((x, i, a) => x && a.indexOf(x) === i);
    document.getElementById("uw-footer").innerHTML = (files.length ? "Underwriting from the “New Market UW’ing” Google Sheets (files " + files.join(", ") + "). " :
      "No Millersburg underwriting sheets yet; new listings start from a blank copy of the “New Market UW’ing” sheet. ") +
      "Comps from " + UW.esc(C.source.split(",")[0]) + ", snapshot " + UW.esc(C.snapshot) + ", entire homes only. Revenue figures are gross Revenue Potential; the revenue cases are the analyst’s own. " +
      "Village limits: US Census TIGER. " +
      'Map data &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>.';
  }

  function initNav() {
    const links = [...document.querySelectorAll(".site-nav a[href^='#']")];
    const obs = new IntersectionObserver((entries) => entries.forEach((en) => {
      if (!en.isIntersecting) return;
      links.forEach((l) => l.classList.toggle("site-nav__link--active", l.getAttribute("href") === "#" + en.target.id));
    }), { rootMargin: "-40% 0px -55% 0px" });
    links.forEach((l) => { const s = document.querySelector(l.getAttribute("href")); if (s) obs.observe(s); });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    try {
      await UW.load();
    } catch (e) {
      document.getElementById("uw-boot").innerHTML = '<p class="uw-error">The page data didn’t load (' + UW.esc(e.message) + "). If you opened the file directly, serve the folder instead: <code>python -m http.server</code>.</p>";
      return;
    }
    UW._hashLock = true;
    UW.readHash();
    UW._hashLock = false;
    UW.refilter();
    document.getElementById("uw-boot").remove();

    UW.mapApi.init();
    UW.panelApi.init();
    UW.cardsApi.init();
    UW.addApi.init();
    UW.checksApi.init();
    renderHero();
    initNav();

    let t = null;
    const refresh = () => { clearTimeout(t); t = setTimeout(() => UW.mapApi.refresh(), 40); };
    ["filters", "near", "comps", "places", "listings", "profile"].forEach((ev) => UW.on(ev, refresh));
    UW.on("property", refresh);
    UW.on("mode", () => { if (UW.ui.selected) setTimeout(() => UW.mapApi.focus(UW.ui.selected), 60); });
    UW.on("property", () => renderHero());
    UW.on("listings", () => renderHero());
    UW.on("select", (e) => {
      UW.mapApi.refresh();
      if (e.pid) UW.mapApi.focus(e.pid);  // from the map or a card: zoom to it and its nearest comps
      UW.panelApi.showTab("comps");
    });
    window.addEventListener("hashchange", () => {
      if (!location.hash.includes("=")) return;  // a plain section anchor (nav link), not a shared view
      UW._hashLock = true; UW.readHash(); UW._hashLock = false;
      UW.refilter();
      UW.panelApi.renderAll(); UW.mapApi.refresh();
      if (UW.ui.selected) UW.mapApi.focus(UW.ui.selected);
    });
    window.addEventListener("resize", () => UW.mapApi.invalidate());
    // Arriving from a property link (main page) opens on the map; "#uw-checks" lands on the checks.
    if (UW.ui.selected) {
      document.getElementById("uw-map").scrollIntoView({ block: "start" });
      setTimeout(() => UW.mapApi.focus(UW.ui.selected), 200);
    } else if (location.hash === "#uw-checks") document.getElementById("uw-checks").scrollIntoView({ block: "start" });
  });
})();
