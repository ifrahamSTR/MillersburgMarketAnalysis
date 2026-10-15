/**
 * Read and write the "New Market UW'ing" sheet as CSV, the way Google Sheets
 * exports it: CRLF between rows, LF inside quoted cells, a field quoted only
 * when it holds a comma, quote or line break, no trailing newline.
 *
 * exportSheet() starts from a source CSV's exact text and replaces only the
 * input cells (notes, URL, price, DP%, rate, closing %, setup items, OPEX
 * items, Low/Mid/High revenue, comp rows). Every row that holds no input is
 * copied byte-for-byte from the source, so the amortization block (from its
 * "Loan Amount / Interest Rate / Amortization Years" rows to the last month
 * row) is never rebuilt, recomputed or reformatted. Calculated cells keep
 * the source's values until the inputs are entered in the Google Sheet.
 * Runs in the browser (window.UWCsv) and in Node (tests).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.UWCsv = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const COMP_HEADER = ["Listing URL", "Revenue Potential", "Bedrooms", "Sleeps", "ADR", "Occupancy", "HAS_hot_tub", "HAS_pool",
    "HAS_game_room", "HAS_pickleball", "HAS_mini_golf", "HAS_sauna", "HAS_playground", "HAS_waterfront", "Notes"];
  const SHEET_FLAGS = COMP_HEADER.filter((h) => h.startsWith("HAS_")).map((h) => h.slice(4));

  // Parse into rows of cells, keeping each row's exact source text.
  function parse(text) {
    const rows = [], spans = [];
    let row = [], cell = "", i = 0, start = 0, inQ = false;
    const n = text.length;
    while (i < n) {
      const ch = text[i];
      if (inQ) {
        if (ch === '"') {
          if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
          inQ = false; i++; continue;
        }
        cell += ch; i++; continue;
      }
      if (ch === '"') { inQ = true; i++; continue; }
      if (ch === ",") { row.push(cell); cell = ""; i++; continue; }
      if (ch === "\r" && text[i + 1] === "\n") {
        row.push(cell); rows.push(row); spans.push(text.slice(start, i));
        row = []; cell = ""; i += 2; start = i; continue;
      }
      if (ch === "\n") {
        row.push(cell); rows.push(row); spans.push(text.slice(start, i));
        row = []; cell = ""; i++; start = i; continue;
      }
      cell += ch; i++;
    }
    if (start < n || row.length || cell) { row.push(cell); rows.push(row); spans.push(text.slice(start)); }
    const eol = text.indexOf("\r\n") >= 0 ? "\r\n" : "\n";
    return { rows, spans, eol, trailing: /\r?\n$/.test(text) };
  }

  function field(c) {
    c = c == null ? "" : String(c);
    return /[",\r\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c;
  }
  const serializeRow = (r) => r.map(field).join(",");

  // ---- Cell formats used by the sheet ----------------------------------------
  const group = (n, d) => Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  // Accounting: " $ 589,000 ", " $ (11,778)", " $ -   "
  function acct(v) {
    if (v == null || v === "") return "";
    const n = Math.round(Number(v));
    if (n === 0) return " $ -   ";
    return n < 0 ? " $ (" + group(n, 0) + ")" : " $ " + group(n, 0) + " ";
  }
  const pctCell = (v, d) => (v == null || v === "" ? "" : (Number(v) * 100).toFixed(d) + "%");
  const plainNum = (v) => (v == null || v === "" ? "" : String(Math.round(Number(v) * 100) / 100));
  const dollars2 = (v) => (v == null || v === "" ? "" : (Number(v) < 0 ? "-$" : "$") + group(Number(v), 2));

  // ---- Locate input cells by label ---------------------------------------------
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
  function find(rows, label, opts) {
    opts = opts || {};
    const want = norm(label);
    for (let i = opts.start || 0; i < rows.length; i++) {
      for (let j = 0; j < rows[i].length; j++) {
        if (opts.col != null && j !== opts.col) continue;
        const v = norm(rows[i][j]);
        if (v === want || (opts.prefix && v.startsWith(want))) return [i, j];
      }
    }
    return null;
  }
  function must(hit, what) {
    if (!hit) throw new Error("Template check failed: can't find '" + what + "' in the source CSV");
    return hit;
  }

  function locate(rows) {
    const L = {};
    const an = must(find(rows, "Analyst Notes"), "Analyst Notes");
    L.notes = [an[0] + 1, an[1]];
    const pu = must(find(rows, "PROPERTY URL:"), "PROPERTY URL:");
    L.url = [pu[0], pu[1] + 1];
    const pd = must(find(rows, "Purchase Details"), "Purchase Details");
    const pc = pd[1];
    const at = (label, off, prefix) => { const h = must(find(rows, label, { start: pd[0], col: pc, prefix }), label); return [h[0], pc + off]; };
    L.price = at("Purchase Price", 2);
    L.dpPct = at("Down Payment", 1);
    L.rate = at("Interest Rate", 2);
    L.closingPct = at("Closing Costs", 1);
    const sh = must(find(rows, "Optimzation List", { prefix: true }) || find(rows, "Optimization List", { prefix: true }), "Optimzation List");
    const st = must(find(rows, "Total", { start: sh[0] + 1, col: sh[1] }), "setup Total");
    L.setup = { col: sh[1], first: sh[0] + 1, last: st[0] - 1 };
    const oh = must(find(rows, "Operating Expenses (OPEX)"), "Operating Expenses (OPEX)");
    const ot = must(find(rows, "Total Operating Expenses", { start: oh[0] + 1, col: oh[1] }), "Total Operating Expenses");
    L.opex = { col: oh[1], first: oh[0] + 1, last: ot[0] - 1 };
    const cc = must(find(rows, "Cleaning Cost"), "Cleaning Cost");
    const tn = must(find(rows, "# of Turns"), "# of Turns");
    L.cleaningCost = [cc[0] + 1, cc[1]];
    L.cleaningTurns = [tn[0] + 1, tn[1]];
    for (let i = 0; i < rows.length && !L.revenue; i++) {
      for (let j = 0; j + 2 < rows[i].length; j++) {
        if (norm(rows[i][j]) === "low" && norm(rows[i][j + 1]) === "mid" && norm(rows[i][j + 2]) === "high") {
          const fr = must(find(rows, "Forecasted Revenue", { start: i + 1, col: pc }), "Forecasted Revenue");
          L.revenue = [[fr[0], j], [fr[0], j + 1], [fr[0], j + 2]];
          break;
        }
      }
    }
    must(L.revenue, "Low / Mid / High");
    const ch = must(find(rows, "Listing URL"), "Listing URL");
    const header = COMP_HEADER.map((_, k) => (rows[ch[0]][ch[1] + k] || "").trim());
    if (header.join("|") !== COMP_HEADER.join("|")) throw new Error("Template check failed: comp table columns are not the expected 15");
    L.comps = { col: ch[1], first: ch[0] + 1, last: ch[0] + 15 };
    // Amortization block: the "Loan Amount" below the purchase block, to the last month row.
    let am = find(rows, "Loan Amount", { start: L.price[0] + 1 });
    while (am && am[1] === pc) am = find(rows, "Loan Amount", { start: am[0] + 1 });
    must(am, "amortization Loan Amount");
    const mo = must(find(rows, "Month", { start: am[0], col: am[1] }), "Month");
    let last = mo[0];
    for (let i = mo[0] + 1; i < rows.length; i++) if (/^\d+$/.test((rows[i][am[1]] || "").trim())) last = i;
    L.amort = { first: am[0], last };
    return L;
  }

  /**
   * Which setup slot (row offset within the Optimzation List) each setup item goes in, so items
   * stay in the sheet's own rows: an item's saved slot ("row") first, then the slot where the
   * source holds the same label, then the first free slot from the top. Returns slot -> item
   * index (-1 = empty).
   */
  function placeSetup(rows, L, items) {
    const slots = L.setup.last - L.setup.first + 1;
    if (items.length > slots) throw new Error("The sheet has room for " + slots + " setup items");
    const at = new Array(slots).fill(-1), rest = [], left = [];
    items.forEach((it, k) => {
      const r = it && Number.isInteger(it.row) ? it.row : -1;
      if (r >= 0 && r < slots && at[r] < 0) at[r] = k; else rest.push(k);
    });
    rest.forEach((k) => {
      const lab = norm(items[k] && items[k].label);
      let hit = -1;
      if (lab) for (let r = 0; r < slots; r++) if (at[r] < 0 && norm((rows[L.setup.first + r] || [])[L.setup.col]) === lab) { hit = r; break; }
      if (hit >= 0) at[hit] = k; else left.push(k);
    });
    left.forEach((k) => { at[at.indexOf(-1)] = k; });
    return at;
  }

  // Rows that hold input cells; every other row is copied from the source text.
  function inputRows(L) {
    const s = new Set([L.notes[0], L.url[0], L.price[0], L.dpPct[0], L.rate[0], L.closingPct[0], L.cleaningCost[0], L.cleaningTurns[0], L.revenue[0][0]]);
    for (let i = L.setup.first; i <= L.setup.last; i++) s.add(i);
    for (let i = L.opex.first; i <= L.opex.last; i++) s.add(i);
    for (let i = L.comps.first; i <= L.comps.last; i++) s.add(i);
    return s;
  }

  /**
   * model: { notes, url, price, dpPct, rate, closingPct, setup:[{label, amount}],
   *   opex:[{label, amount, cleaning}], cleaningCost, cleaningTurns,
   *   revenue:{low, mid, high}, comps:[{url, revenue, bedrooms, sleeps, adr, occupancy, flags:{...}, notes}] }
   */
  function exportSheet(sourceText, model) {
    const src = parse(sourceText);
    const rows = src.rows.map((r) => r.slice());
    const L = locate(rows);
    if (L.amort.first <= L.comps.last) throw new Error("Template check failed: the amortization block overlaps the input rows");
    const set = (rc, v) => {
      while (rows[rc[0]].length <= rc[1]) rows[rc[0]].push("");
      rows[rc[0]][rc[1]] = v;
    };
    if (model.notes != null) set(L.notes, model.notes);
    if (model.url != null) set(L.url, model.url);
    if (model.price != null) set(L.price, acct(model.price));
    if (model.dpPct != null) set(L.dpPct, pctCell(model.dpPct, 0));
    if (model.rate != null) set(L.rate, pctCell(model.rate, 2));
    if (model.closingPct != null) set(L.closingPct, pctCell(model.closingPct, 2));

    if (model.setup) {
      // Items keep their own rows (see placeSetup); blank rows stay blank.
      const at = placeSetup(rows, L, model.setup);
      at.forEach((k, r) => {
        const it = k >= 0 ? model.setup[k] : null;
        set([L.setup.first + r, L.setup.col], it ? it.label || "" : "");
        set([L.setup.first + r, L.setup.col + 1], it ? acct(it.amount) : "");
      });
    }
    if (model.opex) {
      // OPEX lines keep their template rows; values are matched by label.
      const byLabel = {};
      model.opex.forEach((o) => (byLabel[norm(o.label)] = o));
      for (let i = L.opex.first; i <= L.opex.last; i++) {
        const lab = norm(rows[i][L.opex.col]);
        if (!lab || !(lab in byLabel)) continue;
        const o = byLabel[lab];
        const amt = o.cleaning && model.cleaningCost != null && model.cleaningTurns != null ? model.cleaningCost * model.cleaningTurns : o.amount;
        // An empty value, or a zero on a line the source left blank, stays blank, unless the page filled
        // the line in as a standard default (o.std): then a zero is written as the sheet's "$ -".
        const prev = rows[i][L.opex.col + 1];
        set([i, L.opex.col + 1], amt == null || amt === "" || (Number(amt) === 0 && prev === "" && !o.std) ? "" : acct(amt));
      }
      // Left out of the model = keep the source's cell; null = cleared (the blank template's inputs).
      if (model.cleaningCost !== undefined) set(L.cleaningCost, model.cleaningCost == null ? "" : acct(model.cleaningCost));
      if (model.cleaningTurns !== undefined) set(L.cleaningTurns, model.cleaningTurns == null ? "" : plainNum(model.cleaningTurns));
    }
    if (model.revenue) ["low", "mid", "high"].forEach((c, k) => set(L.revenue[k], model.revenue[c] == null ? "" : acct(model.revenue[c])));
    if (model.comps) {
      if (model.comps.length > 15) throw new Error("The comp table holds 15 rows");
      const comps = sortComps(model.comps);
      for (let k = 0; k < 15; k++) {
        const c = comps[k];
        const cells = c ? [c.url, c.revenue == null ? "" : dollars2(c.revenue), plainNum(c.bedrooms), plainNum(c.sleeps), c.adr == null ? "" : dollars2(c.adr),
          c.occupancy == null ? "" : pctCell(c.occupancy, 2)].concat(SHEET_FLAGS.map((f) => String(c.flags && c.flags[f] ? 1 : 0)), [c.notes || ""]) : COMP_HEADER.map(() => "");
        cells.forEach((v, j) => set([L.comps.first + k, L.comps.col + j], v));
      }
    }
    const inRows = inputRows(L);
    const out = rows.map((r, i) => {
      if (!inRows.has(i)) return src.spans[i];
      const s = serializeRow(r);
      return s;
    });
    return out.join(src.eol) + (src.trailing ? src.eol : "");
  }

  // The exact text of the amortization block, for the byte-for-byte test.
  function amortBlock(text) {
    const p = parse(text);
    const L = locate(p.rows);
    return p.spans.slice(L.amort.first, L.amort.last + 1).join(p.eol);
  }

  /**
   * Comp order everywhere (tables, lists' copies, Download UW CSV): the sheet's
   * Revenue Potential high -> low (the value the row carries into the sheet),
   * ties by ADR high -> low; stable otherwise. Rows without revenue go last.
   */
  function sortComps(comps) {
    const v = (x) => (x == null || x === "" || isNaN(x) ? -Infinity : Number(x));
    return comps.map((c, i) => [c, i]).sort((a, b) => v(b[0].revenue) - v(a[0].revenue) || v(b[0].adr) - v(a[0].adr) || a[1] - b[1]).map((x) => x[0]);
  }

  // Tab-separated comp rows for pasting into the sheet (no header), always revenue-descending.
  function compsTSV(comps) {
    const clean = (s) => String(s == null ? "" : s).replace(/[\t\r\n]+/g, " ").trim();
    return sortComps(comps).map((c) => [c.url, c.revenue == null ? "" : Math.round(c.revenue), plainNum(c.bedrooms), plainNum(c.sleeps),
      c.adr == null ? "" : Number(c.adr).toFixed(2), c.occupancy == null ? "" : (c.occupancy * 100).toFixed(2) + "%"]
      .concat(SHEET_FLAGS.map((f) => (c.flags && c.flags[f] ? 1 : 0)), [clean(c.notes)]).join("\t")).join("\n");
  }

  return { COMP_HEADER, SHEET_FLAGS, parse, serializeRow, locate, placeSetup, exportSheet, amortBlock, compsTSV, sortComps, acct, pctCell, dollars2 };
});
