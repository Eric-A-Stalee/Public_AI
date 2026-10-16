# Macro Terminal

A maintainable React dashboard backed by periodically refreshed economic observations. The source reconstructs the former exported JavaScript application; the old compiled bundle remains available in Git history. Indicator values, chart histories, comparisons, and descriptive readings now share a dated JSON snapshot instead of hard-coded market commentary.

## Run locally

Use Node.js 24 (the project requires at least 22.12) and the committed npm lockfile.

```sh
cd Perplexity_Computer/Macro_Terminal
npm ci
npm run dev
```

The checked-in `public/data/latest.json` is a real fetched snapshot. The application can render it without credentials or a running backend. Fetch new observations with:

```sh
npm run refresh:data
```

Without a key, the collector uses FRED's public graph CSV download. For the documented JSON observations API, supply `FRED_API_KEY` in the process environment. For local development, another option is to copy `.env.example` to the ignored `.env`, edit it, and explicitly load it:

```sh
node --env-file=.env scripts/refresh-data.mjs
```

`npm run refresh:data` reads the shell environment; it does not automatically load `.env`. Never name the key `VITE_FRED_API_KEY` or include it in frontend code: Vite-prefixed values can be embedded in public JavaScript. An invalid or rate-limited configured API key produces an error; the collector does not silently switch back to CSV.

```sh
npm test
npm run build
npx playwright install --with-deps chromium
npm run test:browser
npm run preview
```

The unit tests inject provider responses to check parsing, revisions, missing observations, calculations, and failure retention without live API access. Browser tests exercise the application with controlled snapshots and failure responses. `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` can select an already installed Chromium for environments where Playwright downloads are unavailable; standard CI installs Playwright's Chromium.

## How updates work

`config/series.json` declares each source's identifier, units, frequency, attribution, observation-age threshold, and whether collection is enabled. `scripts/refresh-data.mjs` collects the preceding seven years, validates the responses, and atomically replaces `public/data/latest.json`. A successful retrieval replaces that source's full window so historical revisions are incorporated; it is not an append-only feed. The shared data code lives in `scripts/data-lib.mjs`.

The browser fetches `data/latest.json` on opening the dashboard, every five minutes while it remains open, and when the user requests a check. The browser never calls FRED or receives an API key. Its check button reads the most recently published snapshot; it does not trigger a GitHub workflow or make upstream releases happen sooner. `src/model.js` derives cards, charts, changes, and descriptive readings from the same observations. There is no automatically generated financial forecast or LLM commentary.

Collection uses three workers, a 15-second timeout per request, and at most two retries for transient network/server/rate-limit errors. Missing source values remain `null` gaps. Incorrect headers, malformed responses, truncated API pages, and impossible dates fail validation instead of turning into invented observations.

The snapshot contract is versioned with `schemaVersion: 1`:

| Field                      | Meaning                                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `generatedAt`              | Time of the most recent collection with at least one successful source. It is not the date of every observation. |
| `lastAttemptAt`            | Time the collector began the latest attempt represented in this file.                                            |
| `series`                   | Record keyed by FRED series ID. Definitions and source attribution are in `config/series.json`.                  |
| `series[id].observations`  | Ascending unique `{ date: "YYYY-MM-DD", value: number \| null }` observations.                                   |
| `series[id].fetchedAt`     | This source's last successful retrieval time, retained on failure.                                               |
| `series[id].lastAttemptAt` | Most recent attempt for this source, or `null` when disabled.                                                    |
| `series[id].status`        | `ok`, `error`, or `unavailable`.                                                                                 |
| `series[id].error`         | Sanitized failure or unavailability explanation, otherwise `null`.                                               |
| `notices`                  | Dataset-level information about the adapter, dates, revisions, and rights.                                       |

An **observation date** identifies the measured day or reference period. Monthly data commonly use the first day of the month, and quarterly GDP uses the first day of the quarter; those dates are not release dates. A **retrieval timestamp** records when the upstream data were successfully checked. Recent retrieval does not imply a newly released observation. Observation-age thresholds allow for the series' normal release cadence and lag; these are operational heuristics, not a release-calendar service. University of Michigan sentiment has an explicit one-month source delay.

If one source fails, its last valid observations and successful retrieval time remain available with an error status. Other successfully refreshed sources can still be published. If **all enabled sources fail**, the CLI exits unsuccessfully, retains the prior successful generation time, and saves failure metadata locally. The workflow then stops: it neither commits that failed attempt nor replaces the live Pages deployment. The existing site keeps its prior snapshot, whose timestamps continue to age. A subsequent browser fetch failure also retains the last validated dataset in the open page. No fallback fabricates history or fills missing observations with a previous month's value.

## Coverage and definitions

The default configuration collects 34 FRED series and keeps one restricted series explicitly disabled. Some underlying series support multiple derived metrics.

| Displayed measure          | Source IDs                                                                              | Definition                                                                                                                                                                               |
| -------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Federal funds target range | `DFEDTARL`, `DFEDTARU`                                                                  | Target lower and upper bounds, percent; distinct from the monthly effective federal funds rate.                                                                                          |
| Treasury yield curve       | `DGS1MO`, `DGS3MO`, `DGS6MO`, `DGS1`, `DGS2`, `DGS5`, `DGS7`, `DGS10`, `DGS20`, `DGS30` | Constant-maturity yields, percent; curve points use a shared observation date.                                                                                                           |
| 10Y–2Y / 10Y–3M spreads    | `T10Y2Y`, `T10Y3M`                                                                      | Published percentage-point spreads, displayed in percentage points (`pp`). One percentage point equals 100 basis points. Their latest release can differ from the component-yield dates. |
| 30-year mortgage rate      | `MORTGAGE30US`                                                                          | Freddie Mac weekly national survey, percent.                                                                                                                                             |
| Headline / core CPI YoY    | `CPIAUCNS`, `CPILFENS`                                                                  | Non-seasonally-adjusted indexes; `(current / same month last year − 1) × 100`.                                                                                                           |
| CPI MoM                    | `CPIAUCSL`                                                                              | Seasonally adjusted index; change against the exact preceding calendar month.                                                                                                            |
| Headline / core PCE YoY    | `PCEPI`, `PCEPILFE`                                                                     | Seasonally adjusted indexes; change against the exact same month a year earlier.                                                                                                         |
| Final-demand PPI YoY       | `PPIFID`                                                                                | Non-seasonally-adjusted final-demand index; distinct from the all-commodities `PPIACO` series.                                                                                           |
| Real GDP growth            | `A191RL1Q225SBEA`                                                                       | Already annualized quarterly percent change; not annualized again.                                                                                                                       |
| M2 money supply            | `M2SL`                                                                                  | Seasonally adjusted billions of dollars, converted to trillions for display.                                                                                                             |
| Housing starts             | `HOUST`                                                                                 | Seasonally adjusted annual rate, thousands of units; converted to millions where shown.                                                                                                  |
| Unemployment               | `UNRATE`                                                                                | Seasonally adjusted percent; rate changes use percentage points.                                                                                                                         |
| Payroll additions          | `PAYEMS`                                                                                | Difference between exact consecutive monthly levels, in thousands of jobs.                                                                                                               |
| Wage growth                | `CES0500000003`                                                                         | BLS average hourly earnings of private payroll employees, YoY; not the Goldman Sachs wage tracker.                                                                                       |
| Initial jobless claims     | `ICSA`                                                                                  | Seasonally adjusted weekly persons, displayed in thousands.                                                                                                                              |
| Job openings               | `JTSJOL`                                                                                | Seasonally adjusted monthly thousands of persons, displayed in millions.                                                                                                                 |
| VIX                        | `VIXCLS`                                                                                | CBOE daily closing index, not an intraday quote.                                                                                                                                         |
| Consumer sentiment         | `UMCSENT`                                                                               | University of Michigan monthly index, delayed one month by the source.                                                                                                                   |
| Financial conditions       | `NFCI`                                                                                  | Chicago Fed weekly index; positive means tighter than average.                                                                                                                           |
| WTI oil                    | `DCOILWTICO`                                                                            | Daily Cushing spot dollars per barrel; replaces the misleading USO ETF price proxy.                                                                                                      |
| High-yield credit spread   | `BAMLH0A0HYM2` (disabled)                                                               | Correct ICE BofA option-adjusted spread series, subject to redistribution restrictions. HYG's ETF share price is not this measure.                                                       |

Exact calendar lags matter. A missing month does not make the previous available month a valid substitute for a one-month or twelve-month comparison. Historical observations can be revised, including payroll benchmarks and seasonal adjustments. All calculations use the currently retrieved vintage; this is not a point-in-time backtesting dataset.

The former static ETF quotes, ISM manufacturing/services readings, Conference Board confidence, consensus forecasts, recession probabilities, estimated breakeven job growth, economic-calendar rows, and research commentary do not have a configured verified publishing feed. They are not presented as automatically refreshed values. Adding them requires an actual provider, the applicable publishing rights, a metric definition, and collection/error tests. A provider key alone does not establish redistribution rights. No Alpha Vantage or other market-price integration is enabled by default.

FRED is an aggregator, not a blanket license for all underlying data. Source links and attribution are recorded in the configuration and displayed in the application. The [ICE high-yield series notes](https://fred.stlouisfed.org/series/BAMLH0A0HYM2) restrict publication/distribution; enable collection only after establishing a suitable licensed source and updating the configuration. [ISM terms](https://www.ismworld.org/supply-management-news-and-reports/reports/ism-pmi-reports/pmi/september/) and [Conference Board terms](https://www.conference-board.org/contact/terms-of-use) also restrict reuse. [Freddie Mac mortgage](https://fred.stlouisfed.org/series/MORTGAGE30US), [CBOE VIX](https://fred.stlouisfed.org/series/VIXCLS), and [Michigan sentiment](https://fred.stlouisfed.org/series/UMCSENT) retain their source-specific attribution. Review the original source's current terms when changing coverage or use.

## GitHub Actions and Pages

Two repository-level workflows are included:

- `.github/workflows/macro-terminal-ci.yml` runs dependency installation, mocked unit/collector tests, production build, and Chromium tests for relevant pull requests and main-branch changes. It has read-only repository permission, no provider secrets, and no deployment capability.
- `.github/workflows/macro-terminal-refresh.yml` runs on relevant pushes to `main`, manual dispatch, and at **02:17, 10:17, and 18:17 UTC**. It collects observations, validates and builds the dashboard, commits only `public/data/latest.json`, and deploys a static Pages artifact. Partial source failures are visible in that snapshot; a total collection failure stops publication.

Initial repository setup is required after merging:

1. In **Settings → Pages → Build and deployment → Source**, select **GitHub Actions**. The workflow deliberately does not enable Pages or change repository settings itself.
2. Ensure Actions is enabled and repository policy permits the workflow's `contents: write` request. The refresh job needs to commit the data snapshot to `main`. If branch protection requires every change to use a PR or signed commits, the bot push will be rejected; adapt that policy or introduce a reviewed snapshot-publishing branch before enabling the scheduled writer. This workflow does not bypass branch protection.
3. Optionally add **Settings → Secrets and variables → Actions → New repository secret → `FRED_API_KEY`**. The no-key CSV adapter works without this setup; a registered FRED key selects the documented API.
4. Open **Actions → Refresh Macro Terminal and deploy Pages → Run workflow**, select `main`, and check that both `refresh-build` and `deploy` complete. The `github-pages` environment may require approval if repository rules configure it.

The deployment packages only built Macro Terminal assets, its public dataset, the existing `career-finder/index.html`, and a small root landing page. It preserves the two application paths under the repository's Pages URL:

- `/Public_AI/Perplexity_Computer/Macro_Terminal/`
- `/Public_AI/career-finder/`

The Vite build uses relative asset URLs, so the app also works under another static-host prefix. Source files, credentials, `node_modules`, and repository metadata are not copied into the Pages artifact. The career-finder file is copied unchanged. Future applications or career-finder assets should be added explicitly to the workflow's staging allowlist.

Refresh/deployment runs are serialized and have bounded timeouts. A run starts from current `main` and checks for intervening changes before its data commit and again before deployment. Commits are normal fast-forward pushes; a failed or rejected push stops deployment. If `main` changes during a run, rerun the workflow against its current revision. The bot's `GITHUB_TOKEN` push does not recursively trigger another push workflow; the same run performs the deployment.

GitHub schedules are best-effort and can be delayed or dropped under load. They run only from the default branch; this workflow additionally guards deployment to `main`, so update both if renaming the default branch. Public-repository schedules can be disabled after 60 days without repository activity; re-enable the workflow in Actions if that happens. Daily series are end-of-day observations, and monthly/quarterly releases remain periodic even though collection runs three times daily. Check the workflow history and the dashboard's per-series dates when investigating freshness.

Useful primary documentation: [FRED observations API](https://fred.stlouisfed.org/docs/api/fred/series_observations.html), [FRED API keys](https://fred.stlouisfed.org/docs/api/api_key.html), [FRED graph CSV export](https://fred.stlouisfed.org/help/graphs/share-my-fred-graph/export-options/), [FRED API terms](https://fred.stlouisfed.org/docs/api/terms_of_use.html), [GitHub Pages custom workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages), and [scheduled workflow behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule). FRED documents CSV export, but the graph-download URL parameters are not a versioned API contract; the registered observations API is the preferred long-term integration.
