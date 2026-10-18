import React, { useId, useMemo } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
} from "recharts";
import metadata from "../config/series.json";
import { cumulativeComparison } from "./cumulative.js";
import { formatValue, freshness } from "./model.js";

const BASES = {
  median: {
    label: "Median weekly earnings",
    source: "LES1252881500Q",
    cadence: "quarter",
    payUnit: "week",
    payAdjective: "weekly",
    realLabel: "Real median weekly earnings",
  },
  average: {
    label: "Average hourly earnings",
    source: "CES0500000003",
    cadence: "month",
    payUnit: "hour",
    payAdjective: "hourly",
    realLabel: "Real hourly earnings",
  },
};
function seriesDefinitions(basis) {
  return {
    prices: {
      label: "Cumulative inflation",
      color: "var(--amber)",
      dash: "6 3",
    },
    earnings: { label: basis.label, color: "var(--cyan)" },
    realEarnings: { label: basis.realLabel, color: "var(--green)" },
  };
}
const INTERVALS = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  yearly: "Yearly",
};

function monthLabel(value) {
  if (!value) return "Not available";
  const date = new Date(
    typeof value === "number" ? value : `${value.slice(0, 7)}-01T00:00:00Z`,
  );
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    year: "numeric",
  }).format(date);
}
function periodLabel(value, earningsBasis) {
  if (!value || earningsBasis !== "median") return monthLabel(value);
  const date = new Date(
    typeof value === "number" ? value : `${value.slice(0, 7)}-01T00:00:00Z`,
  );
  return `Q${Math.floor(date.getUTCMonth() / 3) + 1} ${date.getUTCFullYear()}`;
}
function percentage(value) {
  return formatValue(value, {
    digits: 2,
    prefix: value > 0 ? "+" : "",
    suffix: "%",
  });
}
function indexValue(value) {
  return formatValue(value, { digits: 2 });
}
function CumulativeTooltip({ active, payload, label, series, earningsBasis }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <strong>{periodLabel(label, earningsBasis)}</strong>
      {payload.map((entry) => (
        <div key={entry.dataKey}>
          <span style={{ color: entry.stroke }}>
            {series[entry.dataKey].label}
          </span>
          <b>
            {indexValue(entry.payload.indices[entry.dataKey])}
            {" · "}
            {percentage(entry.payload.changes[entry.dataKey])}
          </b>
        </div>
      ))}
    </div>
  );
}
function ComparisonPlot({
  rows,
  keys,
  syncId,
  print,
  scale,
  series,
  basis,
  earningsBasis,
  real = false,
}) {
  return (
    <div
      className={`chart-area ${real ? "cumulative-real-area" : "cumulative-main-area"}`}
      data-testid={real ? "cumulative-real-chart" : "cumulative-nominal-chart"}
      role="group"
      aria-label={
        real
          ? `Inflation-adjusted ${basis.label.toLowerCase()} index and cumulative change`
          : `Compounded price and ${basis.label.toLowerCase()} indices and cumulative change`
      }
    >
      <ResponsiveContainer
        width="100%"
        height="100%"
        minWidth={0}
        initialDimension={
          print ? { width: 700, height: real ? 120 : 160 } : undefined
        }
      >
        <LineChart
          data={rows}
          syncId={syncId}
          accessibilityLayer
          margin={{ top: 12, right: 24, bottom: 0, left: 0 }}
        >
          <CartesianGrid
            vertical={false}
            stroke="var(--grid)"
            strokeDasharray="3 4"
          />
          <XAxis
            dataKey="time"
            type="number"
            scale="time"
            domain={["dataMin", "dataMax"]}
            axisLine={false}
            tickLine={false}
            minTickGap={50}
            ticks={
              earningsBasis === "median"
                ? rows.map((row) => row.time)
                : undefined
            }
            tick={{ fill: "var(--muted)", fontSize: 10 }}
            tickFormatter={(value) => periodLabel(value, earningsBasis)}
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            width={62}
            domain={["auto", "auto"]}
            tick={{ fill: "var(--muted)", fontSize: 10 }}
            tickFormatter={(value) =>
              `${Number(value.toFixed(1))}${scale === "index" ? "" : "%"}`
            }
          />
          <ReferenceLine
            y={scale === "index" ? 100 : 0}
            stroke="var(--dim)"
            strokeDasharray="3 3"
          />
          <Tooltip
            content={
              <CumulativeTooltip
                series={series}
                earningsBasis={earningsBasis}
              />
            }
            cursor={{ stroke: "var(--muted)", strokeDasharray: "3 3" }}
          />
          {keys.map((key) => (
            <Line
              key={key}
              dataKey={key}
              name={series[key].label}
              type="linear"
              stroke={series[key].color}
              strokeDasharray={series[key].dash}
              strokeWidth={print ? 2.5 : 2}
              dot={({ cx, cy, index }) => {
                const isolated =
                  !Number.isFinite(rows[index - 1]?.[key]) &&
                  !Number.isFinite(rows[index + 1]?.[key]);
                if (
                  !Number.isFinite(rows[index]?.[key]) ||
                  !Number.isFinite(cx) ||
                  !Number.isFinite(cy) ||
                  (rows.length > 8 && !isolated)
                )
                  return null;
                return (
                  <circle
                    key={index}
                    className="cumulative-point"
                    cx={cx}
                    cy={cy}
                    r={2.5}
                    fill={series[key].color}
                  />
                );
              }}
              activeDot={{ r: 4 }}
              connectNulls={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function CumulativeComparison({
  snapshot,
  range,
  earningsBasis = "median",
  basisChangeNotice,
  onEarningsBasis,
  startMonth,
  interval,
  view,
  scale,
  onStartMonth,
  onInterval,
  onView,
  onScale,
  print = false,
}) {
  const id = useId();
  const basis = BASES[earningsBasis];
  const isMedian = earningsBasis === "median";
  const series = useMemo(() => seriesDefinitions(basis), [basis]);
  const sources = ["CPIAUCSL", basis.source];
  const formatPeriod = (value) => periodLabel(value, earningsBasis);
  const comparison = useMemo(
    () =>
      cumulativeComparison(snapshot, {
        earningsBasis,
        startMonth,
        range,
        interval,
      }),
    [snapshot, earningsBasis, startMonth, range, interval],
  );
  const rows = useMemo(
    () =>
      comparison.rows.map((row) => ({
        ...row,
        changes: {
          prices: row.prices,
          earnings: row.earnings,
          realEarnings: row.realEarnings,
        },
        ...(scale === "index" ? row.indices : {}),
        time: Date.parse(`${row.date}T00:00:00Z`),
      })),
    [comparison, scale],
  );
  const keys =
    view === "prices"
      ? ["prices"]
      : view === "earnings"
        ? ["earnings"]
        : ["prices", "earnings"];
  const start = formatPeriod(comparison.startMonth);
  const end = formatPeriod(comparison.endMonth);
  const partialEnd = rows.at(-1)?.partial && interval !== "monthly";
  const periodName = interval === "quarterly" ? "quarter" : "year";
  const hasData = !comparison.error && rows.length > 0;
  return (
    <article
      className="panel cumulative-panel"
      data-testid="cumulative-comparison"
      aria-labelledby={`${id}-heading`}
    >
      <div className="panel-heading">
        <div>
          <div className="eyebrow">OUR CHAINED INDEX / START = 100</div>
          <h3 id={`${id}-heading`}>
            Inflation & {basis.label.toLowerCase()}, compounded
          </h3>
          <p>
            {isMedian
              ? "Median weekly pay compared with quarterly-average consumer prices."
              : "Average hourly pay compared with monthly consumer prices."}{" "}
            Period changes compounded from a shared index of 100.
          </p>
        </div>
        <span className="unit-label">
          {scale === "index" ? "INDEX / 100 AT START" : "% FROM START"}
        </span>
      </div>
      {!print && (
        <div className="cumulative-controls">
          <div className="cumulative-start cumulative-measure">
            <label htmlFor={`${id}-measure`}>Earnings measure</label>
            <select
              id={`${id}-measure`}
              value={earningsBasis}
              onChange={(event) => onEarningsBasis(event.target.value)}
            >
              <option value="median">Median weekly earnings</option>
              <option value="average">Average hourly earnings</option>
            </select>
          </div>
          <div className="cumulative-start">
            <label htmlFor={`${id}-start`}>Starting {basis.cadence}</label>
            <select
              id={`${id}-start`}
              value={startMonth || ""}
              onChange={(event) => onStartMonth(event.target.value || null)}
              disabled={!comparison.baselineMonths.length}
            >
              <option value="">
                Range start ({range === "ALL" ? "all data" : `${range}Y`})
              </option>
              {startMonth &&
                !comparison.baselineMonths.includes(startMonth) && (
                  <option value={startMonth}>
                    {formatPeriod(startMonth)} (unavailable)
                  </option>
                )}
              {comparison.baselineMonths.map((month) => (
                <option key={month} value={month}>
                  {formatPeriod(month)}
                </option>
              ))}
            </select>
          </div>
          <div className="cumulative-control-group">
            <span>Plot interval</span>
            <div
              className="range-control"
              role="group"
              aria-label="Cumulative plotting interval"
            >
              {Object.entries(INTERVALS)
                .filter(([value]) => !isMedian || value !== "monthly")
                .map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={interval === value}
                    className={interval === value ? "selected" : ""}
                    onClick={() => onInterval(value)}
                  >
                    {label}
                  </button>
                ))}
            </div>
          </div>
          <div className="cumulative-control-group">
            <span>Show</span>
            <div
              className="range-control"
              role="group"
              aria-label="Cumulative chart series"
            >
              {[
                ["both", "Overlay"],
                ["prices", "Inflation"],
                ["earnings", isMedian ? "Weekly earnings" : "Hourly earnings"],
              ].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={view === value}
                  className={view === value ? "selected" : ""}
                  onClick={() => onView(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="cumulative-control-group">
            <span>Values</span>
            <div
              className="range-control"
              role="group"
              aria-label="Cumulative value scale"
            >
              {[
                ["index", "Index (100)"],
                ["percent", "% change"],
              ].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={scale === value}
                  className={scale === value ? "selected" : ""}
                  onClick={() => onScale(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      {!print && basisChangeNotice && (
        <p className="cumulative-basis-notice" role="status">
          {basisChangeNotice}
        </p>
      )}
      <p className="cumulative-period" aria-live={print ? undefined : "polite"}>
        {hasData ? (
          <>
            <strong>
              {start} → {end}
            </strong>{" "}
            · {basis.label} ·{" "}
            {scale === "index" ? "100 at start" : "0% at start"} ·{" "}
            {INTERVALS[interval]} points
            {partialEnd && (
              <>
                {" "}
                · {end} is a partial {periodName} endpoint
              </>
            )}
          </>
        ) : (
          "No comparable period available"
        )}
      </p>
      {hasData ? (
        <>
          <dl className="cumulative-totals">
            {Object.entries(series).map(([key, definition]) => (
              <div key={key}>
                <dt>{definition.label}</dt>
                <dd
                  data-testid={`cumulative-total-${key}`}
                  style={{ color: definition.color }}
                >
                  {percentage(comparison.totals[key])}
                </dd>
                <small>
                  <span
                    className="cumulative-index-reading"
                    data-testid={`cumulative-index-${key}`}
                  >
                    Index {indexValue(comparison.indexTotals[key])} · start 100
                  </span>
                  {key === "prices"
                    ? "Consumer price level"
                    : key === "earnings"
                      ? `Nominal pay per ${basis.payUnit}`
                      : `Purchasing power per ${basis.payUnit}`}
                </small>
              </div>
            ))}
          </dl>
          <ComparisonPlot
            rows={rows}
            keys={keys}
            syncId={id}
            print={print}
            scale={scale}
            series={series}
            basis={basis}
            earningsBasis={earningsBasis}
          />
          <div className="chart-legend">
            {keys.map((key) => (
              <span key={key}>
                <i
                  style={{
                    borderTop: `2px ${key === "prices" ? "dashed" : "solid"} ${series[key].color}`,
                  }}
                />
                {series[key].label}
              </span>
            ))}
          </div>
          <div className="cumulative-real-heading">
            <h4>{basis.realLabel}</h4>
            <p>
              Inflation-adjusted pay. Above {scale === "index" ? "100" : "zero"}{" "}
              means {basis.label.toLowerCase()} have outpaced consumer prices
              since {start}.
            </p>
          </div>
          <ComparisonPlot
            rows={rows}
            keys={["realEarnings"]}
            syncId={id}
            print={print}
            scale={scale}
            series={series}
            basis={basis}
            earningsBasis={earningsBasis}
            real
          />
          <p className="cumulative-caption">
            {rows.length === 1
              ? `Only one shared ${basis.cadence} is available for this starting point. `
              : ""}
            {isMedian
              ? interval === "quarterly"
                ? "Quarterly index values through the latest shared complete quarter."
                : "Fourth-quarter index values, plus the selected start and latest shared complete quarter."
              : interval === "monthly"
                ? "Monthly index values through the latest shared month."
                : `Calendar ${periodName}-end index values, plus the selected start and latest shared month.`}{" "}
            Changing the plot interval preserves the total change. Missing
            observations remain gaps.
          </p>
        </>
      ) : (
        <div className="chart-empty cumulative-empty" role="status">
          <p>
            {comparison.error ||
              `Both CPI and ${basis.label.toLowerCase()} need a usable observation in the same ${basis.cadence}.`}
          </p>
          <small>
            Choose an available starting {basis.cadence} or check the source
            status below.
          </small>
        </div>
      )}
      <p className="cumulative-caveat">
        {isMedian
          ? "Seasonally adjusted median usual weekly earnings of full-time wage and salary workers aged 16 and over. CPI-U is averaged across all three months of each quarter; incomplete quarters are omitted. No monthly median earnings are estimated."
          : "Seasonally adjusted CPI-U and average hourly earnings of all private nonfarm employees."}{" "}
        The workforce mix can change these measures; neither tracks the same
        worker or household income.
      </p>
      <div className="cumulative-sources">
        {sources.map((source) => {
          const status = freshness(snapshot, source, metadata);
          return (
            <div key={source}>
              <a
                className="source-link"
                href={
                  metadata[source]?.sourceUrl ||
                  `https://fred.stlouisfed.org/series/${source}`
                }
                target="_blank"
                rel="noreferrer"
              >
                {source === "CPIAUCSL"
                  ? "BLS consumer prices"
                  : isMedian
                    ? "BLS median usual weekly earnings"
                    : "BLS average hourly earnings"}{" "}
                via FRED ↗
              </a>
              <span>
                Latest source{" "}
                {source === "LES1252881500Q" ? "quarter" : "month"}:{" "}
                {source === "LES1252881500Q"
                  ? formatPeriod(status.observedDate)
                  : monthLabel(status.observedDate)}
              </span>
              <span>
                Comparison ends at shared {basis.cadence}: {end}
              </span>
              <span>
                Retrieved:{" "}
                {status.fetchedAt
                  ? new Date(status.fetchedAt)
                      .toISOString()
                      .replace("T", " ")
                      .slice(0, 16) + " UTC"
                  : "Not available"}
              </span>
              {status.state !== "fresh" && (
                <strong className="cumulative-source-warning">
                  {status.state === "error"
                    ? "Retained data — source refresh failed. "
                    : status.state === "stale"
                      ? "Aging observation. "
                      : ""}
                  {status.message}
                </strong>
              )}
            </div>
          );
        })}
      </div>
      {!print && (
        <details className="chart-data cumulative-method">
          <summary>Calculation and chart observations</summary>
          <p>
            Each index starts at 100. Next index = previous index × (1 + period
            percentage change / 100). Changes of +3%, +2%, and +9% produce 100 →
            103 → 105.06 → 114.5154, a cumulative gain of 14.5154%. Full
            precision is retained throughout; displayed values are rounded.
          </p>
          <p>
            {isMedian
              ? "Quarterly CPI is the arithmetic mean of all three positive monthly, seasonally adjusted CPI-U levels. Quarterly median usual weekly earnings are used as published. A quarter is unavailable if any CPI month or its earnings observation is missing."
              : "Price and earnings changes come from successive monthly CPI and average-hourly-pay observations."}{" "}
            The real earnings index compounds changes in {basis.payAdjective}{" "}
            pay divided by CPI: each period's real growth factor is (1 +
            earnings growth) / (1 + price growth), using decimal rates. For
            example, 30% earnings growth with 25% inflation gives a real index
            of 104, or +4%. We never chain overlapping year-over-year rates.
          </p>
          <p>
            Missing {isMedian ? "quarters" : "months"} remain gaps. When a
            source resumes, its index links the total change from the last
            usable observation across that span; no{" "}
            {isMedian ? "quarterly" : "monthly"} rates are invented for the
            missing periods.
            {isMedian &&
              " Quarterly earnings are never interpolated into monthly values."}
          </p>
          <p>
            Both charts end at the latest shared {basis.cadence} with usable
            values for both sources, even in a single-series view. The starting{" "}
            {basis.cadence} can be selected from all shared observations in this
            snapshot. Choosing a history range resets the baseline to that
            range; switching the earnings measure also resets the baseline.
            {isMedian
              ? " Yearly plots sample fourth-quarter indices, plus the selected start and latest shared complete quarter. The dates label the quarter being measured, not the earnings release date."
              : " Quarterly and yearly views sample the compounded monthly indices; they are not period averages or annualized rates."}{" "}
            Seasonal adjustments and historical revisions can change past
            results.
          </p>
          <div className="table-scroll">
            <table>
              <caption>
                Latest 12 plotted {isMedian ? "quarters" : "months"} ·{" "}
                {scale === "index"
                  ? "index (start = 100)"
                  : "cumulative change (%)"}
              </caption>
              <thead>
                <tr>
                  <th>{isMedian ? "Quarter" : "Month"}</th>
                  {Object.values(series).map((series) => (
                    <th key={series.label}>{series.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows
                  .slice(-12)
                  .reverse()
                  .map((row) => (
                    <tr key={row.date}>
                      <td>
                        {formatPeriod(row.date)}
                        {row.date.slice(0, 7) === comparison.startMonth
                          ? " · start"
                          : row.partial
                            ? " · partial"
                            : ""}
                      </td>
                      {Object.keys(series).map((key) => (
                        <td key={key}>
                          {scale === "index"
                            ? indexValue(row[key])
                            : percentage(row[key])}
                        </td>
                      ))}
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <p>
            — indicates a missing observation. Extra gap markers may appear
            between period endpoints. Methodology:{" "}
            <a
              href={
                isMedian
                  ? "https://www.bls.gov/news.release/wkyeng.tn.htm"
                  : "https://www.bls.gov/news.release/realer.tn.htm"
              }
              target="_blank"
              rel="noreferrer"
            >
              {isMedian ? "BLS usual weekly earnings" : "BLS real earnings"} ↗
            </a>
            .
          </p>
        </details>
      )}
    </article>
  );
}
