/**
 * The Sheet tab of an expanded target: the scenario's own "New Market UW'ing"
 * CSV drawn as the sheet it came from. All 22 columns (A–V), every row (the
 * amortization block included), and every cell exactly as the CSV has it.
 *   Unedited scenarios show the source CSV untouched. Edited ones and new
 *   listings show what Download UW CSV writes (UWCsv.exportSheet), with the
 *   calculated cells recalculated here; the amortization block always stays
 *   as the source wrote it.
 *   Input cells (yellow) are edited in place: price, down payment %, rate,
 *   closing %, the setup list, OPEX amounts, cleaning cost and turns, the
 *   Low / Mid / High revenue and the analyst notes. Comp rows come from the
 *   Comp set tab; rows that aren't valid comps are tinted red.
 */
/* global UWCsv */
(function () {
  const UW = window.UW, E = UW.esc;
  const S = (UW.sheetApi = {});
  const NCOL = 22;
  const LETTERS = Array.from({ length: NCOL }, (_, i) => String.fromCharCode(65 + i));
  const texts = {}, state = {};
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
  const group = (n, d) => Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  const textOf = (file) => (texts[file] = texts[file] || UW.sourceCsv(file).catch((e) => { delete texts[file]; throw e; }));
  const fileOf = (p, v) => (p.kind === "underwritten" ? v.file : UW.data.uw.templateFile);
  const pristine = (p, v) => p.kind === "underwritten" && v.source === "sheet" && !v.edited.notes && !v.edited.comps;
  const ref = (r, c) => LETTERS[c] + (r + 1);

  // ---------------------------------------------------------------------------
  // The grid: the CSV's rows, padded to A–V
  // ---------------------------------------------------------------------------
  function modelOf(p, v) {
    return Object.assign({}, UW.clone(v.inputs), {
      notes: v.notes, url: p.kind === "underwritten" ? v.url : p.url,
      comps: v.comps.map((c) => ({ url: c.url, revenue: c.revenue, bedrooms: c.bedrooms, sleeps: c.sleeps, adr: c.adr, occupancy: c.occupancy, flags: c.flags, notes: c.notes })),
    });
  }
  function grid(text, p, v) {
    const out = pristine(p, v) ? text : UWCsv.exportSheet(text, modelOf(p, v));
    const rows = UWCsv.parse(out).rows.map((r) => { const a = r.slice(0, NCOL); while (a.length < NCOL) a.push(""); return a; });
    const L = UWCsv.locate(rows);
    return { rows, L, calc: calcCells(rows, L), slots: L.setup.last - L.setup.first + 1 };
  }

  // Calculated cells, found by their row labels, and the output each one shows.
  function findIn(rows, test, r0, r1, col) {
    for (let i = Math.max(0, r0); i <= Math.min(r1, rows.length - 1); i++) if (test(norm(rows[i][col]))) return i;
    return -1;
  }
  function calcCells(rows, L) {
    const out = [], vc = L.price[1], pc = vc - 2, last = rows.length - 1;
    const add = (key, r, c, pct) => { if (r >= 0) out.push({ key, r, c, pct: !!pct, sample: rows[r][c] }); };
    const inPurchase = (re) => findIn(rows, (t) => re.test(t), L.price[0], L.revenue[0][0] - 1, pc);
    add("down", inPurchase(/^down payment/), vc);
    add("loan", inPurchase(/^loan amount/), vc);
    add("closing", inPurchase(/^closing costs/), vc);
    add("setupTotal", inPurchase(/^renovation/), vc);
    add("oop", inPurchase(/^total out of pocket/), vc);
    add("setupTotal", L.setup.last + 1, L.setup.col + 1);
    add("opexMonthly", L.opex.last + 1, L.opex.col + 1);
    add("cleaning", findIn(rows, (t) => t === "cleaning", L.opex.first, L.opex.last, L.opex.col), L.opex.col + 1);
    const r0 = L.revenue[0][0] + 1, taxRow = findIn(rows, (t) => t === "taxes", r0, last, pc);
    const r1 = taxRow > 0 ? taxRow - 1 : r0 + 12;
    [[/^operating expenses/, "opex"], [/^property management/, "pm"], [/^net operating income/, "noi"], [/^debt service/, "ds"],
      [/^free cash ?flow/, "fcf"], [/^cash on cash/, "coc", 1], [/^principal pay ?down/, "principal"], [/appreciation/, "appr"],
      [/^total return$/, "totalReturn", 1], [/^total return \+/, "totalReturnTax", 1]].forEach(([re, k, pct]) => {
      const r = findIn(rows, (t) => re.test(t), r0, r1, pc);
      ["low", "mid", "high"].forEach((c, j) => add("case:" + c + ":" + k, r, L.revenue[j][1], pct));
    });
    if (taxRow > 0) [[/^improvement basis/, "basis"], [/^short life assets/, "slas"], [/^y1 loss/, "y1Loss"], [/^tax savings/, "taxSavings"]]
      .forEach(([re, k]) => add("tax:" + k, findIn(rows, (t) => re.test(t), taxRow, taxRow + 9, pc), pc + 1));
    const fy = findIn(rows, (t) => t === "5 year", r0, last, L.setup.col);
    if (fy > 0) [[/^cash flow/, "cashFlow"], [/^equity/, "equity"], [/^appreciation/, "appreciation"], [/^total$/, "total"]]
      .forEach(([re, k]) => add("five:" + k, findIn(rows, (t) => re.test(t), fy + 1, fy + 6, L.setup.col), L.setup.col + 1));
    return out;
  }
  function valueOf(key, o) {
    const [a, b, c] = key.split(":");
    if (a === "case") return o.cases && o.cases[b] ? o.cases[b][c] : null;
    if (a === "tax") return o.taxes ? o.taxes[b] : null;
    if (a === "five") return o.fiveYear ? o.fiveYear[b] : null;
    return o[key];
  }
  // A recalculated value, written the way that cell already is (" $ 1,234 ", "$1,234", "$1,234.00", "12.34%").
  function fmtLike(sample, v, pct) {
    if (v == null || isNaN(v)) return "";
    const s = String(sample || "").trim();
    if (pct || /%$/.test(s)) { const m = s.match(/\.(\d+)%$/); return (Number(v) * 100).toFixed(m ? m[1].length : pct ? 2 : 0) + "%"; }
    if (/^-?\$[\d,]+\.\d\d$/.test(s)) return (v < 0 ? "-$" : "$") + group(v, 2);
    if (/^-?\$[\d,]+$/.test(s)) return (v < 0 ? "-$" : "$") + group(Math.round(v), 0);
    return UWCsv.acct(v);
  }

  // ---------------------------------------------------------------------------
  // Cells
  // ---------------------------------------------------------------------------
  const ACCT = /^\s*\$\s+(\(?[\d,]+(?:\.\d+)?\)?|-)\s*$/;
  const NUMLIKE = /^\s*-?\(?-?\$?[\d,]+(?:\.\d+)?\)?%?\s*$/;
  const HEAD = /^(purchase details|set up|optimi?zation list.*|operating expenses \(opex\)|monthly|analyst notes|disclaimer|common extras|low|mid|high|taxes|5 year|beginning|ending)$/;
  function show(text) {
    const t = text == null ? "" : String(text);
    if (!t.trim()) return { cls: "", html: "" };
    const m = t.match(ACCT);
    if (m) return { cls: "sh-n", html: '<span class="sh-acct"><span>$</span><span>' + E(m[1]) + "</span></span>" };
    if (NUMLIKE.test(t)) return { cls: "sh-n", html: E(t.trim()) };
    if (/^https?:\/\/\S+$/.test(t.trim())) return { cls: "sh-url", html: '<a href="' + E(t.trim()) + '" target="_blank" rel="noopener">' + E(t.trim()) + "</a>" };
    return { cls: HEAD.test(norm(t)) ? "sh-h" : "", html: E(t) };
  }

  // Input cells and what each one edits.
  function inputsMap(rows, L, v) {
    const m = {}, put = (rc, d) => { m[rc[0] + "," + rc[1]] = d; };
    put(L.price, { sh: "price", f: "acct" });
    put(L.dpPct, { sh: "dpPct", f: "pct", d: 0 });
    put(L.rate, { sh: "rate", f: "pct", d: 2 });
    put(L.closingPct, { sh: "closingPct", f: "pct", d: 2 });
    for (let r = 0; r <= L.setup.last - L.setup.first; r++) {
      put([L.setup.first + r, L.setup.col], { sh: "setupLabel", r, f: "text" });
      put([L.setup.first + r, L.setup.col + 1], { sh: "setupAmt", r, f: "acct" });
    }
    const opex = v.inputs.opex || [];
    for (let i = L.opex.first; i <= L.opex.last; i++) {
      const lab = norm(rows[i][L.opex.col]), k = opex.findIndex((o) => norm(o.label) === lab);
      if (lab && k >= 0 && !opex[k].cleaning) put([i, L.opex.col + 1], { sh: "opex", k, f: "acct" });
    }
    put(L.cleaningCost, { sh: "cleanCost", f: "acct" });
    put(L.cleaningTurns, { sh: "cleanTurns", f: "num" });
    ["low", "mid", "high"].forEach((c, j) => put(L.revenue[j], { sh: "rev", k: c, f: "acct" }));
    put(L.notes, { sh: "notes", f: "notes" });
    return m;
  }
  const LABEL = { price: "Purchase price", dpPct: "Down payment %", rate: "Interest rate", closingPct: "Closing costs %", setupLabel: "Setup item", setupAmt: "Setup item cost",
    opex: "Monthly OPEX", cleanCost: "Cleaning cost", cleanTurns: "Number of turns", rev: "Forecasted revenue", notes: "Analyst notes" };
  function inputCell(d, text, i, j, spanAttr) {
    const attrs = ' data-sh="' + d.sh + '"' + (d.r != null ? ' data-r="' + d.r + '"' : "") + (d.k != null ? ' data-k="' + d.k + '"' : "") + (d.d != null ? ' data-dec="' + d.d + '"' : "") +
      ' aria-label="' + E(LABEL[d.sh] + (d.k != null && d.sh === "rev" ? " (" + d.k + ")" : "") + ", cell " + ref(i, j)) + '" spellcheck="false"';
    const t = String(text || "");
    if (d.f === "notes") return '<td class="sh-in sh-block"' + spanAttr + '><textarea class="sh-notes"' + attrs + ">" + E(t) + "</textarea></td>";
    if (d.f === "text") return '<td class="sh-in sh-in--text"><div class="sh-ce" contenteditable="plaintext-only" role="textbox"' + attrs + ">" + E(t) + "</div></td>";
    if (d.f === "acct") {
      const m = t.match(ACCT), shown = m ? m[1] : t.trim();
      return '<td class="sh-in sh-n' + (shown ? "" : " is-empty") + '"><span class="sh-acct"><span>$</span><input class="sh-input" type="text" inputmode="decimal" value="' + E(shown) + '"' + attrs + "></span></td>";
    }
    return '<td class="sh-in sh-n"><input class="sh-input" type="text" inputmode="decimal" value="' + E(t.trim()) + '"' + attrs + "></td>";
  }

  // Long text (the analyst notes, the disclaimers) spans the empty cells beside and below it, as in the sheet.
  function merges(rows, L, inMap) {
    const span = {}, covered = new Set();
    rows.forEach((r, i) => r.forEach((t, j) => {
      const key = i + "," + j;
      if (covered.has(key) || !(t.length > 200 || /\n/.test(t)) || (inMap[key] && inMap[key].sh !== "notes")) return;
      let w = 1;
      while (j + w < NCOL && !r[j + w] && !inMap[i + "," + (j + w)]) w++;
      if (w === 1) return;
      let h = 1;
      while (i + h < rows.length && h < 24 && rows[i + h].slice(j, j + w).every((x, b) => !x && !inMap[(i + h) + "," + (j + b)])) h++;
      span[key] = { w, h };
      for (let a = 0; a < h; a++) for (let b = 0; b < w; b++) if (a || b) covered.add((i + a) + "," + (j + b));
    }));
    return { span, covered };
  }

  // Comp rows that aren't valid comps, tinted with their reason.
  function badComps(rows, L, v) {
    const out = {};
    for (let i = L.comps.first; i <= L.comps.last; i++) {
      const url = (rows[i][L.comps.col] || "").trim();
      if (!url) continue;
      const c = v.comps.find((x) => (x.url || "").trim() === url);
      if (c && !c.valid) out[i] = c.label + (c.reason ? ": " + c.reason : "");
    }
    return out;
  }

  function tableHtml(G, v) {
    const { rows, L, calc } = G;
    const inMap = inputsMap(rows, L, v);
    const calcAt = {};
    calc.forEach((x, n) => { calcAt[x.r + "," + x.c] = n; });
    const edited = v.source !== "sheet";
    const { span, covered } = merges(rows, L, inMap);
    const bad = badComps(rows, L, v);
    const compHead = L.comps.first - 1;
    let h = '<table class="sh-t"><thead><tr><th class="sh-corner" scope="col"><span class="visually-hidden">Row</span></th>' +
      LETTERS.map((l) => '<th scope="col" class="sh-col sh-col--' + l + '">' + l + "</th>").join("") + "</tr></thead><tbody>";
    rows.forEach((r, i) => {
      h += '<tr><th scope="row" class="sh-row">' + (i + 1) + "</th>";
      for (let j = 0; j < NCOL; j++) {
        const key = i + "," + j;
        if (covered.has(key)) continue;
        const sp = span[key], spanAttr = sp ? ' colspan="' + sp.w + '" rowspan="' + sp.h + '"' : "";
        const d = inMap[key];
        if (d) { h += inputCell(d, r[j], i, j, spanAttr); continue; }
        const badCls = bad[i] && j >= L.comps.col ? " sh-bad" : "";
        const badTitle = bad[i] && j === L.comps.col ? ' title="' + E(bad[i]) + '"' : "";
        if (calcAt[key] != null) {
          const x = calc[calcAt[key]];
          const s = show(edited ? fmtLike(x.sample, valueOf(x.key, v.outputs), x.pct) : r[j]);
          h += '<td class="sh-calc ' + s.cls + badCls + '" data-sc="' + calcAt[key] + '">' + s.html + "</td>";
          continue;
        }
        if (sp) { h += '<td class="sh-block"' + spanAttr + '><div class="sh-block__in">' + E(r[j]) + "</div></td>"; continue; }
        const s = show(r[j]);
        const free = (k) => j + k >= NCOL || (!r[j + k] && !inMap[i + "," + (j + k)] && !covered.has(i + "," + (j + k)));
        const spill = r[j] && s.cls !== "sh-n" && i !== compHead && free(1) && free(2) && free(3);
        const cls = (s.cls + (spill ? " sh-spill" : "") + (i === compHead && j >= L.comps.col && r[j] ? " sh-h" : "") + badCls).trim();
        h += "<td" + (cls ? ' class="' + cls + '"' : "") + badTitle + ">" + (spill ? '<div class="sh-spill__in">' + s.html + "</div>" : s.html) + "</td>";
      }
      h += "</tr>";
    });
    return h + "</tbody></table>";
  }

  // ---------------------------------------------------------------------------
  // Mount / refresh
  // ---------------------------------------------------------------------------
  S.html = function (p, v) {
    const isUW = p.kind === "underwritten", file = fileOf(p, v);
    const edited = v.source !== "sheet";
    return '<div class="sh-legend"><p><strong>' + E(file.replace(/\.csv$/, "")) + "</strong>" + (isUW ? "" : " <span class=\"muted\">(the template, with this listing’s inputs)</span>") +
      ' · every cell as the CSV has it, columns A–V. <span class="sh-swatch" aria-hidden="true"></span>Yellow cells are inputs: click one to edit it, and the totals and returns update as you type.</p>' +
      '<p class="sh-legend__edited"' + (edited ? "" : " hidden") + ">Edited: totals and returns are recalculated here. The amortization block stays as the sheet wrote it, and Download UW CSV copies it byte for byte.</p></div>" +
      '<div class="uw-sheet" data-pid="' + E(p.id) + '" data-label="' + E(v.label) + '"><p class="uw-hint">Loading the sheet…</p></div>';
  };
  S.fill = function (root) {
    (root || document).querySelectorAll('.uw-pane:not([hidden]) .uw-sheet:not([data-ready])').forEach((el) => {
      const p = UW.property(el.dataset.pid);
      if (!p) return;
      const file = fileOf(p, UW.activeVersion(p));
      el.dataset.ready = "loading";
      textOf(file).then((text) => {
        if (!el.isConnected) return;
        const v = UW.activeVersion(p);
        const G = grid(text, p, v);
        state[p.id] = Object.assign(G, { label: v.label });
        el.innerHTML = '<div class="sh-wrap" tabindex="0" aria-label="Sheet for ' + E(p.street) + '">' + tableHtml(G, v) + "</div>";
        el.dataset.ready = "1";
      }).catch((err) => {
        el.innerHTML = '<p class="uw-empty">Couldn’t draw the sheet from ' + E(file) + ": " + E(err.message) + "</p>";
        el.dataset.ready = "error";
      });
    });
  };
  // Recalculated cells only; never the field being typed in.
  S.refresh = function (card, p, v) {
    const st = state[p.id], host = card.querySelector('.uw-sheet[data-ready="1"]');
    if (!st || !host || st.label !== v.label) return;
    const edited = v.source !== "sheet";
    host.querySelectorAll("[data-sc]").forEach((td) => {
      const x = st.calc[+td.dataset.sc];
      const s = show(edited ? fmtLike(x.sample, valueOf(x.key, v.outputs), x.pct) : st.rows[x.r][x.c]);
      td.className = ("sh-calc " + s.cls).trim();
      td.innerHTML = s.html;
    });
    const note = card.querySelector(".sh-legend__edited");
    if (note) note.hidden = !edited;
  };

  // ---------------------------------------------------------------------------
  // Editing
  // ---------------------------------------------------------------------------
  function parseNum(s) {
    let t = String(s == null ? "" : s).trim();
    if (!t) return null;
    if (t === "-") return 0;
    const neg = /^\(.*\)$/.test(t) || t.startsWith("-");
    t = t.replace(/[$,%()\s-]/g, "");
    if (!t) return null;
    const n = Number(t);
    return isNaN(n) ? null : neg ? -n : n;
  }
  const acctNum = (x) => { const m = UWCsv.acct(x).match(ACCT); return m ? m[1] : ""; };
  // The setup item in slot r: by its saved row, else where the sheet places it (see UWCsv.placeSetup).
  function setupIndex(I, r, st) {
    const items = I.setup || [];
    if (items.every((x) => Number.isInteger(x.row))) return items.findIndex((x) => x.row === r);
    return st ? UWCsv.placeSetup(st.rows, st.L, items)[r] : -1;
  }
  const setupAt = (I, r, st) => { const k = setupIndex(I, r, st); return k >= 0 ? I.setup[k] : null; };
  // What a cell shows when it isn't being edited (the sheet's own format).
  function shown(ds, v, st) {
    const I = v.inputs, n = (x) => (x == null ? "" : x);
    switch (ds.sh) {
      case "price": return acctNum(I.price);
      case "dpPct": case "rate": case "closingPct": return I[ds.sh] == null ? "" : UWCsv.pctCell(I[ds.sh], +ds.dec);
      case "rev": return acctNum(I.revenue[ds.k]);
      case "opex": return acctNum(I.opex[+ds.k].amount);
      case "cleanCost": return acctNum(I.cleaningCost);
      case "cleanTurns": return I.cleaningTurns == null ? "" : String(Math.round(I.cleaningTurns * 100) / 100);
      case "setupAmt": { const it = setupAt(I, +ds.r, st); return it ? acctNum(it.amount) : null; }
      case "setupLabel": { const it = setupAt(I, +ds.r, st); return it ? n(it.label) : null; }
    }
    return null;
  }
  // What it shows while being edited: the plain number.
  function raw(ds, v, st) {
    const I = v.inputs, n = (x) => (x == null ? "" : String(+Number(x).toFixed(4)));
    switch (ds.sh) {
      case "price": return n(I.price);
      case "dpPct": case "rate": case "closingPct": return I[ds.sh] == null ? "" : n(I[ds.sh] * 100);
      case "rev": return n(I.revenue[ds.k]);
      case "opex": return n(I.opex[+ds.k].amount);
      case "cleanCost": return n(I.cleaningCost);
      case "cleanTurns": return n(I.cleaningTurns);
      case "setupAmt": { const it = setupAt(I, +ds.r, st); return it ? n(it.amount) : null; }
    }
    return null;
  }
  // Give every setup item the row it sits in, so renaming one never moves it.
  function pinRows(items, st) {
    if (items.every((x) => Number.isInteger(x.row))) return;
    UWCsv.placeSetup(st.rows, st.L, items).forEach((k, r) => { if (k >= 0) items[k].row = r; });
  }
  const ctx = (t) => {
    const card = t.closest && t.closest(".uw-card");
    const p = card && UW.property(card.dataset.pid);
    return p ? { card, p, v: UW.activeVersion(p), st: state[p.id] } : null;
  };

  function onInput(e) {
    const t = e.target;
    if (!t.dataset || !t.dataset.sh) return;
    const c = ctx(t);
    if (!c || !c.st) return;
    const { p, v, st } = c, sh = t.dataset.sh;
    if (sh === "notes") { UW.setNotes(p.id, v.label, t.value.replace(/\r\n/g, "\n")); return; }
    const text = t.isContentEditable ? t.textContent : t.value;
    const inputs = UW.clone(v.inputs), n = parseNum(text), pct = (x) => (x == null ? null : x / 100);
    switch (sh) {
      case "price": inputs.price = n; break;
      case "dpPct": case "rate": case "closingPct": inputs[sh] = pct(n); break;
      case "rev": inputs.revenue = Object.assign({}, inputs.revenue, { [t.dataset.k]: n }); break;
      case "opex": inputs.opex[+t.dataset.k].amount = n; break;
      case "cleanCost": inputs.cleaningCost = n; break;
      case "cleanTurns": inputs.cleaningTurns = n; break;
      case "setupLabel": case "setupAmt": {
        inputs.setup = inputs.setup || [];
        pinRows(inputs.setup, st);
        const r = +t.dataset.r;
        let k = inputs.setup.findIndex((x) => x.row === r);
        if (k < 0) {
          if (inputs.setup.length >= st.slots) return;
          inputs.setup.push({ label: "", amount: null, row: r });
          k = inputs.setup.length - 1;
        }
        if (sh === "setupLabel") inputs.setup[k].label = text.replace(/\n/g, " "); else inputs.setup[k].amount = n;
        break;
      }
      default: return;
    }
    const td = t.closest("td");
    if (td && td.querySelector(".sh-acct")) td.classList.toggle("is-empty", !text.trim());
    UW.setInputs(p.id, v.label, inputs);
  }
  function onFocus(e) {
    const t = e.target;
    if (!t.dataset || !t.dataset.sh || t.dataset.sh === "notes" || t.dataset.sh === "setupLabel") return;
    const c = ctx(t);
    if (!c) return;
    const r = raw(t.dataset, c.v, c.st);
    if (r != null) t.value = r;
    if (t.select) t.select();
  }
  function onBlur(e) {
    const t = e.target;
    if (!t.dataset || !t.dataset.sh || t.dataset.sh === "notes") return;
    const c = ctx(t);
    if (!c) return;
    let { p, v } = c;
    if (t.dataset.sh === "setupLabel" || t.dataset.sh === "setupAmt") {
      // A setup row left with neither a label nor a cost is removed (the sheet row goes blank).
      const r = +t.dataset.r, k = setupIndex(v.inputs, r, c.st);
      const it = k >= 0 ? v.inputs.setup[k] : null;
      const other = c.card.querySelector('[data-sh="' + (t.dataset.sh === "setupLabel" ? "setupAmt" : "setupLabel") + '"][data-r="' + r + '"]');
      if (it && !String(it.label || "").trim() && it.amount == null && other !== e.relatedTarget) {
        const inputs = UW.clone(v.inputs);
        inputs.setup.splice(k, 1);
        UW.setInputs(p.id, v.label, inputs);
        v = UW.activeVersion(p);
      }
    }
    const s = shown(t.dataset, v, c.st) || "";
    if (t.isContentEditable) { if (t.textContent !== s) t.textContent = s; } else t.value = s;
    const td = t.closest("td");
    if (td && td.querySelector(".sh-acct")) td.classList.toggle("is-empty", !s.trim());
  }

  S.init = function () {
    const lists = document.getElementById("uw-lists");
    lists.addEventListener("input", onInput);
    lists.addEventListener("focusin", onFocus);
    lists.addEventListener("focusout", onBlur);
  };
})();
