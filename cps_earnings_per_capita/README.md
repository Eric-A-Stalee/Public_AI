# CPS real weekly earnings per capita (non-earners at $0)

Monthly series, **Jan 2015 – Aug 2026**, built from CPS basic monthly microdata. Non-earners are counted at $0. This folder holds data only, with no interpretation.

| File | Contents |
|---|---|
| `cps_earnings_per_capita.csv` | Deliverable: one row per month × population (A–D), with the columns from the brief |
| `pull_cps_earnings.py` | Pull and compute script. Re-run monthly with `python3 pull_cps_earnings.py` |
| `validation_vs_bls.csv` | Quarterly `ft_earner_median` (population D) compared with BLS |
| `cps_earnings_diagnostics.csv` | Earner, zero and dropped counts; weight used; weight totals; topcoded share; max earnings; nominal trimmed mean |
| `run_info.json` | Months covered, CPI base month and skipped months for the last run |

Real dollars are **August 2026 dollars**, deflated with CPI-U NSA (FRED `CPIAUCNS`; August 2026 = 334.980). Each run re-bases to the latest CPS month that has a published CPI. If a month's CPI is not out yet, that month's real columns stay blank until a later run.

## Deviations from the brief

- **Source: bulk public-use files, not the Census API.** `api.census.gov` now redirects keyless requests to `missing_key.html`. The script reads the Census public-use files instead (`www2.census.gov/programs-surveys/cps/datasets/{YYYY}/basic/{mon}{yy}pub.dat.gz`), which are the microdata the API serves.
  - Field positions were checked against every record layout from 2015 to 2026 (Jan 2015, Jan 2017, 2020–2026, May 2024) and are identical in all of them.
  - The script also checks every file it reads: year and month match the file, and HRMIS, PEMLR, PRERELG and earnings fall in valid ranges. It stops if anything shifts.
  - Some files named `.dat.gz` are actually zip archives; the script handles both.
- **`PRERNWA` was renamed `PTERNWA` in 2021.** Same position (527–534), same 2 implied decimals. The API's `variables.json` lists only `PTERNWA`, for every year back to 2015.
- **Weight:** `PWORWGT` (4 implied decimals) is positive for every non-employed person aged 18+ in rotations 4 and 8, in every month. The composite-weight fallback was never used; the `weight_used` column in the diagnostics file records this.
- **Armed forces** (`PEMLR = -1` at age 18+) are excluded from every population, because they are neither earners nor in the civilian population.
- **Trimmed mean:** the weight-based 1%/99% cut is applied exactly. A record that straddles a cut point keeps only its inside share of weight, so ties at the topcode are trimmed correctly.
- **Percentiles:** weighted median = the smallest value whose cumulative weight share reaches 0.5. Zeros enter as a point mass, so `combined_median` = 0 whenever `zero_share` ≥ 0.5 (this happens for population D in April 2020).
- `n_unweighted` = earners + zeros. Dropped records (employed with `PRERELG = 0`, or eligible with missing or zero earnings) are not counted; their numbers are in `n_dropped` in the diagnostics file.

## Validation vs BLS

The comparison is between `ft_earner_median` (population D, age 18+, `PRFTLF = 1`), averaged by quarter, and BLS median usual weekly earnings of full-time wage and salary workers, NSA (`LEU0252881500`, which covers age 16+).

- **45 complete quarters, 2015Q1–2026Q2:** mean absolute difference 0.42%, maximum 1.42% (2016Q2).
- **2026Q2:** $1,250.00 here vs **$1,251** from BLS (−0.08%). 2026Q1: $1,236.67 vs $1,235.
- 2025Q4 has no BLS value (appropriations lapse), and 2026Q3 is not yet published. Both are shown in the file with only 2 months of data.
- The script stops with an error if any complete quarter is more than 5% off.

## Skipped months

- **October 2025** has no file, because of the appropriations lapse. It is skipped, not imputed. November 2025 onward is present.
- September 2026 had not been released as of this run (2026-10-06).

## Known breaks (flagged, not fixed)

- **January population controls** shift the weights every January, and the January 2026 revision is large. The current `jan26pub` is a re-issued file; Census archived the original as `jan26pub_archive_revision`. This series uses the current file.
- **2020:** response rates fell sharply from March 2020 onward, and the employment classification problems of spring 2020 carry into `zero_share`.
- **The topcode changed in April 2023, so the trimmed mean is not comparable across that break.** Through March 2023, weekly earnings were topcoded at $2,884.61. From April 2023, Census assigns topcoded cases a much higher replacement value: $6,892–$13,258, varying by month. Old- and new-style values coexisted until roughly mid-2024 as rotation groups cycled through.
  - The weighted topcoded share of earners is 2.6–7.0% in every month, which is above 1%. The 1% trim therefore does not remove the topcode mass in either period, and `earner_trimmed_mean` and `per_capita_trimmed_mean` shift level across April 2023 to mid-2024.
  - Medians are unaffected. The monthly topcoded share and maximum value are in the diagnostics file. The May 2024 file leaves the topcode flag (`PTWK`) blank, so that month's topcoded share is shown as missing. Its earnings values still carry the topcode: 318 records sit at $7,940.39.
- **Medians move in steps,** because reported earnings cluster at round amounts ($1,100, $1,200, …).

## Re-running

```
python3 pull_cps_earnings.py            # incremental: only new or re-issued files are downloaded
python3 pull_cps_earnings.py --refresh  # re-download everything
```

Downloaded months are cached in `.cache/`, which is gitignored. A cached month is re-downloaded when the Census file's `Last-Modified` changes, so re-issued files such as January 2026 are picked up. A full run takes about 10 minutes.
