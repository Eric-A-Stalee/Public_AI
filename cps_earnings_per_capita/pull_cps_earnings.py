#!/usr/bin/env python3
"""CPS real weekly earnings per capita (non-earners counted at $0).

Builds a monthly series, Jan 2015 -> latest available month, from CPS basic
monthly public-use microdata. Re-run monthly; already-downloaded months are
cached and only re-fetched when Census replaces the file (Last-Modified change).

Outputs (written next to this script unless --out-dir is given):
  cps_earnings_per_capita.csv     one row per month x population (the deliverable)
  cps_earnings_diagnostics.csv    sample counts, weight checks, topcode share
  validation_vs_bls.csv           quarterly ft_earner_median vs BLS LEU0252881500

Data source: Census public-use files at
  https://www2.census.gov/programs-surveys/cps/datasets/{YYYY}/basic/{mon}{yy}pub.dat.gz
These are the same microdata the Census API (api.census.gov/data/{YYYY}/cps/basic/{mon})
serves; the API now refuses keyless requests, the bulk files do not.

Usage:
  python3 pull_cps_earnings.py               # incremental update
  python3 pull_cps_earnings.py --refresh     # re-download every month
"""

import argparse
import gzip
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request
import zipfile
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
BASE_URL = "https://www2.census.gov/programs-surveys/cps/datasets/{y}/basic/{mon}{yy}pub.dat.gz"
CPI_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=CPIAUCNS"
BLS_CPI_URL = "https://api.bls.gov/publicAPI/v2/timeseries/data/CUUR0000SA0"
BLS_MEDIAN_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=LEU0252881500Q"
MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
START = (2015, 1)

# Fixed-width positions (1-based inclusive). Identical in every record layout
# from January 2015 through 2026 (Jan 2015, Jan 2017, 2020-2026, May 2024).
# PRERNWA was renamed PTERNWA in 2021; same position, same 2 implied decimals.
FIELDS = {
    "HRMONTH": (16, 17),
    "HRYEAR4": (18, 21),
    "HRMIS": (63, 64),
    "PRTAGE": (122, 123),
    "PEMLR": (180, 181),
    "PRFTLF": (397, 398),
    "PRERELG": (498, 499),
    "PRERNWA": (527, 534),   # weekly earnings, 2 implied decimals
    "PTWK": (535, 535),      # weekly earnings topcode flag
    "PWORWGT": (603, 612),   # outgoing rotation weight, 4 implied decimals
    "PWCMPWGT": (846, 855),  # composited final weight, 4 implied decimals
}

POPULATIONS = {
    "A": lambda d: (d.PRTAGE >= 18) & (d.PEMLR != 5),
    "B": lambda d: (d.PRTAGE >= 18) & (d.PRTAGE <= 64),
    "C": lambda d: (d.PRTAGE >= 25) & (d.PRTAGE <= 54),
    "D": lambda d: d.PRTAGE >= 18,
}

OUT_COLS = [
    "month", "population", "zero_share",
    "earner_median_nom", "earner_median_real",
    "combined_median_nom", "combined_median_real",
    "earner_trimmed_mean_real", "per_capita_trimmed_mean_real",
    "ft_earner_median_nom", "cpi_u", "n_unweighted",
]


# ---------------------------------------------------------------- HTTP helpers

def http_get(url, method="GET", tries=5):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, method=method)
            with urllib.request.urlopen(req, timeout=180) as r:
                return r.headers, (r.read() if method == "GET" else b"")
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None, None
            if i == tries - 1:
                raise
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if i == tries - 1:
                raise
        time.sleep(2 ** (i + 1))


# ---------------------------------------------------------------- microdata

def month_list():
    today = date.today()
    y, m = START
    while (y, m) <= (today.year, today.month):
        yield y, m
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)


def decompress(raw):
    # some "*.dat.gz" files on the Census server are actually zip archives
    if raw[:2] == b"PK":
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            (name,) = [n for n in z.namelist() if not n.endswith("/")]
            return z.read(name)
    return gzip.decompress(raw)


def parse_dat(raw):
    lines = decompress(raw).decode("latin-1").splitlines()
    cols = {}
    for name, (a, b) in FIELDS.items():
        cols[name] = pd.to_numeric(pd.Series([ln[a - 1:b] for ln in lines]).str.strip(), errors="coerce")
    df = pd.DataFrame(cols)
    df["PRERNWA"] = df["PRERNWA"] / 100.0
    df["PWORWGT"] = df["PWORWGT"] / 10000.0
    df["PWCMPWGT"] = df["PWCMPWGT"] / 10000.0
    return df


def sanity_check(df, y, m):
    """Fail loudly if the layout has shifted (positions no longer line up)."""
    problems = []
    if not (df.HRYEAR4 == y).all() or not (df.HRMONTH == m).all():
        problems.append("HRYEAR4/HRMONTH do not match file month")
    if not df.HRMIS.isin(range(1, 9)).all():
        problems.append("HRMIS outside 1..8")
    if not df.PEMLR.isin([-1, 1, 2, 3, 4, 5, 6, 7]).all():
        problems.append("PEMLR outside -1..7")
    if not df.PRERELG.isin([-1, 0, 1]).all():
        problems.append("PRERELG outside -1..1")
    # topcode was $2,884.61 through Mar 2023; from Apr 2023 topcoded cases carry
    # higher replacement values, so only check sign and plausibility here
    e = df.loc[df.PRERELG == 1, "PRERNWA"]
    if (e < 0).any() or (e > 0).mean() < 0.9 or e.max() > 100000:
        problems.append("PRERNWA out of expected range")
    if problems:
        raise RuntimeError(f"{y}-{m:02d}: layout check failed: {'; '.join(problems)}")


def load_month(y, m, cache_dir, refresh):
    """Return the extracted person records for a month, or None if not published."""
    url = BASE_URL.format(y=y, mon=MONTHS[m - 1], yy=f"{y % 100:02d}")
    cache = cache_dir / f"{y}-{m:02d}.csv.gz"
    meta = cache_dir / f"{y}-{m:02d}.json"
    headers, _ = http_get(url, method="HEAD")
    if headers is None:
        return None
    last_mod = headers.get("Last-Modified", "")
    if cache.exists() and meta.exists() and not refresh:
        if json.loads(meta.read_text()).get("last_modified") == last_mod:
            return pd.read_csv(cache)
    print(f"  downloading {url}", file=sys.stderr)
    _, raw = http_get(url)
    df = parse_dat(raw)
    sanity_check(df, y, m)
    df.to_csv(cache, index=False, compression="gzip")
    meta.write_text(json.dumps({"url": url, "last_modified": last_mod}))
    return df


# ---------------------------------------------------------------- CPI / BLS

def fred_series(url):
    _, raw = http_get(url)
    s = pd.read_csv(io.BytesIO(raw))
    s.columns = ["date", "value"]
    s["value"] = pd.to_numeric(s["value"], errors="coerce")
    s = s.dropna()
    s["date"] = pd.to_datetime(s["date"]).dt.to_period("M")
    return s.set_index("date")["value"]


def load_cpi():
    try:
        return fred_series(CPI_URL)
    except Exception as exc:  # FRED down: fall back to BLS public API
        print(f"  FRED CPI failed ({exc}); using BLS API", file=sys.stderr)
        rows = []
        this_year = date.today().year
        for start in range(START[0], this_year + 1, 10):
            body = json.dumps({"seriesid": ["CUUR0000SA0"], "startyear": str(start),
                               "endyear": str(min(start + 9, this_year))}).encode()
            req = urllib.request.Request(BLS_CPI_URL, data=body, headers={"Content-type": "application/json"})
            with urllib.request.urlopen(req, timeout=60) as r:
                for d in json.load(r)["Results"]["series"][0]["data"]:
                    if d["period"].startswith("M") and d["period"] != "M13" and d["value"] != "-":
                        rows.append((pd.Period(f"{d['year']}-{d['period'][1:]}", "M"), float(d["value"])))
        return pd.Series(dict(rows)).sort_index()


# ---------------------------------------------------------------- statistics

def wquantile(x, w, q):
    """Weighted quantile: smallest x whose cumulative weight share reaches q."""
    if len(x) == 0:
        return np.nan
    o = np.argsort(x, kind="mergesort")
    x, w = x[o], w[o]
    cw = np.cumsum(w)
    return float(x[np.searchsorted(cw, q * cw[-1] - 1e-9 * cw[-1])])


def wtrimmed_mean(x, w, lo=0.01, hi=0.99):
    """Weighted mean after removing the bottom/top share of total weight.
    Observations straddling a cut point keep only their inside portion, so
    exactly lo and 1-hi of the weight is removed even with ties (e.g. topcode)."""
    if len(x) == 0:
        return np.nan
    o = np.argsort(x, kind="mergesort")
    x, w = x[o], w[o]
    cw = np.cumsum(w)
    tot = cw[-1]
    start = cw - w
    kept = np.clip(np.minimum(cw, hi * tot) - np.maximum(start, lo * tot), 0, None)
    return float((x * kept).sum() / kept.sum())


def classify(df):
    """Tag each outgoing-rotation civilian adult record as earner / zero / dropped."""
    d = df[df.HRMIS.isin([4, 8]) & (df.PRTAGE >= 18)].copy()
    employed = d.PEMLR.isin([1, 2])
    d["status"] = "other"  # PEMLR == -1: armed forces, not in the civilian population
    d.loc[d.PEMLR.isin([3, 4, 5, 6, 7]), "status"] = "zero"
    d.loc[employed, "status"] = "dropped"
    d.loc[employed & (d.PRERELG == 1) & (d.PRERNWA > 0), "status"] = "earner"
    return d


def month_metrics(df, period, cpi, cpi_base, weight_col):
    d = classify(df)
    rows, diag = [], []
    for pop, rule in POPULATIONS.items():
        p = d[rule(d)]
        earn = p[p.status == "earner"]
        zero = p[p.status == "zero"]
        ex, ew = earn.PRERNWA.to_numpy(), earn[weight_col].to_numpy()
        w_e, w_z = ew.sum(), zero[weight_col].sum()
        zero_share = w_z / (w_e + w_z)

        allx = np.concatenate([ex, np.zeros(len(zero))])
        allw = np.concatenate([ew, zero[weight_col].to_numpy()])
        ft = earn[earn.PRFTLF == 1]

        earner_median = wquantile(ex, ew, 0.5)
        combined_median = wquantile(allx, allw, 0.5)
        trimmed = wtrimmed_mean(ex, ew)
        defl = cpi_base / cpi
        rows.append({
            "month": str(period),
            "population": pop,
            "zero_share": zero_share,
            "earner_median_nom": earner_median,
            "earner_median_real": earner_median * defl,
            "combined_median_nom": combined_median,
            "combined_median_real": combined_median * defl,
            "earner_trimmed_mean_real": trimmed * defl,
            "per_capita_trimmed_mean_real": (1 - zero_share) * trimmed * defl,
            "ft_earner_median_nom": wquantile(ft.PRERNWA.to_numpy(), ft[weight_col].to_numpy(), 0.5),
            "cpi_u": cpi,
            "n_unweighted": len(earn) + len(zero),
        })
        dropped = p[p.status == "dropped"]
        diag.append({
            "month": str(period), "population": pop,
            "n_earner": len(earn), "n_zero": len(zero), "n_dropped": len(dropped),
            "n_zero_pworwgt_le0": int((zero.PWORWGT <= 0).sum()),
            "weight_used": weight_col,
            "wt_earner_mil": w_e / 1e6, "wt_zero_mil": w_z / 1e6,
            "topcoded_share_of_earners": float(ew[earn.PTWK.to_numpy() == 1].sum() / w_e),
            "max_earnings_nom": float(ex.max()),
            "earner_trimmed_mean_nom": trimmed,
        })
    return rows, diag


# ---------------------------------------------------------------- validation

def validate(out, out_dir):
    bls = fred_series(BLS_MEDIAN_URL)
    bls.index = bls.index.asfreq("Q")
    d = out[out.population == "D"].copy()
    d["quarter"] = pd.PeriodIndex(d.month, freq="M").asfreq("Q")
    q = d.groupby("quarter").agg(ft_earner_median_nom=("ft_earner_median_nom", "mean"),
                                 months_in_quarter=("month", "count"))
    q["bls_median_usual_weekly_ft_nsa"] = bls.reindex(q.index)
    q["pct_diff"] = 100 * (q.ft_earner_median_nom / q.bls_median_usual_weekly_ft_nsa - 1)
    q = q.reset_index()
    q["quarter"] = q.quarter.astype(str)
    q.to_csv(out_dir / "validation_vs_bls.csv", index=False, float_format="%.2f")
    full = q.dropna(subset=["pct_diff"])
    full = full[full.months_in_quarter == 3]
    print(f"validation: {len(full)} complete quarters, |pct_diff| mean {full.pct_diff.abs().mean():.2f}%, "
          f"max {full.pct_diff.abs().max():.2f}%", file=sys.stderr)
    if full.pct_diff.abs().max() > 5:
        raise SystemExit("ft_earner_median is >5% off BLS in some quarter; check scaling/filters before using output")
    return q


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out-dir", type=Path, default=HERE)
    ap.add_argument("--cache-dir", type=Path, default=HERE / ".cache")
    ap.add_argument("--refresh", action="store_true", help="re-download all months")
    args = ap.parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)
    args.cache_dir.mkdir(parents=True, exist_ok=True)

    cpi = load_cpi()
    frames, skipped = {}, []
    for y, m in month_list():
        df = load_month(y, m, args.cache_dir, args.refresh)
        if df is None:
            skipped.append(f"{y}-{m:02d}")
        else:
            frames[pd.Period(f"{y}-{m:02d}", "M")] = df
    # trailing unpublished months are "not yet released", not gaps
    last = max(frames)
    gaps = [s for s in skipped if pd.Period(s, "M") < last]

    cpi_base_month = last if last in cpi.index else cpi.index.max()
    cpi_base = cpi[cpi_base_month]

    rows, diag = [], []
    for period, df in sorted(frames.items()):
        ow = df[df.HRMIS.isin([4, 8]) & (df.PRTAGE >= 18) & df.PEMLR.isin([3, 4, 5, 6, 7])]
        weight_col = "PWORWGT" if (ow.PWORWGT > 0).all() else "PWCMPWGT"
        if weight_col != "PWORWGT":
            print(f"  {period}: PWORWGT <= 0 for some non-employed; using PWCMPWGT", file=sys.stderr)
        # newest CPS month can precede its CPI release: real columns stay blank until it lands
        r, dg = month_metrics(df, period, cpi.get(period, np.nan), cpi_base, weight_col)
        rows += r
        diag += dg

    out = pd.DataFrame(rows)[OUT_COLS]
    out.to_csv(args.out_dir / "cps_earnings_per_capita.csv", index=False, float_format="%.4f")
    pd.DataFrame(diag).to_csv(args.out_dir / "cps_earnings_diagnostics.csv", index=False, float_format="%.4f")
    (args.out_dir / "run_info.json").write_text(json.dumps({
        "first_month": str(min(frames)), "last_month": str(last),
        "real_dollars_base_month": str(cpi_base_month), "cpi_base": cpi_base,
        "skipped_months": gaps, "run_date": date.today().isoformat(),
    }, indent=2) + "\n")
    print(f"wrote {len(out)} rows, {min(frames)}..{last}; skipped: {gaps or 'none'}; "
          f"real $ base {cpi_base_month} (CPI {cpi_base})", file=sys.stderr)
    validate(out, args.out_dir)


if __name__ == "__main__":
    main()
