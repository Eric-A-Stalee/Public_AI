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

const SERIES = {
  prices: { label: "Cumulative inflation", color: "var(--amber)", dash: "6 3" },
  earnings: { label: "Average hourly earnings", color: "var(--cyan)" },
  realEarnings: { label: "Real hourly earnings", color: "var(--green)" },
};
const SOURCES = ["CPIAUCSL", "CES0500000003"];
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
function percentage(value) {
  return formatValue(value, {
    digits: 2,
    prefix: value > 0 ? "+" : "",
    suffix: "%",
  });
}
function CumulativeTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <strong>{monthLabel(label)}</strong>
      {payload.map((entry) => (
        <div key={entry.dataKey}>
          <span style={{ color: entry.stroke }}>
            {SERIES[entry.dataKey].label}
          </span>
          <b>{percentage(entry.value)}</b>
        </div>
      ))}
    </div>
  );
}
function ComparisonPlot({ rows, keys, syncId, print, real = false }) {
  return (
    <div
      className={`chart-area ${real ? "cumulative-real-area" : "cumulative-main-area"}`}
      data-testid={real ? "cumulative-real-chart" : "cumulative-nominal-chart"}
      role="group"
      aria-label={
        real
          ? "Cumulative inflation-adjusted hourly earnings"
          : "Cumulative percentage change from the selected starting month"
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
            tick={{ fill: "var(--muted)", fontSize: 10 }}
            tickFormatter={monthLabel}
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            width={62}
            tick={{ fill: "var(--muted)", fontSize: 10 }}
            tickFormatter={(value) => `${Number(value.toFixed(1))}%`}
          />
          <ReferenceLine y={0} stroke="var(--dim)" strokeDasharray="3 3" />
          <Tooltip
            content={<CumulativeTooltip />}
            cursor={{ stroke: "var(--muted)", strokeDasharray: "3 3" }}
          />
          {keys.map((key) => (
            <Line
              key={key}
              dataKey={key}
              name={SERIES[key].label}
              type="linear"
              stroke={SERIES[key].color}
              strokeDasharray={SERIES[key].dash}
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
                    fill={SERIES[key].color}
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
  startMonth,
  interval,
  view,
  onStartMonth,
  onInterval,
  onView,
  print = false,
}) {
  const id = useId();
  const comparison = useMemo(
    () => cumulativeComparison(snapshot, { startMonth, range, interval }),
    [snapshot, startMonth, range, interval],
  );
  const rows = useMemo(
    () =>
      comparison.rows.map((row) => ({
        ...row,
        time: Date.parse(`${row.date}T00:00:00Z`),
      })),
    [comparison],
  );
  const keys =
    view === "prices"
      ? ["prices"]
      : view === "earnings"
        ? ["earnings"]
        : ["prices", "earnings"];
  const start = monthLabel(comparison.startMonth);
  const end = monthLabel(comparison.endMonth);
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
          <div className="eyebrow">THE CUMULATIVE VIEW</div>
          <h3 id={`${id}-heading`}>Inflation & hourly earnings, compounded</h3>
          <p>
            How consumer prices and average hourly pay have changed since the
            same starting month.
          </p>
        </div>
        <span className="unit-label">% FROM START</span>
      </div>
      {!print && (
        <div className="cumulative-controls">
          <div className="cumulative-start">
            <label htmlFor={`${id}-start`}>Starting month</label>
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
                    {monthLabel(startMonth)} (unavailable)
                  </option>
                )}
              {comparison.baselineMonths.map((month) => (
                <option key={month} value={month}>
                  {monthLabel(month)}
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
              {Object.entries(INTERVALS).map(([value, label]) => (
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
                ["earnings", "Hourly earnings"],
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
        </div>
      )}
      <p className="cumulative-period" aria-live={print ? undefined : "polite"}>
        {hasData ? (
          <>
            <strong>
              {start} → {end}
            </strong>{" "}
            · 0% at start · {INTERVALS[interval]} points
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
            {Object.entries(SERIES).map(([key, definition]) => (
              <div key={key}>
                <dt>{definition.label}</dt>
                <dd
                  data-testid={`cumulative-total-${key}`}
                  style={{ color: definition.color }}
                >
                  {percentage(comparison.totals[key])}
                </dd>
                <small>
                  {key === "prices"
                    ? "Consumer price level"
                    : key === "earnings"
                      ? "Nominal pay per hour"
                      : "Purchasing power per hour"}
                </small>
              </div>
            ))}
          </dl>
          <ComparisonPlot rows={rows} keys={keys} syncId={id} print={print} />
          <div className="chart-legend">
            {keys.map((key) => (
              <span key={key}>
                <i
                  style={{
                    borderTop: `2px ${key === "prices" ? "dashed" : "solid"} ${SERIES[key].color}`,
                  }}
                />
                {SERIES[key].label}
              </span>
            ))}
          </div>
          <div className="cumulative-real-heading">
            <h4>Real hourly earnings</h4>
            <p>
              Inflation-adjusted pay. Above zero means average hourly earnings
              have outpaced consumer prices since {start}.
            </p>
          </div>
          <ComparisonPlot
            rows={rows}
            keys={["realEarnings"]}
            syncId={id}
            print={print}
            real
          />
          <p className="cumulative-caption">
            {rows.length === 1
              ? "Only one shared month is available for this starting point. "
              : ""}
            {interval === "monthly"
              ? "Monthly levels from the selected start through the latest shared month."
              : `Calendar ${periodName}-end months, plus the selected start and latest shared month.`}{" "}
            Changing the plot interval preserves the total change. Missing
            observations remain gaps.
          </p>
        </>
      ) : (
        <div className="chart-empty cumulative-empty" role="status">
          <p>
            {comparison.error ||
              "Both CPI and hourly earnings need a usable observation in the same month."}
          </p>
          <small>
            Choose an available starting month or check the source status below.
          </small>
        </div>
      )}
      <p className="cumulative-caveat">
        Seasonally adjusted CPI-U and average hourly earnings of all private
        nonfarm employees. Averages can change with the mix of jobs; this does
        not track the same worker or household income.
      </p>
      <div className="cumulative-sources">
        {SOURCES.map((source) => {
          const status = freshness(snapshot, source, metadata);
          return (
            <div key={source}>
              <a
                className="source-link"
                href={metadata[source].sourceUrl}
                target="_blank"
                rel="noreferrer"
              >
                {source === "CPIAUCSL"
                  ? "BLS consumer prices"
                  : "BLS hourly earnings"}{" "}
                via FRED ↗
              </a>
              <span>Latest observation: {monthLabel(status.observedDate)}</span>
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
            Inflation = (CPI / starting CPI − 1) × 100. Earnings = (hourly pay /
            starting hourly pay − 1) × 100. Real earnings = ((hourly pay /
            starting hourly pay) / (CPI / starting CPI) − 1) × 100. For example,
            pay rising 30% while prices rise 25% means a 4% real gain.
            Calculations use the source levels, so overlapping year-over-year
            rates are never compounded.
          </p>
          <p>
            Both charts end at the latest month with usable values for both
            sources, even in a single-series view. The starting month can be
            selected from all shared observations in this snapshot. Choosing a
            history range above resets the starting month to that range.
            Quarterly and yearly views sample monthly levels; they are not
            period averages or annualized rates. Seasonal adjustments and
            historical revisions can change past results.
          </p>
          <div className="table-scroll">
            <table>
              <caption>
                Latest 12 plotted months · cumulative change (%)
              </caption>
              <thead>
                <tr>
                  <th>Month</th>
                  {Object.values(SERIES).map((series) => (
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
                        {monthLabel(row.date)}
                        {row.date.slice(0, 7) === comparison.startMonth
                          ? " · start"
                          : row.partial
                            ? " · partial"
                            : ""}
                      </td>
                      {Object.keys(SERIES).map((key) => (
                        <td key={key}>{percentage(row[key])}</td>
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
              href="https://www.bls.gov/news.release/realer.tn.htm"
              target="_blank"
              rel="noreferrer"
            >
              BLS real earnings ↗
            </a>
            .
          </p>
        </details>
      )}
    </article>
  );
}
