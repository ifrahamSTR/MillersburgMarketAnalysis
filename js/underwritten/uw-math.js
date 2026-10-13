/**
 * Underwriting maths for underwritten.html. Mirrors the "New Market UW'ing"
 * Google Sheet; checked against every sheet in underwriting/source_csv by
 * tests/test_underwritten.mjs. Runs in the browser (window.UWMath) and in Node.
 *
 *   Down = Price x DP%; Loan = Price - Down; Closing = Price x Closing%
 *   Out of pocket = Down + Closing + Setup total
 *   OPEX (Mid) = monthly total x 12; Low = Mid x (1 - range%); High = Mid x (1 + range%)
 *   PM fee = Revenue x PM%; NOI = Revenue - OPEX - PM fee
 *   Debt service = 12 x the amortizing payment over the amortization years
 *   (the sheet's amortization block uses 30, whatever "Mortgage Years" says)
 *   FCF = NOI - Debt service; Cash on cash = FCF / Out of pocket
 *   Principal = year-1 principal; Appreciation = Price x appreciation%
 *   Total return = (FCF + Principal + Appreciation) / Out of pocket
 *   Improvement basis = Price x (1 - Land%) + Setup; SLAs = 35% of basis;
 *   Y1 depreciation = SLAs x Bonus%; Tax savings = Y1 depreciation x Tax rate
 *   Total return + Y1 tax savings = (FCF + Principal + Appreciation + Tax savings) / Out of pocket
 *   5-year: Cash flow = 5 x Mid FCF; Equity = principal paid through month 60;
 *   Appreciation = 5 x annual; Total = the three added
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.UWMath = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const CASES = ["low", "mid", "high"];

  function payment(loan, rate, years) {
    const r = rate / 12, n = years * 12;
    return r ? (loan * r) / (1 - Math.pow(1 + r, -n)) : loan / n;
  }

  // Principal repaid in the first `months` payments.
  function principalPaid(loan, rate, years, months) {
    const r = rate / 12, pay = payment(loan, rate, years);
    let bal = loan, paid = 0;
    for (let m = 0; m < months && bal > 0; m++) {
      const p = Math.min(pay - bal * r, bal);
      paid += p;
      bal -= p;
    }
    return paid;
  }

  function cleaningMonthly(inp) {
    return inp.cleaningCost != null && inp.cleaningTurns != null ? inp.cleaningCost * inp.cleaningTurns : null;
  }

  function opexMonthly(inp) {
    const clean = cleaningMonthly(inp);
    return (inp.opex || []).reduce((s, o) => s + ((o.cleaning && clean != null ? clean : o.amount) || 0), 0);
  }

  function setupTotal(inp) {
    return (inp.setup || []).reduce((s, x) => s + (x.amount || 0), 0);
  }

  const num = (v) => (v == null || v === "" || isNaN(v) ? null : Number(v));

  function compute(inp) {
    const price = num(inp.price) || 0;
    const down = price * (num(inp.dpPct) || 0);
    const loan = price - down;
    const closing = price * (num(inp.closingPct) || 0);
    const setup = setupTotal(inp);
    const oop = down + closing + setup;
    const monthly = opexMonthly(inp);
    const range = num(inp.opexRangePct) || 0;
    const opexMid = monthly * 12;
    const opex = { low: opexMid * (1 - range), mid: opexMid, high: opexMid * (1 + range) };
    const years = num(inp.amortYears) || 30;
    const rate = num(inp.rate) || 0;
    const ds = loan > 0 ? 12 * payment(loan, rate, years) : 0;
    const principal = loan > 0 ? principalPaid(loan, rate, years, 12) : 0;
    const appr = price * (num(inp.apprPct) || 0);
    const basis = price * (1 - (num(inp.landPct) || 0)) + setup;
    const slas = basis * (inp.slaPct == null ? 0.35 : inp.slaPct);
    const y1Loss = slas * (num(inp.bonusPct) || 0);
    const taxSavings = y1Loss * (num(inp.taxRate) || 0);
    const cases = {};
    CASES.forEach((c) => {
      const rev = num(inp.revenue && inp.revenue[c]);
      if (rev == null) {
        cases[c] = { revenue: null, opex: opex[c], pm: null, noi: null, ds, fcf: null, coc: null, principal, appr, totalReturn: null, totalReturnTax: null };
        return;
      }
      const pm = rev * (num(inp.pmPct) || 0);
      const noi = rev - opex[c] - pm;
      const fcf = noi - ds;
      cases[c] = {
        revenue: rev, opex: opex[c], pm, noi, ds, fcf,
        coc: oop ? fcf / oop : null, principal, appr,
        totalReturn: oop ? (fcf + principal + appr) / oop : null,
        totalReturnTax: oop ? (fcf + principal + appr + taxSavings) / oop : null,
      };
    });
    const equity = loan > 0 ? principalPaid(loan, rate, years, 60) : 0;
    const fiveYear = {
      cashFlow: cases.mid.fcf == null ? null : 5 * cases.mid.fcf,
      equity, appreciation: 5 * appr,
      total: cases.mid.fcf == null ? null : 5 * cases.mid.fcf + equity + 5 * appr,
    };
    return {
      down, loan, closing, setupTotal: setup, oop, opexMonthly: monthly, cleaning: cleaningMonthly(inp),
      cases, taxes: { landPct: inp.landPct, basis, slas, bonusPct: inp.bonusPct, taxRate: inp.taxRate, y1Loss, taxSavings },
      fiveYear, payment: loan > 0 ? payment(loan, rate, years) : 0,
    };
  }

  // Same shape as compute(), from the sheet's own displayed numbers.
  function fromSheet(sheet) {
    return {
      down: sheet.down, loan: sheet.loan, closing: sheet.closing, setupTotal: sheet.setupTotal, oop: sheet.oop,
      opexMonthly: sheet.opexMonthly, cleaning: sheet.cleaning, cases: sheet.cases, taxes: sheet.taxes, fiveYear: sheet.fiveYear,
      payment: sheet.amort && sheet.amort.payment1,
    };
  }

  // Which outputs to compare in the acceptance test, and their tolerance.
  const CHECKS = [
    ["down", "Down payment", "$"], ["loan", "Loan amount", "$"], ["closing", "Closing costs", "$"], ["setupTotal", "Setup total", "$"],
    ["oop", "Total out of pocket", "$"], ["opexMonthly", "OPEX monthly total", "$"],
  ];
  const CASE_CHECKS = [
    ["opex", "OPEX", "$"], ["pm", "PM fee", "$"], ["noi", "NOI", "$"], ["ds", "Debt service", "$"], ["fcf", "Free cash flow", "$"],
    ["coc", "Cash on cash", "%"], ["principal", "Principal pay down", "$"], ["appr", "Appreciation", "$"],
    ["totalReturn", "Total return", "%"], ["totalReturnTax", "Total return + Y1 tax savings", "%"],
  ];
  const TAX_CHECKS = [["basis", "Improvement basis", "$"], ["slas", "Short life assets", "$"], ["y1Loss", "Y1 depreciation", "$"], ["taxSavings", "Tax savings", "$"]];
  const FIVE_CHECKS = [["cashFlow", "5-yr cash flow", "$"], ["equity", "5-yr equity", "$"], ["appreciation", "5-yr appreciation", "$"], ["total", "5-yr total", "$"]];

  /**
   * Recompute a sheet from its inputs and compare with the sheet's displayed
   * outputs. Displayed dollars are whole and percentages have 2 decimals, so
   * "exact" = within $1 / 0.01 points. Some input cells also hide decimals
   * (e.g. an HOA of $3.33 shows as $3), so a second, "rounding" band allows
   * what the displayed inputs could be off by: up to $0.50 per monthly OPEX
   * line (x12 a year) and $0.50 on the cleaning rate.
   */
  function verify(version) {
    const inp = version.inputs, sh = version.sheet;
    const calc = compute(inp);
    const nOpex = (inp.opex || []).filter((o) => o.amount).length;
    const slackYear = 12 * 0.5 * nOpex + 12 * 0.5 * (inp.cleaningTurns || 0);
    const rows = [];
    const add = (group, key, label, kind, sheetVal, calcVal, slack) => {
      if (sheetVal == null && (calcVal == null || calcVal === 0)) return;
      const diff = calcVal == null || sheetVal == null ? Infinity : calcVal - sheetVal;
      const exactTol = kind === "%" ? 0.0001 + 1e-9 : 1 + 1e-6;
      const roundTol = kind === "%" ? exactTol + slack / (calc.oop || 1) : exactTol + slack;
      rows.push({ group, key, label, kind, sheet: sheetVal, calc: calcVal, diff,
        result: Math.abs(diff) <= exactTol ? "exact" : Math.abs(diff) <= roundTol ? "rounding" : "FAIL" });
    };
    const opexSlack = (c) => (c === "low" ? 1 - (inp.opexRangePct || 0) : c === "high" ? 1 + (inp.opexRangePct || 0) : 1) * slackYear;
    CHECKS.forEach(([k, l, t]) => add("purchase", k, l, t, sh[k], calc[k], k === "opexMonthly" ? slackYear / 12 : 0));
    CASES.forEach((c) => CASE_CHECKS.forEach(([k, l, t]) => add(c, k, l, t, sh.cases[c][k], calc.cases[c][k],
      ["opex", "noi", "fcf", "coc", "totalReturn", "totalReturnTax"].includes(k) ? opexSlack(c) : 0)));
    TAX_CHECKS.forEach(([k, l, t]) => add("taxes", k, l, t, sh.taxes[k], calc.taxes[k], 0));
    FIVE_CHECKS.forEach(([k, l, t]) => add("fiveYear", k, l, t, sh.fiveYear[k], calc.fiveYear[k], ["cashFlow", "total"].includes(k) ? 5 * slackYear : 0));
    const worst = rows.some((r) => r.result === "FAIL") ? "FAIL" : rows.some((r) => r.result === "rounding") ? "rounding" : "exact";
    return { result: worst, rows, calc };
  }

  return { CASES, payment, principalPaid, compute, fromSheet, verify, opexMonthly, setupTotal, cleaningMonthly };
});
