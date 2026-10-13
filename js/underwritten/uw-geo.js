/**
 * Location rules for underwritten.html, the same as the Python pipeline
 * (../notebooks/market_common.py and scripts/build_underwritten.py):
 *  - zone: Village when the point is inside the Millersburg village limits
 *    (data/village.json, US Census TIGER; even-odd over its rings), else Countryside;
 *  - setting: Downtown (in the village, within 300 m of the Holmes County
 *    Courthouse), Village (the rest of the village), Countryside;
 *  - distance to the courthouse square on market_common's local km projection;
 *  - area: the nearest Airbnb listing's (61 of 62 listings, leave-one-out);
 *  - Zillow address from the URL slug.
 * Runs in the browser (window.UWGeo) and in Node; tests/test_underwritten.mjs
 * checks it against the build on every point of tests/fixtures/place_check.json.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.UWGeo = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const COS = Math.cos((40.55 * Math.PI) / 180);
  const xy = (lat, lng) => [(lng + 81.9) * 111 * COS, (lat - 40.55) * 111];
  const CITIES = ["Walnut Creek", "Mount Hope", "Big Prairie", "Millersburg", "Berlin", "Killbuck", "Holmesville", "Charm", "Winesburg", "Glenmont",
    "Loudonville", "Sugarcreek", "Fredericksburg", "Nashville", "Baltic", "Benton", "Lakeville", "Wilmot", "Dundee", "Shreve"];

  let rings = [], center = null, downtownKm = 0.3, pts = null;
  function init(village, listings) {
    rings = village.rings;
    center = xy(village.center.lat, village.center.lng);
    downtownKm = village.downtownKm;
    pts = listings.map((l) => ({ xy: xy(l.lat, l.lng), area: l.area }));
  }

  // Even-odd ray casting over every ring, as matplotlib's contains_points per ring XORed together.
  function inVillage(lat, lng) {
    let inside = false;
    rings.forEach((r) => {
      let c = false;
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const yi = r[i][0], xi = r[i][1], yj = r[j][0], xj = r[j][1];
        if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) c = !c;
      }
      if (c) inside = !inside;
    });
    return inside;
  }

  function centerKm(lat, lng) {
    const [x, y] = xy(lat, lng);
    return Math.hypot(x - center[0], y - center[1]);
  }

  function areaOf(lat, lng) {
    const [x, y] = xy(lat, lng);
    let best = null, bestD = Infinity;
    pts.forEach((p) => {
      const d = (p.xy[0] - x) ** 2 + (p.xy[1] - y) ** 2;
      if (d < bestD) { bestD = d; best = p.area; }
    });
    return best;
  }

  function classify(lat, lng) {
    const village = inVillage(lat, lng), km = centerKm(lat, lng);
    const loc = !village ? "Countryside" : km <= downtownKm ? "Downtown" : "Village";
    return { centerKm: Math.round(km * 1000) / 1000, area: areaOf(lat, lng), town: village, zone: village ? "Village" : "Countryside", loc };
  }

  // Great-circle miles, for the nearest-comp list.
  function miles(lat1, lng1, lat2, lng2) {
    const R = 3958.8, rad = Math.PI / 180;
    const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lng2 - lng1) * rad) / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function zillowAddress(url) {
    let path = "";
    try { path = new URL(url).pathname; } catch (e) { return null; }
    const m = path.match(/\/homedetails\/([^/]+)\/(\d+)_zpid/);
    if (!m) return null;
    let tok = m[1].split("-");
    let state = "OH", zip = null;
    if (tok.length >= 4 && /^[A-Z]{2}$/.test(tok[tok.length - 2]) && /^\d{5}$/.test(tok[tok.length - 1])) {
      state = tok[tok.length - 2]; zip = tok[tok.length - 1]; tok = tok.slice(0, -2);
    }
    let city = null;
    for (const c of CITIES) {
      const ct = c.split(" ");
      if (tok.slice(-ct.length).map((t) => t.toLowerCase()).join(" ") === c.toLowerCase()) { city = c; tok = tok.slice(0, -ct.length); break; }
    }
    if (!city && tok.length > 1) { city = tok[tok.length - 1]; tok = tok.slice(0, -1); }
    const st = [];
    tok.forEach((t) => { if (st.length && t === "2" && st[st.length - 1] === "1") st[st.length - 1] = "1/2"; else st.push(t); });
    const street = st.join(" ");
    return { zpid: m[2], street, city, state, zip, address: street + ", " + city + ", " + state + (zip ? " " + zip : "") };
  }

  function zillowKey(url) {
    try {
      const u = new URL(url);
      return (u.host.replace(/^www\./, "") + u.pathname.replace(/\/+$/, "")).toLowerCase();
    } catch (e) { return null; }
  }

  return { xy, init, inVillage, centerKm, areaOf, classify, miles, zillowAddress, zillowKey };
});
