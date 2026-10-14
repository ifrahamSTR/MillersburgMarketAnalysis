# Millersburg, OH — Underwriting map

Static site (no build step in the browser). So far it holds only the **underwriting map** (`underwritten.html`); `index.html` forwards to it and keeps any `#p=…` link. It is the Galveston site's Underwritten Properties page, adapted for a small inland market. The market analysis sections are not built yet.

Live: https://ifrahamstr.github.io/MillersburgMarketAnalysis/ (repo `ifrahamSTR/MillersburgMarketAnalysis`).

## What's on the page

- **Airbnb comps:** the 62 entire homes in the workbook's `Cleaned_Data` (`../Millersburg - OH.xlsx`, snapshot 2026-10-05). The one private room in `Cleaned_Data` (abnb_50463359) is left out.
- **Acquisition targets:** the Zillow houses. There are no underwritten Millersburg sheets yet, so targets are added on the page with **+ Add listing**: paste the Zillow URL, type the price and beds / baths, then let OpenStreetMap find the house or click the map to place it.
- **Matching:**
  - **Match by location:** same zone (inside the village limits or out in the countryside; a toggle), bedrooms ±1, revenue $40k+ (the market median, $41.9k, rounded down; editable), nearest first. "Show pure nearest" drops every rule.
  - **Match by amenities:** ranks all 62 homes best to worst and excludes none: bedrooms, then sleeps, then pool, then the other amenities, then revenue.
- **Comp sets:** add comps from the map or the lists (15 at most, the sheet's limit), copy them as sheet rows (15 columns, revenue high to low), and download the UW CSV.
- Everything else works as on the Galveston page: target profile, sheet tab, data checks, export / import of browser edits. See the Galveston README for the detail.

## Location model (`../notebooks/market_common.py`)

| | Rule | Listings |
|---|---|---|
| **Zone** | Village if inside the Millersburg village limits (US Census TIGER, GEOID 3950372, saved in `../notebooks/millersburg_village_tiger.json`), else Countryside | Village 20, Countryside 42 |
| **Setting** | Downtown = in the village and within 300 m of the Holmes County Courthouse (the square); Village = the rest of the village; Countryside = outside the limits. Listings fall either side of a clear gap (0.21 km and 0.41 km), so the 300 m line isn't sensitive. | Downtown 7 (median $21k), Village 13 ($38k), Countryside 42 ($46k) |
| **Area** | 3 Ward clusters on projected coordinates, named west to east. A new target takes its nearest listing's area (61 of 62 listings in a leave-one-out test; the 3-nearest vote used in Galveston gets 59). | West, toward Killbuck 4 · Millersburg 21 · East, toward Berlin 37 |

The browser rules (`js/underwritten/uw-geo.js`) are checked against the Python build on 794 points (`tests/fixtures/place_check.json`).

Area outlines are off by default. The east area's convex hull is large and overlaps the village. The village limits and the 300 m downtown ring are on by default.

## New listings start from a blank sheet

`underwriting/template/New Market UW'ing - template (from 101).csv` is Galveston file 101 (the "New Market UW'ing" layout). A new listing keeps only the team's financing and tax assumptions from it:
- 20% down, 7.25%, 3% closing;
- the 30-year amortization block, and "Mortgage Years" 20 as the sheet has it;
- OPEX ±4%, PM 0%, appreciation 3.5%;
- land 20%, SLAs 35%, bonus 100%, tax rate 37%.

The setup list starts with just the five standard lines (below); file 101's other setup items, the OPEX amounts, the cleaning cost and the revenue cases start blank, because Galveston's numbers don't fit a Millersburg cabin. Until an OPEX amount is entered, a new listing's cash flow, cash on cash and total return stay blank (a data check says why), rather than showing a return with no operating costs.

Download UW CSV writes the listing's inputs into the template's cells and clears the template's setup, OPEX, cleaning and revenue cells. The amortization block is copied byte for byte. As on Galveston, totals and returns in the CSV keep the template's values until the inputs are entered in the Google Sheet.

## Pipeline

1. `python scripts/build_underwritten.py` (the `str` venv: pandas, scipy, scikit-learn, matplotlib). Add `--offline` to skip the geocoder. It writes:
   - `data/comps.json`, `data/village.json`, `data/underwritten.json` (properties, the template, the comp audit);
   - `data/amortization.json`, `data/geocode_cache.json`, `reports/comp_audit.csv`, `tests/fixtures/place_check.json`.

   It then runs `node tests/test_underwritten.mjs` and exits non-zero on a failure.
2. When Millersburg sheets exist, drop the "New Market UW'ing - NN.csv" exports into `underwriting/source_csv/` and rebuild. They become underwritten targets with the formula checks and comp audit, as in Galveston. Name scenarios in `data/version_labels.json`.
3. Browser test: `NODE_PATH=<folder with playwright-core's node_modules> node tests/test_underwritten_browser.mjs`. It uses the system Chrome and serves this folder itself. It covers:
   - adding a Zillow listing and placing its pin;
   - zone, setting and area read from the pin;
   - both matching modes;
   - copy row, copy comps and the download;
   - the blank-OPEX guard;
   - colour by setting, shared links, the 420 px phone view and the `index.html` redirect;
   - no console errors.

## Files

- `underwritten.html`, `index.html` (redirect), `css/styles.css` (shared template), `css/underwritten.css`.
- `js/underwritten/`: the Galveston modules. These carry Millersburg-specific changes:
  - `uw-geo.js` (village / setting / area rules);
  - `uw-rules.js` (location match by zone only, no water rule);
  - `uw-app.js` (village layer, $40k floor, revenue bands, blank template, OPEX guard);
  - `uw-map.js`, `uw-panel.js`, `uw-cards.js`, `uw-add.js`, `uw-checks.js`, `uw-main.js` (wording and fields);
  - `uw-csv.js` (a `null` cleaning cost clears the cell).
- `scripts/build_underwritten.py`, `tests/test_underwritten.mjs`, `tests/test_underwritten_browser.mjs`.

**Standard setup lines (2026-10-14):** every new underwriting sheet made on the page carries the five lines every "UW'ing" sheet has, in their usual rows: Furniture / Decor / Essentials (row 5), Misc, CoHost Essentials, Design/Project Management and Install/Staging/Warehousing (rows 16–19). A line that is missing or has no amount gets Galveston file 101's amount ($50,000 / $25,000 / $3,500 / $25,000 / $18,250); a line the starting sheet already prices keeps its own amount. Rule: `UWRules.withStandardSetup` in `js/underwritten/uw-rules.js`, applied when a listing is created and whenever a new-listing sheet is shown or downloaded.
