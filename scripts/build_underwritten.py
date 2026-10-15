"""
Build the data behind underwritten.html (Millersburg, OH underwriting map):

  ../Millersburg - OH.xlsx via ../notebooks/market_common.py     -> data/comps.json
  the Millersburg village limits (US Census TIGER)                -> data/village.json
  underwriting/source_csv/*.csv  (+ data/underwritten_local.json) -> data/underwritten.json
                                                                    data/amortization.json
  underwriting/template/*.csv (the sheet a new listing starts from) -> "templates" in data/underwritten.json
  the location rules, for the browser test                        -> tests/fixtures/place_check.json
  US Census geocoder, then Nominatim, cached in data/geocode_cache.json; manual pins in data/geocode_overrides.json
  scenario labels for multi-file targets                          <- data/version_labels.json
  comp audit of every sheet's comp rows against the workbook(s)   -> reports/comp_audit.csv (+ in underwritten.json)

Terminology: Zillow listings are acquisition targets (the houses to buy) and are
never comps. Comps are only Airbnb listings from the workbook's Cleaned_Data
sheet (entire homes); every other row in a comp table is an audit error.

Run from anywhere (same Python env as generate_webpage_data.py):
    python scripts/build_underwritten.py            # geocodes addresses not yet cached
    python scripts/build_underwritten.py --offline  # never calls the geocoder
It prints the validation report, then runs tests/test_underwritten.mjs (formula
pass/fail table + CSV export tests) when node is on PATH.

Idempotent: the same inputs give byte-identical outputs (no timestamps). Do not
hand-edit the generated files. The sheets are read by label, not fixed cell, and
nothing here edits a sheet value: mismatches are reported, never fixed.
"""
import csv
import hashlib
import io
import json
import re
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.spatial import ConvexHull, cKDTree

ROOT = Path(__file__).resolve().parent.parent
NB = ROOT.parent / "notebooks"
DATA = ROOT / "data"
SRC = ROOT / "underwriting" / "source_csv"
OFFLINE = "--offline" in sys.argv

if not (NB / "market_common.py").exists():
    sys.exit(f"STOP: {NB / 'market_common.py'} not found. The comp classifications must come from "
             "market_common.load() so they match the main page; not falling back to a re-implementation.")
sys.path.insert(0, str(NB))
import market_common as mc  # noqa: E402

COMP_HEADER = ["Listing URL", "Revenue Potential", "Bedrooms", "Sleeps", "ADR", "Occupancy", "HAS_hot_tub", "HAS_pool",
               "HAS_game_room", "HAS_pickleball", "HAS_mini_golf", "HAS_sauna", "HAS_playground", "HAS_waterfront", "Notes"]
SHEET_FLAGS = [h[4:] for h in COMP_HEADER if h.startswith("HAS_")]
CITIES = ["Walnut Creek", "Mount Hope", "Big Prairie", "Millersburg", "Berlin", "Killbuck", "Holmesville", "Charm", "Winesburg", "Glenmont",
          "Loudonville", "Sugarcreek", "Fredericksburg", "Nashville", "Baltic", "Benton", "Lakeville", "Wilmot", "Dundee", "Shreve"]
TEMPLATE_DIR = ROOT / "underwriting" / "template"
# The setup lines every sheet carries, at Galveston file 101's amounts (as js/underwritten/uw-rules.js
# STANDARD_SETUP): a new listing from the blank template starts with these; "row" is the slot (0 = row 5).
STANDARD_SETUP = [{"label": "Furniture / Decor / Essentials", "amount": 50000, "row": 0}, {"label": "Misc", "amount": 25000, "row": 11},
                  {"label": "CoHost Essentials", "amount": 3500, "row": 12}, {"label": "Design/Project Management", "amount": 25000, "row": 13},
                  {"label": "Install/Staging/Warehousing", "amount": 18250, "row": 14}]
# The OPEX lines every new sheet carries, monthly, at Galveston file 101's amounts rounded ($924 property
# taxes -> $900) and $0 where 101 left a line blank (as js/underwritten/uw-rules.js STANDARD_OPEX); cleaning is
# 101's $275 x 6 turns.
STANDARD_OPEX = {"internet": 100, "utilities": 500, "pest control": 50, "pool/hot tub maintenance": 200, "outdoor/landscaping": 100,
                 "software": 0, "household supplies": 250, "other": 0, "property taxes (monthly)": 900, "insurance hoi": 600,
                 "capex reserve": 500, "misc": 0, "hoa fees": 0, "pmi": 0}
MIN_REV = 40000  # default revenue floor for Match by location: the market median ($41.9k), rounded down


def dump(path, obj):
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")


def r(x, n=0):
    if x is None or (isinstance(x, float) and np.isnan(x)):
        return None
    return int(round(float(x))) if n == 0 else round(float(x), n)


# ---------------------------------------------------------------------------
# 1. Airbnb comps -> data/comps.json
# ---------------------------------------------------------------------------
df, P75, P90 = mc.load()
allc = pd.read_excel(mc.XLSX, sheet_name="Cleaned_Data", engine="openpyxl")
allc = allc[allc["Property ID"].notna()].copy()
allc["room"] = allc["Listing URL"].astype(str).str.extract(r"rooms/(\d+)")[0]
assert len(df) == 62 and len(allc) == 63, (len(df), len(allc))
assert not allc["Exclude_Comp"].astype(bool).any()  # filters nothing in this workbook; noted on the page

df["room"] = df["Listing URL"].astype(str).str.extract(r"rooms/(\d+)")[0]
assert df["room"].notna().all() and (df["room"] == df["Property ID"].str.replace("abnb_", "", regex=False)).all()
flag_cols = [c for c in df.columns if c.startswith("HAS_")]
FLAG_KEYS = [c[4:] for c in flag_cols]
q = df.groupby("size")["idx"].quantile([0.75, 0.90]).unstack()
df["size_top"] = np.select([df["idx"] >= df["size"].map(q[0.90]), df["idx"] >= df["size"].map(q[0.75])], ["top10", "top25"], "rest")
X = mc.coords_km(df)
QUAL = {"Good Data": "Good", "Possibly Good Data": "Possibly Good"}


def listing(row):
    return {
        "id": row["room"], "title": str(row["Listing_Title"]), "url": str(row["Listing URL"]),
        "bedrooms": r(row["Bedrooms"], 1), "sleeps": r(row["Sleeps"], 1), "beds": r(row["Bed_Count"], 1), "baths": r(row["Baths"], 1),
        "revenue": r(row["Revenue Potential"], 2), "adr": r(row["ADR"], 4), "occ": r(row["Occupancy"], 6),
        "lat": r(row["Lat"], 6), "lng": r(row["Long"], 6), "zip": None if pd.isna(row["ZIPCODE"]) else str(int(row["ZIPCODE"])),
        "flags": [k for k, c in zip(FLAG_KEYS, flag_cols) if row[c] == 1],
        "fav": int(row["is_guest_favorite"] == 1), "rating": r(row["Ratings"], 2), "reviews": r(row["Reviews"]),
        "quality": QUAL.get(row["Data Quality Category"], row["Data Quality Category"]), "status": row["Listing_Status"],
        "kids": r(row["pct_stayed_with_kids"], 2), "group": r(row["pct_group_trip"], 2),
        "area": mc.AREA_SHORT[row["Area"]], "loc": row["loc"], "town": bool(row["town"]), "zone": "Village" if row["town"] else "Countryside", "size": row["size"],
        "vsSize": r(row["idx"], 3), "sizeTier": row["size_tier"], "sizeTop": row["size_top"],
        "tier": {"Top 10%": "top10", "Top 25%": "top25"}.get(row["tier"], "bottom75"), "centerKm": r(row[mc.DIST_COL], 3),
    }


listings = [listing(row) for _, row in df.iterrows()]

# Area outlines exactly as the main page's overview map draws them (convex hull, 0.35 km buffer).
coslat = np.cos(np.radians(df["Lat"].mean()))
areas_out = []
for a in mc.AREA_ORDER:
    g = df[df["Area"] == a]
    pts = g[["Long", "Lat"]].to_numpy()
    hull = pts[ConvexHull(pts).vertices] if len(pts) >= 3 else pts
    c = hull.mean(axis=0)
    kx = np.array([111 * coslat, 111.0])
    buf = [p + ((p - c) * kx / (np.linalg.norm((p - c) * kx) + 1e-9)) * 0.35 / kx for p in hull]
    areas_out.append({"id": mc.AREA_SHORT[a], "name": a, "sub": mc.AREA_SUB[a], "color": mc.AREA_COLORS[a],
                      "n": int(len(g)), "hull": [[round(p[1], 5), round(p[0], 5)] for p in buf],
                      "label": [round(g["Lat"].quantile(0.9) + 0.003, 5), round(g["Long"].mean(), 5)]})

size_med = df.groupby("size")["Revenue Potential"].median()
other = allc[~allc["room"].isin(df["room"])]
DATA.mkdir(exist_ok=True)
dump(DATA / "comps.json", {
    "source": f"{mc.XLSX.name}, sheet Cleaned_Data, entire homes only (Base_Table.roomType == 'Entire home/apt')",
    "snapshot": mc.SNAPSHOT, "market": mc.MARKET, "n": len(listings), "nCleaned": int(len(allc)), "nOtherRooms": int(len(other)),
    "excludeCompUsed": False, "guestFavoriteAny": bool(df["is_guest_favorite"].eq(1).any()),
    "flagKeys": FLAG_KEYS, "sheetFlags": SHEET_FLAGS,
    "sizeOrder": mc.SIZE_ORDER, "sizeMedian": {s: r(v) for s, v in size_med.items()},
    "locName": mc.LOC_NAME, "locOrder": mc.LOC_ORDER, "locDef": mc.LOC_DEF, "locColors": mc.LOC_COLORS, "zones": mc.ZONE_ORDER, "zoneDef": mc.ZONE_DEF,
    "distLabel": mc.DIST_LABEL, "center": {"name": "Holmes County Courthouse", "lat": mc.COURTHOUSE[0], "lng": mc.COURTHOUSE[1]}, "downtownKm": mc.DOWNTOWN_KM,
    "minRevDefault": MIN_REV, "marketMedian": r(df["Revenue Potential"].median()), "marketP75": r(P75), "marketP90": r(P90), "areas": areas_out,
    "otherRooms": sorted(other["room"].dropna().tolist()),
    "listings": listings,
})

# ---------------------------------------------------------------------------
# 2. Village limits -> data/village.json (what zone and setting are measured against)
# ---------------------------------------------------------------------------
VJ = json.loads(mc.VILLAGE.read_text())
dump(DATA / "village.json", {
    "source": VJ["source"], "name": VJ["name"], "geoid": VJ["geoid"], "note": VJ["note"],
    "projection": "x = (lng + 81.9) * 111 * cos(40.55 deg), y = (lat - 40.55) * 111 (km), as market_common._xy",
    "center": {"name": "Holmes County Courthouse", "lat": mc.COURTHOUSE[0], "lng": mc.COURTHOUSE[1]}, "downtownKm": mc.DOWNTOWN_KM,
    "rings": VJ["rings"],
})
LTREE = cKDTree(X)
AREA_OF = df["Area"].to_numpy()


def place(lat, lng, text=None):
    """Area, zone and setting for a point, by the same rules as the listings (text is unused here)."""
    p = mc._xy([lat], [lng])
    i = int(LTREE.query(p, k=1)[1][0])  # area: the nearest listing's (61 of 62 listings in a leave-one-out test)
    area = AREA_OF[i]
    village = bool(mc.in_village([lat], [lng])[0])
    km = float(mc.center_km([lat], [lng])[0])
    loc = str(mc.setting([village], [km])[0])
    return {"centerKm": round(km, 3), "area": mc.AREA_SHORT[area], "areaName": area, "town": village,
            "zone": "Village" if village else "Countryside", "loc": loc}


# Leave-one-out check of the area rule, reported below.
LOO = 0
for k in range(len(df)):
    d_, j_ = LTREE.query(X[k:k + 1], k=2)
    LOO += AREA_OF[j_[0][1]] == AREA_OF[k]

# Fixture for the tests: the build's classification of every listing's point and of a grid
# over the market, so the browser rules (js/underwritten/uw-geo.js) can be checked against it.
FIX = ROOT / "tests" / "fixtures"
FIX.mkdir(parents=True, exist_ok=True)
grid = [(round(la, 5), round(lo, 5)) for la in np.linspace(40.50, 40.62, 25) for lo in np.linspace(-82.03, -81.80, 25)]
grid += [(round(mc.COURTHOUSE[0] + dy, 6), round(mc.COURTHOUSE[1] + dx, 6)) for dy in np.linspace(-0.006, 0.006, 13) for dx in np.linspace(-0.008, 0.008, 13)]
dump(FIX / "place_check.json", {"note": "generated by scripts/build_underwritten.py; the browser's UWGeo.classify must agree on every point",
                                "points": [dict(lat=la, lng=lo, **place(la, lo)) for la, lo in grid]})


# ---------------------------------------------------------------------------
# 3. Underwriting sheets
# ---------------------------------------------------------------------------
def money(s):
    s = (s or "").strip()
    if not s:
        return None
    t = re.sub(r"[^\d.]", "", s)
    if not t:
        return 0.0 if "-" in s else None  # accounting zero " $ -   "
    v = float(t)
    return -v if ("(" in s or s.lstrip("$ ").startswith("-") or s.startswith("-")) else v


def pct(s):
    s = (s or "").strip()
    if not s:
        return None
    v = float(re.sub(r"[^\d.\-]", "", s)) / 100
    return v


def num(s):
    s = (s or "").strip()
    return float(s) if re.fullmatch(r"-?\d+(\.\d+)?", s) else money(s)


def norm(s):
    return re.sub(r"\s+", " ", (s or "").strip()).lower()


def A1(ri, ci):
    return f"{chr(65 + ci)}{ri + 1}"


def find(rows, label, start=0, col=None, prefix=False):
    want = norm(label)
    for i in range(start, len(rows)):
        for j, c in enumerate(rows[i]):
            if col is not None and j != col:
                continue
            n = norm(c)
            if n == want or (prefix and n.startswith(want)):
                return i, j
    return None


def parse_notes(text):
    t = text or ""

    def grab(pat):
        m = re.search(pat, t, re.I)
        return m.group(1).strip() if m else None

    bb = grab(r"Bed\s*/\s*Bath\s*\(projected\)\s*:\s*([^\n]*)")
    lot = grab(r"Lot Size\s*\(sqft\)\s*:\s*([^\n]*)")
    size = grab(r"Prop Size\s*\(sqft\)\s*:\s*([^\n]*)")
    out = {"bedBathText": bb, "lotText": lot, "sizeText": size, "beds": None, "baths": None, "lot": None, "size": None}
    if bb:
        m = re.match(r"(\d+(?:\.\d+)?)\s*/\s*(\d+(?:\.\d+)?)\s*(.*)", bb)
        if m:
            out.update(beds=float(m.group(1)), baths=float(m.group(2)), bedBathComment=m.group(3).strip() or None)
    for key, txt in (("lot", lot), ("size", size)):
        m = re.match(r"([\d,]+(?:\.\d+)?)\s*(.*)", txt or "")
        if m:
            out[key] = float(m.group(1).replace(",", ""))
            out[key + "Comment"] = m.group(2).strip(" ,") or None
    why = t.split("Why This Property?", 1)[1] if "Why This Property?" in t else ""
    out["why"] = [ln.strip()[2:].strip(" ,") for ln in why.splitlines() if ln.strip().startswith("--") and ln.strip()[2:].strip(" ,")]
    return out


def parse_sheet(path):
    raw = path.read_bytes()
    text = raw.decode("utf-8")
    rows = list(csv.reader(io.StringIO(text, newline="")))
    g = lambda i, j: rows[i][j] if i < len(rows) and j < len(rows[i]) else ""  # noqa: E731
    lay, issues = {}, []

    ri, ci = find(rows, "Analyst Notes")
    notes, lay["notes"] = g(ri + 1, ci), A1(ri + 1, ci)
    ri, ci = find(rows, "PROPERTY URL:")
    url, lay["url"] = g(ri, ci + 1).strip(), A1(ri, ci + 1)
    pb = find(rows, "Prepared By:")
    prepared = g(pb[0], pb[1] + 1).strip() if pb else None

    # Purchase details: labels in one column, % one to the right, $ two to the right.
    pr, pc = find(rows, "Purchase Details")
    P = {}
    for key, label, pre in (("price", "Purchase Price", False), ("dp", "Down Payment", False), ("loan", "Loan Amount", False),
                            ("rate", "Interest Rate", False), ("mortgageYears", "Mortgage Years", False), ("closing", "Closing Costs", False),
                            ("setupTotal", "Renovation / Amenities / Furniture", True), ("oop", "Total Out of Pocket", True)):
        hit = find(rows, label, pr, pc, pre)
        P[key] = hit
        if hit is None:
            issues.append(f"label '{label}' not found")
    price = money(g(P["price"][0], pc + 2)); lay["price"] = A1(P["price"][0], pc + 2)
    dpPct = pct(g(P["dp"][0], pc + 1)); lay["dpPct"] = A1(P["dp"][0], pc + 1)
    rate = pct(g(P["rate"][0], pc + 2)); lay["rate"] = A1(P["rate"][0], pc + 2)
    closingPct = pct(g(P["closing"][0], pc + 1)); lay["closingPct"] = A1(P["closing"][0], pc + 1)
    mortgageYears = num(g(P["mortgageYears"][0], pc + 2))

    # Setup ("Optimzation List") items down to its Total row.
    hr, hc = find(rows, "Optimzation List", prefix=True) or find(rows, "Optimization List", prefix=True)
    tr = find(rows, "Total", hr + 1, hc)[0]
    setup = []
    for i in range(hr + 1, tr):
        lab, amt = g(i, hc), money(g(i, hc + 1))  # label kept exactly as written (export writes it back)
        if lab.strip() or amt is not None:
            setup.append({"label": lab, "amount": amt, "row": i + 1})
    lay["setup"] = {"col": chr(65 + hc), "amountCol": chr(66 + hc), "first": hr + 2, "last": tr, "total": A1(tr, hc + 1)}
    setup_total_sheet = money(g(tr, hc + 1))

    # OPEX, monthly, down to "Total Operating Expenses".
    orr, oc = find(rows, "Operating Expenses (OPEX)")
    otr = find(rows, "Total Operating Expenses", orr + 1, oc)[0]
    opex = []
    for i in range(orr + 1, otr):
        lab = g(i, oc).strip()
        if lab:
            item = {"label": lab, "amount": money(g(i, oc + 1)), "row": i + 1}
            if g(i, oc + 2).strip():
                item["note"] = g(i, oc + 2).strip()
            if norm(lab) == "cleaning":
                item["cleaning"] = True
            opex.append(item)
    cr, cc = find(rows, "Cleaning Cost")
    tnr, tnc = find(rows, "# of Turns")
    cleaningCost, cleaningTurns = money(g(cr + 1, cc)), num(g(tnr + 1, tnc))
    lay["opex"] = {"col": chr(65 + oc), "amountCol": chr(66 + oc), "first": orr + 2, "last": otr, "total": A1(otr, oc + 1),
                   "cleaningCost": A1(cr + 1, cc), "cleaningTurns": A1(tnr + 1, tnc)}

    # Returns block: the row whose three cells read Low / Mid / High.
    lr = lc = None
    for i, row in enumerate(rows):
        for j in range(len(row) - 2):
            if [norm(x) for x in row[j:j + 3]] == ["low", "mid", "high"]:
                lr, lc = i, j
                break
        if lr is not None:
            break
    RET = [("revenue", "Forecasted Revenue"), ("opex", "Operating Expenses"), ("pm", "Property Management Fee"), ("noi", "Net Operating Income"),
           ("ds", "Debt Service"), ("fcf", "Free CashFlow"), ("coc", "Cash on Cash"), ("principal", "Principal Pay Down"),
           ("appr", "Annual RE Appreciation"), ("totalReturnTax", "Total Return + Year 1 Tax Savings"), ("totalReturn", "Total Return")]
    cases, rpar = {"low": {}, "mid": {}, "high": {}}, {}
    for i in range(lr + 1, lr + 16):
        lab = norm(g(i, pc))
        for key, label in RET:
            if lab.startswith(norm(label)) and not (key == "totalReturn" and "tax" in lab):
                for k, case in enumerate(("low", "mid", "high")):
                    cell = g(i, lc + k)
                    cases[case][key] = pct(cell) if key in ("coc", "totalReturn", "totalReturnTax") else money(cell)
                if g(i, pc + 1).strip():
                    rpar[key] = pct(g(i, pc + 1))
                if key == "revenue":
                    lay["revenue"] = [A1(i, lc), A1(i, lc + 1), A1(i, lc + 2)]
                break

    # Comp table.
    hr2, hc2 = find(rows, "Listing URL")
    header = [g(hr2, hc2 + k).strip() for k in range(15)]
    if header != COMP_HEADER:
        issues.append("comp table header differs from the expected 15 columns: " + " | ".join(header))
    comps = []
    for i in range(hr2 + 1, hr2 + 16):
        cells = [g(i, hc2 + k) for k in range(15)]
        if not cells[0].strip():
            if any(c.strip() for c in cells):
                issues.append(f"comp row {i + 1} has values but no Listing URL")
            continue
        m = re.search(r"rooms/(\d+)", cells[0])
        comps.append({"row": i + 1, "url": cells[0].strip(), "id": m.group(1) if m else None, "revenue": money(cells[1]),
                      "bedrooms": num(cells[2]), "sleeps": num(cells[3]), "adr": money(cells[4]), "occupancy": pct(cells[5]),
                      "flags": {f: int(num(cells[6 + k]) or 0) for k, f in enumerate(SHEET_FLAGS)}, "notes": cells[14]})
    lay["comps"] = {"header": A1(hr2, hc2), "first": hr2 + 2, "last": hr2 + 16, "col": chr(65 + hc2)}

    # Taxes and 5-year blocks.
    tx_r, tx_c = find(rows, "Taxes")
    T = {}
    for key, label in (("landPct", "Land Assumptions"), ("basis", "Improvement Basis"), ("slas", "Short Life Assets"),
                       ("bonusPct", "Bonus Amount"), ("taxRate", "Tax Rate"), ("y1Loss", "Y1 Loss from Depreciation"), ("taxSavings", "Tax Savings")):
        hit = find(rows, label, tx_r, tx_c, True)
        cell = g(hit[0], tx_c + 1)
        T[key] = pct(cell) if key in ("landPct", "bonusPct", "taxRate") else money(cell)
    fy_r, fy_c = find(rows, "5 Year")
    F = {}
    for key, label in (("cashFlow", "Cash Flow"), ("equity", "Equity"), ("appreciation", "Appreciation"), ("total", "Total")):
        hit = find(rows, label, fy_r, fy_c)
        F[key] = money(g(hit[0], fy_c + 1))

    # Amortization block: the second "Loan Amount" label (not the purchase one) down to the last month row.
    am = find(rows, "Loan Amount", P["loan"][0] + 1)
    while am and am[1] == pc:
        am = find(rows, "Loan Amount", am[0] + 1)
    ar, ac = am
    vc = next(j for j in range(ac + 1, len(rows[ar])) if rows[ar][j].strip())
    a_loan = money(g(ar, vc))
    a_rate = pct(g(find(rows, "Interest Rate", ar, ac)[0], vc))
    a_years = num(g(find(rows, "Amortization Years", ar, ac)[0], vc))
    mr = find(rows, "Month", ar, ac)[0]
    months, last = [], None
    for i in range(mr + 1, len(rows)):
        cell = g(i, ac).strip()
        if re.fullmatch(r"\d+", cell):
            vals = [money(g(i, ac + k)) for k in range(1, 7)]
            months.append({"m": int(cell), "begin": vals[0], "payment": vals[1], "interest": vals[2], "principal": vals[3], "end": vals[4], "paid": vals[5]})
            last = i
    block = {"startRow": ar + 1, "endRow": last + 1, "rows": rows[ar:last + 1]}

    # "Common Extras": a reference list beside the setup items (not in any total).
    extras = []
    ce = find(rows, "Common Extras")
    if ce:
        for i in range(ce[0] + 1, ce[0] + 12):
            lab, amt = g(i, ce[1]).strip(), money(g(i, ce[1] + 1))
            if not lab:
                break
            extras.append({"label": lab, "amount": amt})

    sheet = {"down": money(g(P["dp"][0], pc + 2)), "loan": money(g(P["loan"][0], pc + 2)), "closing": money(g(P["closing"][0], pc + 2)),
             "setupTotal": money(g(P["setupTotal"][0], pc + 2)), "setupTotalList": setup_total_sheet, "oop": money(g(P["oop"][0], pc + 2)),
             "opexMonthly": money(g(otr, oc + 1)), "cleaning": next((o["amount"] for o in opex if o.get("cleaning")), None),
             "cases": cases, "taxes": T, "fiveYear": F, "mortgageYears": mortgageYears,
             "amort": {"loan": a_loan, "rate": a_rate, "years": a_years, "months": len(months),
                       "payment1": months[0]["payment"] if months else None,
                       "paid12": months[11]["paid"] if len(months) >= 12 else None, "paid60": months[59]["paid"] if len(months) >= 60 else None,
                       "paidLast": months[-1]["paid"] if months else None,
                       "principal1": months[0]["principal"] if months else None, "principal2": months[1]["principal"] if len(months) > 1 else None,
                       "paid2": months[1]["paid"] if len(months) > 1 else None}}
    inputs = {"price": price, "dpPct": dpPct, "rate": rate, "closingPct": closingPct, "mortgageYears": mortgageYears, "amortYears": a_years,
              "setup": [{"label": s["label"], "amount": s["amount"]} for s in setup],
              "opex": [{k: o[k] for k in ("label", "amount", "note", "cleaning") if k in o} for o in opex],
              "cleaningCost": cleaningCost, "cleaningTurns": cleaningTurns,
              "revenue": {c: cases[c].get("revenue") for c in ("low", "mid", "high")},
              "opexRangePct": rpar.get("opex"), "pmPct": rpar.get("pm"), "apprPct": rpar.get("appr"),
              "landPct": T["landPct"], "slaPct": 0.35, "bonusPct": T["bonusPct"], "taxRate": T["taxRate"]}
    return {"text": text, "md5": hashlib.md5(raw).hexdigest(), "notes": notes, "url": url, "preparedBy": prepared,
            "inputs": inputs, "sheet": sheet, "comps": comps, "layout": lay, "issues": issues, "block": block, "extras": extras,
            "setupRows": [s["row"] for s in setup], "opexRows": [o["row"] for o in opex]}


def zkey(url):
    p = urllib.parse.urlsplit(url.strip())
    return (p.netloc.lower().replace("www.", "") + p.path.rstrip("/")).lower()


def address_from_url(url):
    path = urllib.parse.urlsplit(url).path
    m = re.search(r"/homedetails/([^/]+)/(\d+)_zpid", path)
    slug, zpid = (m.group(1), m.group(2)) if m else (path.strip("/").split("/")[-1], None)
    tok = slug.split("-")
    if len(tok) >= 4 and re.fullmatch(r"[A-Z]{2}", tok[-2]) and re.fullmatch(r"\d{5}", tok[-1]):
        state, zp, rest = tok[-2], tok[-1], tok[:-2]
    else:
        state, zp, rest = "OH", None, tok
    city = None
    for c in CITIES:
        ct = c.split(" ")
        if [t.lower() for t in rest[-len(ct):]] == [t.lower() for t in ct]:
            city, rest = c, rest[:-len(ct)]
            break
    if city is None and len(rest) > 1:
        city, rest = rest[-1], rest[:-1]
    st = []
    for t in rest:  # Zillow writes "1/2" as "1-2"
        if st and t == "2" and st[-1] == "1":
            st[-1] = "1/2"
        else:
            st.append(t)
    street = " ".join(st)
    return {"slug": slug, "zpid": zpid, "street": street, "city": city, "state": state, "zip": zp,
            "address": f"{street}, {city}, {state} {zp}".replace(" None", "")}


# Geocoding (US Census), cached, with manual overrides.
CACHE_P, OVR_P = DATA / "geocode_cache.json", DATA / "geocode_overrides.json"
cache = json.loads(CACHE_P.read_text()) if CACHE_P.exists() else {}
if not OVR_P.exists():
    dump(OVR_P, {"_readme": "Manual pins, keyed by Zillow zpid: {\"12345678\": {\"lat\": 40.55, \"lng\": -81.90, \"note\": \"why\"}}. Overrides win over the geocoder.",
                 "overrides": {}})
overrides = json.loads(OVR_P.read_text()).get("overrides", {})


def census(addr):
    if addr in cache:
        return cache[addr]
    if OFFLINE:
        return None
    qs = urllib.parse.urlencode({"address": addr, "benchmark": "Public_AR_Current", "format": "json"})
    try:
        with urllib.request.urlopen("https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?" + qs, timeout=30) as resp:
            js = json.load(resp)
    except Exception as e:  # noqa: BLE001
        print(f"  geocoder error for {addr!r}: {e}")
        return None
    time.sleep(0.4)
    hits = js.get("result", {}).get("addressMatches", [])
    if not hits:
        return None
    h = hits[0]
    cache[addr] = {"lat": round(h["coordinates"]["y"], 6), "lng": round(h["coordinates"]["x"], 6), "matched": h["matchedAddress"], "nMatches": len(hits)}
    return cache[addr]


UA = "STRSearch-MillersburgUnderwriting/1.0 (+https://ifrahamstr.github.io/MillersburgMarketAnalysis/underwritten.html)"


def nominatim(q):
    """OpenStreetMap Nominatim, within its policy: one request a second, identified, cached (hits and misses)."""
    key = "nominatim:" + q
    if key in cache:
        return cache[key]
    if OFFLINE:
        return None
    time.sleep(1.1)
    qs = urllib.parse.urlencode({"q": q, "format": "jsonv2", "limit": "1", "countrycodes": "us", "addressdetails": "1"})
    try:
        req = urllib.request.Request("https://nominatim.openstreetmap.org/search?" + qs, headers={"User-Agent": UA, "Accept-Language": "en"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            js = json.load(resp)
    except Exception as e:  # noqa: BLE001
        print(f"  nominatim error for {q!r}: {e}")
        return None
    h = js[0] if js else None
    cache[key] = {"found": bool(h)} if not h else {
        "found": True, "lat": round(float(h["lat"]), 6), "lng": round(float(h["lon"]), 6), "matched": h.get("display_name"),
        "houseLevel": bool((h.get("address") or {}).get("house_number")), "type": h.get("addresstype") or h.get("type")}
    return cache[key]


def geocode(a):
    if a["zpid"] in overrides:
        o = overrides[a["zpid"]]
        return {"lat": o["lat"], "lng": o["lng"], "source": "override", "note": o.get("note"), "query": None, "matched": None}
    variants = [a["address"]]
    st = a["street"].split(" ")
    for k in range(len(st) - 1, 1, -1):  # drop trailing unit / fraction tokens one at a time
        variants.append(f"{' '.join(st[:k])}, {a['city']}, {a['state']} {a['zip']}")
    for i, q in enumerate(dict.fromkeys(variants)):
        hit = census(q)
        if hit:
            return {"lat": hit["lat"], "lng": hit["lng"], "source": "census", "query": q, "matched": hit["matched"],
                    "approximate": i > 0, "nMatches": hit.get("nMatches", 1)}
    # Census found nothing: try Nominatim. Only a house-level match is used; a street centroid can't place a house.
    n = nominatim(a["address"])
    a["nominatim"] = n
    if n and n.get("found") and n.get("houseLevel"):
        return {"lat": n["lat"], "lng": n["lng"], "source": "nominatim", "query": a["address"], "matched": n["matched"], "approximate": False}
    return None


# ---------------------------------------------------------------------------
# 4. Comp audit sources: the market workbook (source of truth) and any other
#    Millersburg*.xlsx beside it or in ../archive (reported, never used as truth)
# ---------------------------------------------------------------------------
ROOM_RE = re.compile(r"airbnb\.[a-z.]+/rooms/(?:plus/)?(\d+)", re.I)
TITLE_COLS = ["TITLE", "title", "name", "Listing Name"]
CLASS_LABEL = {"usable": "Usable", "possibly": "Usable, possibly good", "excluded": "Excluded for data quality", "never": "Never scored",
               "room": "Not an entire home", "removed": "In Removed_Listings", "missing": "Not in any workbook",
               "badurl": "Not a valid Airbnb URL", "zillow": "Zillow URL in a comp table"}
CLASS_SHORT = {"excluded": "Not Good Data", "never": "never scored", "room": "not an entire home", "removed": "in Removed_Listings",
               "missing": "not in any workbook", "badurl": "not a valid URL", "zillow": "Zillow URL"}
VALID = {"usable", "possibly"}
CLASS_ORDER = ["zillow", "badurl", "missing", "removed", "room", "excluded", "never", "possibly", "usable"]


def rooms(series):
    return series.astype(str).str.replace("abnb_", "", regex=False).str.extract(r"(\d+)")[0]


def norm_title(t):
    t = re.sub(r"\s+-\s+[^-]*\bfor Rent in\b.*$", "", str(t or ""), flags=re.I)  # Airbnb page title -> listing title
    t = re.sub(r"\s+-\s+Airbnb\s*$", "", t, flags=re.I)
    return re.sub(r"\s+", " ", t.replace("’", "'")).strip().lower()


def load_workbook(path):
    x = pd.ExcelFile(path, engine="openpyxl")
    cd = pd.read_excel(x, "Cleaned_Data")
    cd = cd[cd["Property ID"].notna()].copy()
    cd["room"] = rooms(cd["Property ID"])
    bt = pd.read_excel(x, "Base_Table", usecols=lambda c: c in ["Property ID", "Data Quality Category", "Quality Rating Reason", "roomType"] + TITLE_COLS)
    bt = bt[bt["Property ID"].notna()].copy()
    bt["room"] = rooms(bt["Property ID"])
    rl = pd.read_excel(x, "Removed_Listings") if "Removed_Listings" in x.sheet_names else pd.DataFrame()
    removed = set(rooms(rl.loc[rl["Property ID"].notna(), "Property ID"])) if "Property ID" in rl else set()
    snap = pd.to_datetime(cd["data_date"], errors="coerce", utc=True).max() if "data_date" in cd else pd.NaT
    rt = dict(zip(bt["room"], bt["roomType"]))
    titles = {}
    for _, row in bt.iterrows():
        for c in TITLE_COLS:
            if c in bt and pd.notna(row.get(c)):
                titles.setdefault(norm_title(row[c]), set()).add(row["room"])
    for rid, t in zip(cd["room"], cd["Listing_Title"]):
        titles.setdefault(norm_title(t), set()).add(rid)
    clean = {r["room"]: {"dq": r["Data Quality Category"] if pd.notna(r["Data Quality Category"]) else None, "roomType": rt.get(r["room"]),
                         "title": str(r["Listing_Title"])} for _, r in cd.iterrows()}
    base = {r["room"]: {"dq": r["Data Quality Category"] if pd.notna(r["Data Quality Category"]) else None,
                        "reason": r["Quality Rating Reason"] if pd.notna(r["Quality Rating Reason"]) else None,
                        "roomType": r["roomType"] if pd.notna(r["roomType"]) else None,
                        "title": next((str(r[c]) for c in TITLE_COLS if c in bt and pd.notna(r.get(c))), None)} for _, r in bt.iterrows()}
    return {"file": str(path.relative_to(mc.XLSX.parent)), "snapshot": None if pd.isna(snap) else snap.strftime("%Y-%m-%d"),
            "clean": clean, "base": base, "removed": removed, "titles": titles,
            "counts": {"Cleaned_Data": len(cd), "Base_Table": len(bt), "Removed_Listings": len(removed)}}


wb_paths = [mc.XLSX] + sorted(p for p in mc.XLSX.parent.glob("Millersburg*.xlsx") if p != mc.XLSX) + sorted((mc.XLSX.parent / "archive").glob("Millersburg*.xlsx"))
WBS = [load_workbook(p) for p in wb_paths]
MAIN = WBS[0]


def plain_reason(r):
    """'Missing Months is Bad Data: 6 (threshold: 5); Avg Reviews Per Month is Bad Data: 0.89 ...' -> plain words."""
    out = []
    for seg in str(r or "").split(";"):
        m = re.match(r"\s*(Total Months|Missing Months|Avg Reviews Per Month|High Season Reviews) is Bad Data: ([\d.]+)(?: \(threshold: ([\d.]+)\))?", seg)
        if not m:
            continue
        k, v, t = m.group(1), float(m.group(2)), m.group(3)
        out.append({"Total Months": f"only {v:g} months of history (needs {t})", "Missing Months": f"{v:g} missing months (allowed {t})",
                    "Avg Reviews Per Month": f"low review rate ({v:g} a month; needs {t})",
                    "High Season Reviews": f"few high-season reviews ({v:g}; needs {t})"}[k])
    return ", ".join(out) if out else str(r or "")


def appears_in(rid):
    out = []
    for w in WBS:
        sheets = [s for s, hit in (("Cleaned_Data", rid in w["clean"]), ("Base_Table", rid in w["base"]), ("Removed_Listings", rid in w["removed"])) if hit]
        if sheets:
            out.append(f"{w['file']} ({w['snapshot']}): {', '.join(sheets)}")
    return out


def wb_title(rid):
    for w in WBS:
        for src in ("clean", "base"):
            if rid in w[src] and w[src][rid].get("title"):
                return w[src][rid]["title"]
    return None


def title_candidates(text):
    t = norm_title(text)
    if not t:
        return []
    out = []
    for w in WBS:
        for rid in sorted(w["titles"].get(t, ())):
            if not any(c["id"] == rid for c in out):
                out.append({"id": rid, "url": f"https://www.airbnb.com/rooms/{rid}", "file": w["file"], "title": wb_title(rid)})
    for c in out:
        c["cls"] = classify(c["url"])["cls"]
    return out


def classify(url):
    """Exactly one audit class for a comp-table URL cell (see CLASS_LABEL)."""
    u = str(url or "").strip()
    if re.search(r"(^|[/.@])zillow\.com", u, re.I):
        return {"cls": "zillow", "id": None, "reason": "A Zillow listing is an acquisition target, never a comp"}
    m = ROOM_RE.search(u)
    if not m:
        return {"cls": "badurl", "id": None, "reason": ("The cell holds a listing title, not an airbnb.com/rooms/ link" if u else "The cell is empty"),
                "candidates": title_candidates(u)}
    rid = m.group(1)
    if rid in MAIN["clean"]:
        c = MAIN["clean"][rid]
        if c["roomType"] != "Entire home/apt":
            return {"cls": "room", "id": rid, "reason": f"{c['roomType'] or 'Not an entire home'} (in Cleaned_Data, but comps are entire homes)"}
        return {"cls": "usable" if c["dq"] == "Good Data" else "possibly", "id": rid, "reason": c["dq"]}
    if rid in MAIN["removed"]:
        return {"cls": "removed", "id": rid, "reason": "Listed in Removed_Listings"}
    if rid in MAIN["base"]:
        b = MAIN["base"][rid]
        if b["roomType"] and b["roomType"] != "Entire home/apt":
            return {"cls": "room", "id": rid, "reason": f"{b['roomType']} (Base_Table)"}
        if b["dq"] == "Not Good Data":
            return {"cls": "excluded", "id": rid, "reason": plain_reason(b["reason"])}
        if not b["dq"]:
            return {"cls": "never", "id": rid, "reason": "In Base_Table with no Data Quality Category, so it never reached Cleaned_Data"}
        return {"cls": "missing", "id": rid, "reason": f"Scored {b['dq']} in Base_Table but not in Cleaned_Data"}
    seen = appears_in(rid)
    return {"cls": "missing", "id": rid, "reason": "Not in any workbook scanned" if not seen else "Not in the current workbook; only in " + "; ".join(seen)}


# Self-checks on the classifier (cheap; run every build).
assert classify("https://www.zillow.com/homedetails/123-Example-Rd-Millersburg-OH-44654/12345678_zpid/")["cls"] == "zillow"
assert classify("Cozy cabin with hot tub - Cabins for Rent in Millersburg, Ohio, United States - Airbnb")["cls"] == "badurl"
assert classify("https://www.airbnb.com/rooms/50463359")["cls"] == "room"  # the one private room in Cleaned_Data
assert classify("https://www.airbnb.com/rooms/" + listings[0]["id"])["cls"] in VALID

# ---------------------------------------------------------------------------
# 5. Read the sheets, group into targets / scenarios, audit the comps
# ---------------------------------------------------------------------------
LIST = {x["id"]: x for x in listings}
validation = {"duplicateProperties": [], "duplicateFiles": [], "mortgageYears": [], "debtService": [], "sheetTotals": [],
              "geocode": [], "parse": [], "committed": []}

VL_P = DATA / "version_labels.json"
if not VL_P.exists():
    dump(VL_P, {"_readme": "Scenario names for targets underwritten in more than one file, keyed by file number. "
                           "A value is a name, or {\"label\": name, \"default\": true} to open that scenario first. "
                           "Otherwise the lowest file number opens first; unnamed files show as 'File NN'.",
                })
VLABELS = {k: v for k, v in json.loads(VL_P.read_text()).items() if not k.startswith("_")}


def scenario_of(number):
    e = VLABELS.get(str(number))
    if isinstance(e, dict):
        return e.get("label") or f"File {number}", bool(e.get("default"))
    return (e or f"File {number}"), False


def value_changes(c, cur):
    ch = []

    def cmp(field, old, new, tol):
        if old is None or new is None or abs(float(old) - float(new)) > tol:
            ch.append({"field": field, "sheet": old, "current": new})

    cmp("revenue", c["revenue"], cur["revenue"], 0.51)
    cmp("bedrooms", c["bedrooms"], cur["bedrooms"], 0.01)
    cmp("sleeps", c["sleeps"], cur["sleeps"], 0.01)
    cmp("adr", c["adr"], round(cur["adr"], 2), 0.006)
    # Several sheets typed occupancy to one decimal (57.9 for 57.93): within 0.05 points is the same value.
    cmp("occupancy", None if c["occupancy"] is None else round(c["occupancy"] * 100, 2), round(cur["occ"] * 100, 2), 0.051)
    for f in SHEET_FLAGS:
        cmp("HAS_" + f, (c.get("flags") or {}).get(f, 0), int(f in cur["flags"]), 0)
    return ch


AUDIT_INDEX, BAD_URLS = {}, {}


def audit_comp(c):
    """Class + reason + value changes for one comp row; also fills the browser's lookup tables."""
    k = classify(c.get("url"))
    out = {"cls": k["cls"], "label": CLASS_LABEL[k["cls"]], "valid": k["cls"] in VALID, "reason": k["reason"], "id": k["id"],
           "changes": [], "bigRevenue": False, "bedroomsChanged": False, "revenueChangePct": None, "currentRevenue": None, "currentBedrooms": None}
    if k["id"]:
        AUDIT_INDEX.setdefault(k["id"], {"cls": k["cls"], "reason": k["reason"], "title": wb_title(k["id"]), "appearsIn": appears_in(k["id"])})
    if k["cls"] == "badurl":
        out["candidates"] = k.get("candidates", [])
        BAD_URLS.setdefault(str(c.get("url") or "").strip(), {"reason": k["reason"], "candidates": out["candidates"]})
    if out["valid"]:
        cur = LIST[k["id"]]
        out["changes"] = value_changes(c, cur)
        out["currentRevenue"], out["currentBedrooms"] = cur["revenue"], cur["bedrooms"]
        if c.get("revenue"):
            out["revenueChangePct"] = round((cur["revenue"] - c["revenue"]) / c["revenue"] * 100, 1)
            out["bigRevenue"] = abs(cur["revenue"] - c["revenue"]) / c["revenue"] > 0.15
        out["bedroomsChanged"] = c.get("bedrooms") is not None and abs(cur["bedrooms"] - c["bedrooms"]) > 0.01
    return out


files = sorted(SRC.glob("*.csv"), key=lambda p: (int(re.search(r"- (\d+)", p.name).group(1)), p.name))
groups = {}
for p in files:
    s = parse_sheet(p)
    m = re.search(r"- (\d+)(?: \((\d+)\))?\.csv$", p.name)
    s.update(file=p.name, number=int(m.group(1)), copy=int(m.group(2)) if m.group(2) else None)
    for iss in s["issues"]:
        validation["parse"].append({"file": p.name, "issue": iss})
    groups.setdefault(zkey(s["url"]), []).append(s)

properties, amort_out, audit_rows = [], {}, []
for key, sheets in groups.items():
    # Byte-identical files collapse into one version.
    seen, versions = {}, []
    for s in sheets:
        if s["md5"] in seen:
            seen[s["md5"]]["files"].append(s["file"])
            validation["duplicateFiles"].append({"files": [seen[s["md5"]]["file"], s["file"]], "note": "byte-identical; shown once"})
            continue
        s["files"] = [s["file"]]
        seen[s["md5"]] = s
        versions.append(s)
    nums = [v["number"] for v in versions]
    for v in versions:
        v["label"] = str(v["number"]) if nums.count(v["number"]) == 1 else f"{v['number']} ({v['copy'] or 1})"
        v["scenario"], v["isDefault"] = scenario_of(v["number"])
    versions.sort(key=lambda v: (v["number"], v["copy"] or 0))
    # Scenarios, not "latest": the one marked default in version_labels.json, else the lowest file number.
    default = next((v for v in versions if v["isDefault"]), versions[0])
    a = address_from_url(default["url"])
    geo = geocode(a)
    files_of = [f for v in versions for f in v["files"]]
    if geo is None:
        n = a.get("nominatim")
        osm = ("Nominatim found nothing" if n and not n.get("found") else
               f"Nominatim found only {n.get('type') or 'an area'}-level match ({n.get('matched')}), not the house" if n else "Nominatim not tried (offline)")
        validation["geocode"].append({"address": a["address"], "zpid": a["zpid"], "files": files_of, "nominatim": n,
                                      "issue": "Census geocoder found no match; " + osm + ". Place it on the map, then Export pins to data/geocode_overrides.json"})
        loc = None
    else:
        if geo.get("approximate"):
            validation["geocode"].append({"address": a["address"], "zpid": a["zpid"], "files": files_of,
                                          "issue": f"matched only as '{geo['query']}' -> {geo['matched']}; check the pin"})
        loc = place(geo["lat"], geo["lng"], default["notes"])
    out_versions = []
    for v in versions:
        det = parse_notes(v["notes"])
        comps = []
        for c in v["comps"]:
            au = audit_comp(c)
            comps.append({**c, "audit": au})
            audit_rows.append({"targetId": a["zpid"], "target": a["street"], "file": v["label"], "scenario": v["scenario"], "row": c["row"],
                               "url": c["url"], "id": au["id"], "title": wb_title(au["id"]) if au["id"] else None, "cls": au["cls"], "label": au["label"],
                               "valid": au["valid"], "reason": au["reason"], "sheetRevenue": c["revenue"], "currentRevenue": au["currentRevenue"],
                               "revenueChangePct": au["revenueChangePct"], "bigRevenue": au["bigRevenue"], "sheetBedrooms": c["bedrooms"],
                               "currentBedrooms": au["currentBedrooms"], "bedroomsChanged": au["bedroomsChanged"], "changes": au["changes"],
                               "appearsIn": AUDIT_INDEX.get(au["id"], {}).get("appearsIn", []) if au["id"] else [], "candidates": au.get("candidates", [])})
        ids = [c["id"] for c in v["comps"] if c["id"]]
        dup_ids = sorted({i for i in ids if ids.count(i) > 1})
        checks = []
        if dup_ids:
            checks.append({"kind": "comp-duplicate", "text": "The same listing appears more than once in the comp table: " + ", ".join(dup_ids)})
        sh, inp = v["sheet"], v["inputs"]
        if sh["mortgageYears"] != sh["amort"]["years"]:
            msg = (f"'Mortgage Years' says {sh['mortgageYears']:g} but the amortization block (and so Debt Service) uses "
                   f"{sh['amort']['years']:g} years")
            checks.append({"kind": "mortgage-years", "text": msg})
            validation["mortgageYears"].append({"file": v["label"], "address": a["street"], "mortgageYears": sh["mortgageYears"], "amortYears": sh["amort"]["years"]})
        rr = sh["amort"]["rate"] / 12
        n = sh["amort"]["years"] * 12
        pay = sh["amort"]["loan"] * rr / (1 - (1 + rr) ** -n)
        ds = sh["cases"]["mid"]["ds"]
        ds_issues = []
        if abs(ds - 12 * pay) > 1:
            ds_issues.append(f"Debt Service ${ds:,.0f} vs 12 x the block's payment ${12 * pay:,.0f}")
        if abs(sh["amort"]["loan"] - sh["loan"]) > 1:
            ds_issues.append(f"block loan ${sh['amort']['loan']:,.0f} vs sheet loan ${sh['loan']:,.0f}")
        if abs(sh["amort"]["rate"] - inp["rate"]) > 1e-9:
            ds_issues.append(f"block rate {sh['amort']['rate']:.2%} vs sheet rate {inp['rate']:.2%}")
        # True principal repaid (reporting only; the block itself is stored verbatim and never edited).
        bal, cum = sh["amort"]["loan"], []
        for _ in range(60):
            pr = pay - bal * rr
            bal -= pr
            cum.append((cum[-1] if cum else 0) + pr)
        excess = (sh["amort"]["paid12"] or 0) - cum[11]
        sheet_p = sh["cases"]["mid"]["principal"]
        if abs(excess) > 1 and abs(sheet_p - sh["amort"]["paid12"]) <= 1:
            ds_issues.append(
                f"the block's Total Paydown column runs ${excess:,.2f} ahead of the principal actually repaid, from its month-2 row on "
                f"(${sh['amort']['paid2']:,.0f} where ${sh['amort']['principal1']:,.0f} + ${sh['amort']['principal2']:,.0f} were repaid; it ends at "
                f"${sh['amort']['paidLast']:,.0f} on a ${sh['amort']['loan']:,.0f} loan). Principal Pay Down (${sheet_p:,.0f}) reads that column; "
                f"year-1 principal is ${cum[11]:,.0f}. 5-year Equity (${sh['fiveYear']['equity']:,.0f}) uses the correct figure (${cum[59]:,.0f}).")
        elif sheet_p is not None and abs(sheet_p - cum[11]) > 1:
            ds_issues.append(f"Principal Pay Down ${sheet_p:,.0f} vs the principal actually repaid in year 1, ${cum[11]:,.0f}")
        for t in ds_issues:
            checks.append({"kind": "debt-service", "text": t})
            validation["debtService"].append({"file": v["label"], "address": a["street"], "issue": t})
        setup_sum = sum(s["amount"] or 0 for s in inp["setup"])
        tot = []
        if abs(setup_sum - (sh["setupTotalList"] or 0)) > 0.5:
            tot.append(f"setup items add to ${setup_sum:,.0f}, the list's Total says ${sh['setupTotalList']:,.0f}")
        if abs((sh["setupTotalList"] or 0) - (sh["setupTotal"] or 0)) > 0.5:
            tot.append(f"Renovation / Amenities / Furniture ${sh['setupTotal']:,.0f} vs setup Total ${sh['setupTotalList']:,.0f}")
        clean = (inp["cleaningCost"] or 0) * (inp["cleaningTurns"] or 0)
        opex_sum = sum((clean if o.get("cleaning") else (o["amount"] or 0)) for o in inp["opex"])
        if abs(opex_sum - sh["opexMonthly"]) > 0.5:
            tot.append(f"OPEX items add to ${opex_sum:,.2f}/mo, the sheet's total says ${sh['opexMonthly']:,.0f} (a cell shows a rounded value)")
        if sh["cleaning"] is not None and abs(clean - sh["cleaning"]) > 0.5:
            tot.append(f"Cleaning ${sh['cleaning']:,.0f}/mo vs cost per clean x turns ${clean:,.2f}")
        for t in tot:
            checks.append({"kind": "totals", "text": t})
            validation["sheetTotals"].append({"file": v["label"], "address": a["street"], "issue": t})
        for iss in v["issues"]:
            checks.append({"kind": "parse", "text": iss})
        amort_out[v["file"]] = v["block"]
        out_versions.append({
            "label": v["label"], "number": v["number"], "scenario": v["scenario"], "isDefault": v is default,
            "file": v["file"], "files": v["files"], "md5": v["md5"],
            "notes": v["notes"], "preparedBy": v["preparedBy"], "url": v["url"], "details": det,
            "inputs": inp, "sheet": sh, "comps": comps, "layout": v["layout"], "checks": checks, "extras": v["extras"],
            "amortRows": [v["block"]["startRow"], v["block"]["endRow"]],
        })
    properties.append({"id": a["zpid"] or hashlib.md5(key.encode()).hexdigest()[:10], "key": key, "kind": "underwritten",
                       "url": default["url"].split("?")[0], "address": a["address"], "street": a["street"], "city": a["city"],
                       "zip": a["zip"], "geo": geo, "place": loc, "versions": out_versions, "defaultVersion": default["label"],
                       "geocodeNote": None if geo else validation["geocode"][-1]["issue"]})

# Possible duplicates: identical projected bed/bath, lot and size under different addresses.
seen = {}
for p in properties:
    for v in p["versions"]:
        d = v["details"]
        sig = (d["beds"], d["baths"], d["lot"], d["size"])
        if None in sig:
            continue
        seen.setdefault(sig, []).append((p, v))
for sig, hits in seen.items():
    addrs = {p["id"] for p, _ in hits}
    if len(addrs) > 1:
        validation["duplicateProperties"].append({
            "details": {"beds": sig[0], "baths": sig[1], "lot": sig[2], "size": sig[3]},
            "properties": [{"id": p["id"], "address": p["street"], "file": v["label"], "price": v["inputs"]["price"]} for p, v in hits]})
dupe_ids = {x["id"] for d in validation["duplicateProperties"] for x in d["properties"]}
for p in properties:
    for v in p["versions"]:
        if p["id"] in dupe_ids:
            others = [x for d in validation["duplicateProperties"] if any(y["id"] == p["id"] for y in d["properties"]) for x in d["properties"] if x["id"] != p["id"]]
            v["checks"].append({"kind": "duplicate", "text": "Same bed/bath, lot and size as " + "; ".join(f"{x['address']} (file {x['file']})" for x in others) +
                                ". Possibly the same house under two addresses, or details copied from another sheet."})

# New-listing templates (underwriting/template/): the sheet a new listing starts from. Only the
# layout and the team's financing and tax assumptions carry over (down payment, rate, closing,
# amortization, OPEX range, PM fee, appreciation, land / bonus / tax rate). The template is a
# Galveston sheet, so its own setup items, OPEX amounts and cleaning cost are left blank for
# Millersburg numbers (the five standard setup lines stay); OPEX keeps its line labels.
templates = []
for tp in sorted(TEMPLATE_DIR.glob("*.csv")):
    t = parse_sheet(tp)
    for iss in t["issues"]:
        validation["parse"].append({"file": "template/" + tp.name, "issue": iss})
    ti = t["inputs"]
    neutral = dict(ti, price=None, setup=[dict(x) for x in STANDARD_SETUP], revenue={"low": None, "mid": None, "high": None}, cleaningCost=None, cleaningTurns=None,
                   opex=[dict(o, amount=None if o.get("cleaning") else STANDARD_OPEX.get(o["label"].strip().lower()), std=1) for o in ti["opex"]])
    neutral.update(cleaningCost=275, cleaningTurns=6)
    templates.append({"file": tp.name, "path": "underwriting/template/" + tp.name, "label": "template", "street": "Blank sheet",
                      "kept": {k: ti[k] for k in ("dpPct", "rate", "closingPct", "mortgageYears", "amortYears", "opexRangePct", "pmPct", "apprPct",
                                                   "landPct", "slaPct", "bonusPct", "taxRate")},
                      "inputs": neutral, "sheetInputs": ti, "sheet": t["sheet"], "md5": t["md5"]})
assert templates, "underwriting/template/ needs the sheet a new listing starts from"
TEMPLATE_FILE = templates[0]["file"]

# Order: west -> east (toward Killbuck, Millersburg, toward Berlin), as the areas are ordered.
order = {a: i for i, a in enumerate(mc.AREA_SHORT[x] for x in mc.AREA_ORDER)}
properties.sort(key=lambda p: (order.get((p["place"] or {}).get("area"), 99), p["street"]))
porder = {p["id"]: i for i, p in enumerate(properties)}

# Committed browser edits / new listings (exported from the page, committed by hand).
LOCAL_P = DATA / "underwritten_local.json"
committed = {"listings": [], "edits": {}}
if LOCAL_P.exists():
    loc_js = json.loads(LOCAL_P.read_text())
    keys = {p["key"]: p["id"] for p in properties}
    for li in loc_js.get("listings", []):
        k = zkey(li.get("url", "")) if li.get("url") else None
        if k and k in keys:
            validation["committed"].append({"id": li.get("id"), "issue": f"{li.get('address')} is now a source CSV; the committed copy is skipped"})
            continue
        for c in li.get("comps", []):
            au = audit_comp(c)
            if not au["valid"]:
                validation["committed"].append({"id": li.get("id"), "issue": f"comp {c.get('id') or c.get('url')}: {au['label']}"})
        committed["listings"].append(li)
    pids = {p["id"] for p in properties}
    for pid, ed in (loc_js.get("edits") or {}).items():
        if pid not in pids:
            validation["committed"].append({"id": pid, "issue": "edit for a property that is no longer in source_csv; skipped"})
            continue
        for lab, ve in (ed.get("versions") or {}).items():
            for c in ve.get("comps") or []:
                au = audit_comp(c)
                if not au["valid"]:
                    validation["committed"].append({"id": pid, "issue": f"file {lab} comp {c.get('id') or c.get('url')}: {au['label']}"})
        committed["edits"][pid] = ed

# Audit table: errors first, then big revenue / bedroom changes, then the rest.
audit_rows.sort(key=lambda r: (0 if not r["valid"] else 1 if (r["bigRevenue"] or r["bedroomsChanged"]) else 2,
                               porder.get(r["targetId"], 99), r["file"], r["row"]))


def summary_line(rows):
    n = len(rows)
    if not n:
        return "No comps."
    cnt = {c: sum(r["cls"] == c for r in rows) for c in CLASS_LABEL}
    errs = [r for r in rows if not r["valid"]]
    big = sum(r["bigRevenue"] for r in rows)
    beds = sum(r["bedroomsChanged"] for r in rows)
    parts = [f"{n} comps: {cnt['usable']} usable", f"{cnt['possibly']} possibly good"]
    e = f"{len(errs)} error{'s' if len(errs) != 1 else ''}"
    if errs:
        e += " (" + ", ".join(f"{cnt[c]} {CLASS_SHORT[c]}" for c in CLASS_ORDER if c in CLASS_SHORT and cnt[c]) + ")"
    parts.append(e)
    tail = f"{big} changed by more than 15%" + (f", {beds} with a different bedroom count" if beds else "")
    return ", ".join(parts) + ", " + tail + "."


summaries = []
for p in properties:
    for v in p["versions"]:
        rows = [r for r in audit_rows if r["targetId"] == p["id"] and r["file"] == v["label"]]
        s = summary_line(rows)
        v["auditSummary"] = s
        v["auditErrors"] = sum(not r["valid"] for r in rows)
        summaries.append({"targetId": p["id"], "target": p["street"], "file": v["label"], "scenario": v["scenario"], "summary": s, "errors": v["auditErrors"]})

REPORTS = ROOT / "reports"
REPORTS.mkdir(exist_ok=True)
with open(REPORTS / "comp_audit.csv", "w", newline="", encoding="utf-8") as fh:
    w = csv.writer(fh, lineterminator="\n")
    w.writerow(["target", "file", "scenario", "row", "comp_url", "room_id", "title", "class", "valid", "reason", "sheet_revenue", "current_revenue",
                "revenue_change_pct", "revenue_change_over_15pct", "sheet_bedrooms", "current_bedrooms", "bedrooms_changed", "other_changes",
                "appears_in", "title_match_candidates"])
    for r in audit_rows:
        other_ch = "; ".join(f"{c['field']} {c['sheet']} -> {c['current']}" for c in r["changes"] if c["field"] not in ("revenue", "bedrooms"))
        w.writerow([r["target"], r["file"], r["scenario"], r["row"], r["url"], r["id"] or "", r["title"] or "", r["label"], "yes" if r["valid"] else "no",
                    r["reason"] or "", "" if r["sheetRevenue"] is None else round(r["sheetRevenue"], 2), "" if r["currentRevenue"] is None else r["currentRevenue"],
                    "" if r["revenueChangePct"] is None else r["revenueChangePct"], "yes" if r["bigRevenue"] else "",
                    "" if r["sheetBedrooms"] is None else f"{r['sheetBedrooms']:g}", "" if r["currentBedrooms"] is None else f"{r['currentBedrooms']:g}",
                    "yes" if r["bedroomsChanged"] else "", other_ch, " | ".join(r["appearsIn"]),
                    " | ".join(f"{c['id']} ({CLASS_LABEL[c['cls']]})" for c in r["candidates"])])

dump(DATA / "underwritten.json", {
    "generatedFrom": {"csvFolder": "underwriting/source_csv", "files": [p.name for p in files], "workbook": mc.XLSX.name, "snapshot": mc.SNAPSHOT,
                      "local": LOCAL_P.name if LOCAL_P.exists() else None},
    "compHeader": COMP_HEADER, "sheetFlags": SHEET_FLAGS, "templateFile": TEMPLATE_FILE, "templates": templates,
    "rules": {"area": f"the nearest Airbnb listing's area ({LOO} of {len(df)} listings get their own area in a leave-one-out test)",
              "zone": "Village if inside the Millersburg village limits (US Census TIGER boundary), else Countryside",
              "loc": f"same rules as the listings: Downtown = in the village and within {mc.DOWNTOWN_KM * 1000:.0f} m of the Holmes County Courthouse, "
                     "Village = the rest of the village, Countryside = outside the village limits",
              "geocode": "US Census geocoder (address-range interpolation along the street), then OpenStreetMap Nominatim (house-level matches only); "
                         "overrides in data/geocode_overrides.json",
              "default": "the scenario marked default in data/version_labels.json, else the lowest file number"},
    "audit": {"workbooks": [{"file": w["file"], "snapshot": w["snapshot"], "counts": w["counts"], "truth": i == 0} for i, w in enumerate(WBS)],
              "classes": CLASS_LABEL, "valid": sorted(VALID), "rows": audit_rows, "summaries": summaries, "index": AUDIT_INDEX, "badUrls": BAD_URLS,
              "report": "reports/comp_audit.csv"},
    "properties": properties, "validation": validation, "committed": committed,
})
dump(DATA / "amortization.json", amort_out)
CACHE_P.write_text(json.dumps(dict(sorted(cache.items())), ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
def money_s(x):
    return "—" if x is None else f"${x:,.0f}"


print(f"comps.json: {len(listings)} entire homes (of {len(allc)} cleaned; {len(other)} private/hotel rooms left out). "
      f"{sum(x['revenue'] >= MIN_REV for x in listings)} earn ${MIN_REV // 1000}k+ (the default floor).")
print("  zones: " + ", ".join(f"{z} {sum(x['zone'] == z for x in listings)}" for z in mc.ZONE_ORDER) +
      " · settings: " + ", ".join(f"{z} {sum(x['loc'] == z for x in listings)}" for z in mc.LOC_ORDER) +
      " · areas: " + ", ".join(f"{a['name']} {a['n']}" for a in areas_out))
print(f"  area rule for a new point (nearest listing): {LOO} of {len(df)} listings in a leave-one-out test")
print(f"village.json: {VJ['name']} ({sum(len(x) for x in VJ['rings'])} boundary points, {len(VJ['rings'])} rings)")
print(f"templates: " + ", ".join(t["file"] for t in templates))
print(f"underwritten.json: {len(properties)} acquisition targets, {sum(len(p['versions']) for p in properties)} scenarios from {len(files)} files")
for p in properties:
    pl = p["place"] or {}
    g_ = p["geo"] or {}
    sc = ", ".join(f"{v['label']} {v['scenario']}" + (" (default)" if v["isDefault"] and len(p["versions"]) > 1 else "") for v in p["versions"])
    print(f"  {p['street']:<28} {sc:<40} {pl.get('areaName', '?'):<24} {pl.get('loc', '?'):<12} "
          f"{pl.get('centerKm', float('nan')):.2f} km  geocode: {g_.get('source', 'FAILED')}{' (approx)' if g_.get('approximate') else ''}")
V = validation
print("\nCOMP AUDIT  (workbooks scanned: " + "; ".join(f"{w['file']} snapshot {w['snapshot']}" + (" = source of truth" if i == 0 else "")
                                                     for i, w in enumerate(WBS)) + ")")
for s_ in summaries:
    print(f"  {s_['target']:<24} file {s_['file']:<4} {s_['scenario'] if s_['scenario'] != 'File ' + s_['file'] else '':<13} {s_['summary']}")
print("  Errors:")
for r in audit_rows:
    if not r["valid"]:
        cand = (" candidates: " + ", ".join(f"{c['id']} ({CLASS_LABEL[c['cls']]})" for c in r["candidates"])) if r["candidates"] else ""
        print(f"    {r['target']} file {r['file']} row {r['row']}: {r['id'] or r['url'][:50]!s} -> {r['label']}: {r['reason']}{cand}")
print("  Bedroom-count changes / revenue changes over 15%:")
for r in audit_rows:
    if r["valid"] and (r["bedroomsChanged"] or r["bigRevenue"]):
        b = f"bedrooms {r['sheetBedrooms']:g} -> {r['currentBedrooms']:g}" if r["bedroomsChanged"] else ""
        rv = f"revenue {money_s(r['sheetRevenue'])} -> {money_s(r['currentRevenue'])} ({r['revenueChangePct']:+.1f}%)" if r["bigRevenue"] else ""
        print(f"    {r['target']} file {r['file']} row {r['row']}: {r['id']} " + "; ".join(x for x in (b, rv) if x))
print(f"  -> reports/comp_audit.csv ({len(audit_rows)} rows)")
print("\nSHEET CHECKS")
print(f"- Possible duplicate targets ({len(V['duplicateProperties'])}):")
for d in V["duplicateProperties"]:
    print("    " + " and ".join(f"{x['address']} (file {x['file']}, {money_s(x['price'])})" for x in d["properties"]) +
          f": same {d['details']['beds']:g} / {d['details']['baths']:g} bed/bath, lot {d['details']['lot']:,.0f}, size {d['details']['size']:,.0f} sqft")
print(f"- Duplicate files ({len(V['duplicateFiles'])}): " + "; ".join(" = ".join(d["files"]) for d in V["duplicateFiles"]))
print(f"- Mortgage Years differs from Amortization Years ({len(V['mortgageYears'])}): " +
      ", ".join(f"{x['file']} ({x['mortgageYears']:g} vs {x['amortYears']:g})" for x in V["mortgageYears"]))
print(f"- Debt service / amortization disagreements ({len(V['debtService'])}):")
for x in V["debtService"]:
    print(f"    file {x['file']} ({x['address']}): {x['issue']}")
print(f"- Sheet totals that don't add up from the displayed cells ({len(V['sheetTotals'])}):")
for x in V["sheetTotals"]:
    print(f"    file {x['file']} ({x['address']}): {x['issue']}")
print(f"- Geocoding ({len(V['geocode'])}):")
for x in V["geocode"]:
    print(f"    {x['address']}: {x['issue']}")
for k in ("parse", "committed"):
    if V[k]:
        print(f"- {k}: {V[k]}")

if shutil.which("node"):
    print(flush=True)
    rc = subprocess.call(["node", str(ROOT / "tests" / "test_underwritten.mjs")], cwd=ROOT)
    if rc:
        sys.exit(rc)
else:
    print("\n(node not found: run tests/test_underwritten.mjs for the formula and export tests)")
