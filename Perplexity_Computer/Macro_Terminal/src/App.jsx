import React, { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
} from "recharts";
import seriesMetadata from "../config/series.json";
import {
  INDICATORS,
  pointsFor,
  latestReading,
  yieldCurve,
  formatValue,
  freshness,
  TREASURY_MATURITIES,
} from "./model.js";
import { useSnapshot } from "./useSnapshot.js";
import CumulativeComparison from "./CumulativeComparison.jsx";

const TABS = ["Overview", "Rates", "Inflation", "Growth", "Labor", "Risk"];
const COLORS = ["#71d6a1", "#68c8d9", "#e5bd72", "#ac9ee7"];
const SECTIONS = {
  Overview: {
    eyebrow: "01 / THE BIG PICTURE",
    title: "The economy, observed.",
    subtitle: "Dated evidence across policy, prices, growth, and risk.",
  },
  Rates: {
    eyebrow: "02 / THE PRICE OF MONEY",
    title: "Rates & the yield curve",
    subtitle: "Policy settings, Treasury yields, and the cost of borrowing.",
  },
  Inflation: {
    eyebrow: "03 / PRICE PRESSURES",
    title: "Inflation & purchasing power",
    subtitle:
      "Cumulative price changes, purchasing power, and the pace of inflation.",
  },
  Growth: {
    eyebrow: "04 / ECONOMIC ACTIVITY",
    title: "Growth & liquidity",
    subtitle: "Real output, the money supply, and residential construction.",
  },
  Labor: {
    eyebrow: "05 / THE LABOR MARKET",
    title: "Employment & earnings",
    subtitle: "Jobs, unemployment, wages, and labor-market turnover.",
  },
  Risk: {
    eyebrow: "06 / FINANCIAL CONDITIONS",
    title: "Risk & market context",
    subtitle: "Volatility, credit conditions, energy, and household sentiment.",
  },
};

function formatDate(value, options = {}) {
  if (!value) return "Not available";
  const date = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
  return Number.isNaN(date.valueOf())
    ? "Not available"
    : new Intl.DateTimeFormat("en-US", {
        timeZone: "UTC",
        month: "short",
        day: "numeric",
        year: "numeric",
        ...options,
      }).format(date);
}
function formatTimestamp(value) {
  return value
    ? `${formatDate(value, { hour: "2-digit", minute: "2-digit", hour12: false })} UTC`
    : "Not yet published";
}
function getIndicator(key) {
  if (key === "treasury2y")
    return {
      id: "DGS2",
      label: "2-year Treasury",
      unit: "%",
      suffix: "%",
      digits: 2,
      description: "Daily constant maturity Treasury yield.",
    };
  return INDICATORS[key];
}
function getReading(snapshot, key) {
  const definition = getIndicator(key);
  return {
    ...latestReading(snapshot, definition.id, {
      ...definition,
      frequency: seriesMetadata[definition.id]?.frequency,
    }),
    definition,
  };
}
function valueText(reading) {
  return formatValue(reading.value, {
    digits: reading.definition.digits ?? 1,
    prefix: reading.definition.prefix ?? "",
    suffix: reading.definition.suffix ?? "",
  });
}
function dateLabel(date, id) {
  if (!date) return "No observation";
  const frequency = seriesMetadata[id]?.frequency?.toLowerCase();
  if (frequency?.includes("quarter"))
    return `Q${Math.ceil(Number(date.slice(5, 7)) / 3)} ${date.slice(0, 4)}`;
  if (frequency?.includes("month")) return formatDate(date, { day: undefined });
  return formatDate(date);
}
function StatusDot({ kind = "fresh" }) {
  return <span className={`status-dot ${kind}`} aria-hidden="true" />;
}
function SourceLink({ id, children }) {
  return (
    <a
      className="source-link"
      href={
        seriesMetadata[id]?.sourceUrl ||
        `https://fred.stlouisfed.org/series/${encodeURIComponent(id)}`
      }
      target="_blank"
      rel="noreferrer"
    >
      {children || `${seriesMetadata[id]?.source || "FRED"} ↗`}
    </a>
  );
}

function MetricCard({ snapshot, metric, compact = false, print = false }) {
  const reading = getReading(snapshot, metric);
  const { definition, date, change, previousValue, previousDate } = reading;
  const raw = snapshot?.series?.[definition.id];
  const status = freshness(snapshot, definition.id, seriesMetadata);
  const retained = raw?.status === "error" && Number.isFinite(reading.value);
  const unavailable = !Number.isFinite(reading.value);
  const changeUnit =
    definition.suffix === "%" ? " pp" : definition.suffix || "";
  return (
    <article
      data-testid={print ? undefined : `metric-${metric}`}
      className={`metric-card ${compact ? "compact" : ""}`}
    >
      <div className="metric-top">
        <h3>{definition.label}</h3>
        <span className="metric-symbol" aria-hidden="true">
          ↗
        </span>
      </div>
      <div className="metric-number">{valueText(reading)}</div>
      <div className="metric-unit">{definition.unit}</div>
      <div className="metric-change">
        {Number.isFinite(change) ? (
          <>
            <span className="change-value">
              {change > 0 ? "+" : ""}
              {formatValue(change, {
                digits: definition.digits ?? 1,
                suffix: changeUnit,
              })}
            </span>
            <span>vs. {dateLabel(previousDate, definition.id)}</span>
          </>
        ) : (
          <span>
            {unavailable
              ? "Awaiting usable observations"
              : "Prior period unavailable"}
          </span>
        )}
      </div>
      <div className="metric-bottom">
        <span>OBS {dateLabel(date, definition.id)}</span>
        <SourceLink id={definition.id} />
      </div>
      {print && (
        <p className="metric-retrieved">
          Retrieved {formatTimestamp(raw?.fetchedAt)}
        </p>
      )}
      {!compact && !print && (
        <details className="metric-details">
          <summary>Definition & data status</summary>
          <p>{definition.description}</p>
          <p>{seriesMetadata[definition.id]?.notes}</p>
          {Number.isFinite(previousValue) && (
            <p>
              Prior:{" "}
              {formatValue(previousValue, {
                digits: definition.digits ?? 1,
                suffix: definition.suffix ?? "",
              })}{" "}
              ({dateLabel(previousDate, definition.id)}).
            </p>
          )}
          <p>Source retrieved: {formatTimestamp(raw?.fetchedAt)}.</p>
          {raw?.error && <p>{raw.error}</p>}
        </details>
      )}
      {(retained || status.state === "stale" || unavailable) && (
        <div className="metric-warning">
          <StatusDot kind="stale" />
          {retained
            ? "Retained data · source update failed"
            : unavailable
              ? raw?.status === "unavailable"
                ? "Source unavailable"
                : date
                  ? "Required comparison missing"
                  : "No published observations"
              : "Aging observation · check release timing"}
        </div>
      )}
    </article>
  );
}

function PolicyCard({ snapshot, print = false }) {
  const lower = snapshot?.series?.DFEDTARL;
  const upper = snapshot?.series?.DFEDTARU;
  const upperByDate = new Map(
    (upper?.observations || [])
      .filter((p) => Number.isFinite(p.value))
      .map((p) => [p.date, p.value]),
  );
  const point = [...(lower?.observations || [])]
    .reverse()
    .find((p) => Number.isFinite(p.value) && upperByDate.has(p.date));
  const complete = point && point.value <= upperByDate.get(point.date);
  const stale =
    complete &&
    (Date.now() - Date.parse(point.date)) / 86400000 >
      (seriesMetadata.DFEDTARL?.staleAfterDays || 7);
  return (
    <article
      data-testid={print ? undefined : "metric-policy"}
      className="metric-card policy-card"
    >
      <div className="metric-top">
        <h3>Federal funds target</h3>
        <span className="metric-symbol">◎</span>
      </div>
      <div className="metric-number policy-number">
        {complete
          ? `${point.value.toFixed(2)}–${upperByDate.get(point.date).toFixed(2)}%`
          : "—"}
      </div>
      <div className="metric-change">FOMC target range · lower–upper bound</div>
      <div className="metric-bottom">
        <span>
          OBS {complete ? formatDate(point.date) : "No aligned observation"}
        </span>
        <SourceLink id="DFEDTARU" />
      </div>
      {print && (
        <p className="metric-retrieved">
          {formatTimestamp(lower?.fetchedAt) ===
          formatTimestamp(upper?.fetchedAt)
            ? `Both bounds retrieved ${formatTimestamp(lower?.fetchedAt)}`
            : `Lower retrieved ${formatTimestamp(lower?.fetchedAt)}; upper retrieved ${formatTimestamp(upper?.fetchedAt)}`}
        </p>
      )}
      {!print && (
        <details className="metric-details">
          <summary>Definition & data status</summary>
          <p>
            Target range bounds are matched on the same observation date; this
            is not the effective federal funds rate.
          </p>
          <p>
            Lower bound retrieved: {formatTimestamp(lower?.fetchedAt)}. Upper
            bound retrieved: {formatTimestamp(upper?.fetchedAt)}.
          </p>
        </details>
      )}
      {(!complete ||
        stale ||
        lower?.status === "error" ||
        upper?.status === "error") && (
        <div className="metric-warning">
          <StatusDot kind="stale" />
          {!complete
            ? "No aligned published range"
            : lower?.status === "error" || upper?.status === "error"
              ? "Retained data · source update failed"
              : "Aging observation · check release timing"}
        </div>
      )}
    </article>
  );
}

function MetricGrid({ snapshot, metrics, policy = false, print = false }) {
  return (
    <div className="metric-grid">
      {policy && <PolicyCard snapshot={snapshot} print={print} />}
      {metrics.map((metric) => (
        <MetricCard
          key={metric}
          snapshot={snapshot}
          metric={metric}
          print={print}
        />
      ))}
    </div>
  );
}
function EmptyChart({
  message = "No usable observations are published for this chart.",
}) {
  return (
    <div className="chart-empty">
      <span aria-hidden="true">— / —</span>
      <p>{message}</p>
      <small>Values will appear after a successful data collection.</small>
    </div>
  );
}
function ChartTooltip({ active, payload, label, unit }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <strong>
        {/^\d{4}-\d{2}-\d{2}$/.test(label) ? formatDate(label) : label}
      </strong>
      {payload.map((p) => (
        <div key={p.dataKey}>
          <span style={{ color: p.stroke || p.fill }}>{p.name}</span>
          <b>
            {formatValue(p.value, {
              digits: 2,
              suffix: unit ? ` ${unit}` : "",
            })}
          </b>
        </div>
      ))}
    </div>
  );
}
function HistoryChart({
  snapshot,
  title,
  subtitle,
  metrics,
  unit = "%",
  reference,
  bar = false,
  range,
  print = false,
}) {
  const definitions = metrics.map(getIndicator);
  const data = useMemo(() => {
    const rows = new Map();
    for (const key of metrics) {
      const definition = getIndicator(key);
      for (const p of pointsFor(snapshot, definition.id, definition)) {
        if (!rows.has(p.date)) rows.set(p.date, { date: p.date });
        rows.get(p.date)[key] = p.value;
      }
    }
    const sorted = [...rows.values()].sort((a, b) =>
      a.date.localeCompare(b.date),
    );
    if (!sorted.length || range === "ALL") return sorted;
    const last = new Date(`${sorted.at(-1).date}T00:00:00Z`);
    last.setUTCFullYear(last.getUTCFullYear() - Number(range));
    return sorted.filter((p) => p.date >= last.toISOString().slice(0, 10));
  }, [snapshot, metrics.join(","), range]);
  const hasData = data.some((p) =>
    metrics.some((key) => Number.isFinite(p[key])),
  );
  const Chart = bar ? BarChart : LineChart;
  const sources = [...new Set(definitions.map((d) => d.id))];
  const stale = sources.some(
    (id) => freshness(snapshot, id, seriesMetadata).state === "stale",
  );
  const retained = sources.some(
    (id) => snapshot?.series?.[id]?.status === "error",
  );
  return (
    <article
      className={`panel chart-panel ${metrics.length === 1 ? "single-series" : ""}`}
    >
      <div className="panel-heading">
        <div>
          <h3>{title}</h3>
          <p>{subtitle}</p>
        </div>
        <span className="unit-label">{unit}</span>
      </div>
      <div className="chart-area">
        {hasData ? (
          <ResponsiveContainer
            width="100%"
            height="100%"
            minWidth={0}
            initialDimension={print ? { width: 400, height: 140 } : undefined}
          >
            <Chart
              data={data}
              margin={{ top: 12, right: 16, bottom: 0, left: -15 }}
              accessibilityLayer
            >
              <CartesianGrid
                vertical={false}
                stroke="var(--grid)"
                strokeDasharray="3 4"
              />
              <XAxis
                dataKey="date"
                axisLine={false}
                tickLine={false}
                minTickGap={46}
                tick={{ fill: "var(--muted)", fontSize: 10 }}
                tickFormatter={(date) =>
                  formatDate(date, { day: undefined, year: "2-digit" })
                }
              />
              <YAxis
                axisLine={false}
                tickLine={false}
                tick={{ fill: "var(--muted)", fontSize: 10 }}
                width={58}
                domain={bar ? ["auto", "auto"] : ["auto", "auto"]}
                tickFormatter={(value) =>
                  Math.abs(value) >= 1000
                    ? `${(value / 1000).toFixed(0)}k`
                    : value
                }
              />
              <Tooltip
                content={<ChartTooltip unit={unit} />}
                cursor={{ stroke: "var(--muted)", strokeDasharray: "3 3" }}
              />
              {reference !== undefined && (
                <ReferenceLine
                  y={reference}
                  stroke="var(--amber)"
                  strokeDasharray="5 5"
                  label={{
                    value: `${reference}${unit === "%" ? "%" : ""}`,
                    fill: "var(--amber)",
                    fontSize: 10,
                    position: "insideTopRight",
                  }}
                />
              )}
              {metrics.map((key, index) =>
                bar ? (
                  <Bar
                    key={key}
                    dataKey={key}
                    name={getIndicator(key).label}
                    fill={COLORS[index % COLORS.length]}
                    isAnimationActive={false}
                    maxBarSize={20}
                  />
                ) : (
                  <Line
                    key={key}
                    dataKey={key}
                    name={getIndicator(key).label}
                    type="linear"
                    stroke={COLORS[index % COLORS.length]}
                    strokeWidth={print ? 2.5 : 2}
                    dot={data.length === 1 ? { r: 3 } : false}
                    activeDot={{ r: 4 }}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                ),
              )}
            </Chart>
          </ResponsiveContainer>
        ) : (
          <EmptyChart />
        )}
      </div>
      <div className="chart-legend">
        {definitions.map((d, index) => (
          <span key={d.id}>
            <i style={{ background: COLORS[index % COLORS.length] }} />
            {d.label}
          </span>
        ))}
      </div>
      <div className="panel-foot">
        <span>
          {hasData
            ? `${formatDate(data[0]?.date)} – ${formatDate(data.at(-1)?.date)}`
            : "Waiting for published data"}
          {retained
            ? " · retained source data"
            : stale
              ? " · aging observation"
              : ""}
        </span>
        <span>
          {sources.map((id) => (
            <SourceLink key={id} id={id}>
              {id} ↗
            </SourceLink>
          ))}
        </span>
      </div>
      <details className="chart-data">
        <summary>View observations</summary>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Observation date</th>
                {definitions.map((d) => (
                  <th key={d.id}>{d.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data
                .slice(-12)
                .reverse()
                .map((row) => (
                  <tr key={row.date}>
                    <td>{row.date}</td>
                    {metrics.map((key) => (
                      <td key={key}>
                        {formatValue(row[key], {
                          digits: getIndicator(key).digits ?? 2,
                        })}
                      </td>
                    ))}
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        <p>
          Latest 12 chart dates shown. Blank values represent missing
          observations or comparison periods.
        </p>
      </details>
    </article>
  );
}
function YieldCurve({ snapshot, print = false }) {
  const curve = yieldCurve(snapshot);
  const hasData = curve.points.some((p) => Number.isFinite(p.value));
  const retained = TREASURY_MATURITIES.some(
    ({ id }) => snapshot?.series?.[id]?.status === "error",
  );
  const aged =
    curve.date &&
    (Date.now() - Date.parse(curve.date)) / 86400000 >
      (seriesMetadata.DGS10?.staleAfterDays || 7);
  return (
    <article className="panel chart-panel single-series">
      <div className="panel-heading">
        <div>
          <h3>U.S. Treasury yield curve</h3>
          <p>
            {curve.date
              ? `All maturities aligned to ${formatDate(curve.date)}`
              : "Same-day observations across the maturity spectrum"}
          </p>
        </div>
        <span className="unit-label">YIELD %</span>
      </div>
      <div className="chart-area">
        {hasData ? (
          <ResponsiveContainer
            width="100%"
            height="100%"
            minWidth={0}
            initialDimension={print ? { width: 400, height: 140 } : undefined}
          >
            <LineChart
              data={curve.points}
              margin={{ top: 12, right: 16, bottom: 0, left: -15 }}
              accessibilityLayer
            >
              <CartesianGrid
                vertical={false}
                stroke="var(--grid)"
                strokeDasharray="3 4"
              />
              <XAxis
                dataKey="label"
                axisLine={false}
                tickLine={false}
                interval={0}
                tick={{ fill: "var(--muted)", fontSize: 10 }}
              />
              <YAxis
                axisLine={false}
                tickLine={false}
                domain={["auto", "auto"]}
                tick={{ fill: "var(--muted)", fontSize: 10 }}
                width={58}
              />
              <Tooltip content={<ChartTooltip unit="%" />} />
              <Line
                dataKey="value"
                name="Treasury yield"
                type="linear"
                stroke={COLORS[1]}
                strokeWidth={2}
                dot={{ r: 3, strokeWidth: 0 }}
                connectNulls={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <EmptyChart message="No complete, same-day Treasury curve is available." />
        )}
      </div>
      <div className="chart-legend">
        <span>
          <i style={{ background: COLORS[1] }} />
          Constant maturity · daily Treasury rates
        </span>
      </div>
      <div className="panel-foot">
        <span>
          {retained
            ? "Retained source data · collection error"
            : aged
              ? "Aging shared observation"
              : "No interpolation or mixed-date maturities"}
        </span>
        <SourceLink id="DGS10">U.S. Treasury / FRED ↗</SourceLink>
      </div>
    </article>
  );
}

function ReadingPanel({ snapshot, keys = ["corePce", "gdp", "payrolls"] }) {
  const readings = keys.map((key) => ({
    key,
    ...getReading(snapshot, key),
    status: freshness(snapshot, getIndicator(key).id, seriesMetadata),
  }));
  function narrative(r) {
    if (!Number.isFinite(r.value))
      return "A usable observation is not available. No directional reading has been assigned.";
    const movement = Number.isFinite(r.change)
      ? r.change > 0
        ? "higher than"
        : r.change < 0
          ? "lower than"
          : "unchanged from"
      : null;
    if (r.key === "corePce" || r.key === "pce")
      return `${r.definition.label} is ${valueText(r)}${movement ? `, ${movement} the prior month’s year-over-year rate` : ""}. The Fed’s 2% longer-run goal is defined on headline PCE inflation, not CPI or a short-term forecast.`;
    if (r.key === "gdp")
      return `Real GDP ${r.value >= 0 ? "expanded" : "contracted"} at a ${valueText({ ...r, value: Math.abs(r.value) })} annualized quarterly pace. This is a single quarterly observation, subject to revision.`;
    if (r.key === "payrolls")
      return `Total nonfarm payrolls ${r.value >= 0 ? "increased" : "decreased"} by ${formatValue(Math.abs(r.value), { digits: 0 })} thousand from the previous month. Revisions can change both the current gain and prior comparisons.`;
    if (r.key === "spread10y2y" || r.key === "spread10y3m")
      return `The ${r.key === "spread10y2y" ? "10-year minus 2-year" : "10-year minus 3-month"} Treasury spread is ${valueText(r)}. ${r.value < 0 ? "The selected part of the curve is inverted." : r.value > 0 ? "The selected part of the curve slopes upward." : "The selected maturities have equal yields."} This describes the curve; it does not assign a recession probability.`;
    if (r.key === "conditions")
      return `The Chicago Fed NFCI is ${valueText(r)}. ${r.value === 0 ? "Zero represents historically average financial conditions" : `A ${r.value < 0 ? "negative" : "positive"} reading indicates ${r.value < 0 ? "looser" : "tighter"}-than-average financial conditions`}; it is not a probability or forecast.`;
    return `${r.definition.label} is ${valueText(r)}${movement ? `, ${movement} the comparable prior observation` : ""}. ${r.definition.description}`;
  }
  return (
    <article className="panel readings-panel">
      <div className="panel-heading">
        <div>
          <h3>What the observations say</h3>
          <p>Calculated descriptions · no discretionary market forecasts</p>
        </div>
        <span className="tag">DATA → CONTEXT</span>
      </div>
      <div className="reading-grid">
        {readings.map((r) => (
          <div key={r.key}>
            <div className="reading-label">
              <StatusDot
                kind={Number.isFinite(r.value) ? r.status.state : "unavailable"}
              />
              <h4>{r.definition.label}</h4>
            </div>
            <p>{narrative(r)}</p>
            <small>
              OBS {dateLabel(r.date, r.definition.id)}
              {r.status.state === "error"
                ? " · retained data / update failed"
                : r.status.state === "stale"
                  ? " · aging observation"
                  : ""}
            </small>
          </div>
        ))}
      </div>
    </article>
  );
}

function ResearchPanel({ tab = "Overview" }) {
  const links = [
    {
      title: "Release calendar",
      text: "Upcoming releases and revisions are maintained by the publishing agencies. No calendar feed is configured here.",
      links: [
        ["BLS schedule", "https://www.bls.gov/schedule/"],
        ["BEA schedule", "https://www.bea.gov/news/schedule"],
      ],
    },
    {
      title: "Survey & research coverage",
      text: "ISM, Conference Board confidence, Goldman forecasts, and investment commentary require separate sourced feeds. No prior estimates are carried forward.",
      links: [
        [
          "ISM reports",
          "https://www.ismworld.org/supply-management-news-and-reports/reports/ism-report-on-business/",
        ],
        [
          "Conference Board",
          "https://www.conference-board.org/topics/consumer-confidence",
        ],
      ],
    },
    {
      title: "High-yield credit spread",
      text: "ICE high-yield OAS is not redistributed in this dataset. An ETF share price is not a credit spread. Review the original source and its terms.",
      links: [
        [
          "ICE BofA HY OAS / FRED",
          "https://fred.stlouisfed.org/series/BAMLH0A0HYM2",
        ],
      ],
    },
  ];
  return (
    <article className="panel research-panel">
      <div className="panel-heading">
        <div>
          <h3>Research & coverage gaps</h3>
          <p>External context stays separate from the measured indicators.</p>
        </div>
        <span className="tag amber">NOT AUTOMATED</span>
      </div>
      <div className="research-grid">
        {links
          .filter((_, index) => tab !== "Growth" || index !== 2)
          .map((item) => (
            <div key={item.title}>
              <h4>{item.title}</h4>
              <p>{item.text}</p>
              <div>
                {item.links.map(([name, url]) => (
                  <a key={url} href={url} target="_blank" rel="noreferrer">
                    {name} ↗
                  </a>
                ))}
              </div>
            </div>
          ))}
      </div>
    </article>
  );
}
function Section({ tab, snapshot, range, cumulative, print = false }) {
  const info = SECTIONS[tab];
  const props = { snapshot, range, print };
  return (
    <section
      className={`dashboard-section section-${tab.toLowerCase()}`}
      aria-label={tab}
    >
      <div className="section-heading">
        <div>
          <div className="eyebrow">{info.eyebrow}</div>
          <h1>{info.title}</h1>
          <p>{info.subtitle}</p>
        </div>
        <span className="section-stamp">U.S. MACRO / PUBLIC DATA</span>
      </div>
      {tab === "Overview" && (
        <>
          <MetricGrid
            print={print}
            snapshot={snapshot}
            policy
            metrics={[
              "cpi",
              "corePce",
              "gdp",
              "unemployment",
              "payrolls",
              "treasury10y",
              "vix",
            ]}
          />
          <div className="chart-grid">
            <HistoryChart
              {...props}
              title="The inflation path"
              subtitle="12-month percentage change · published observations"
              metrics={["cpi", "coreCpi", "corePce"]}
            />
            <YieldCurve snapshot={snapshot} print={print} />
          </div>
          <ReadingPanel snapshot={snapshot} />
          <ResearchPanel />
        </>
      )}
      {tab === "Rates" && (
        <>
          <MetricGrid
            print={print}
            snapshot={snapshot}
            policy
            metrics={["treasury2y", "treasury10y", "mortgage"]}
          />
          <div className="chart-grid">
            <YieldCurve snapshot={snapshot} print={print} />
            <HistoryChart
              {...props}
              title="Treasury yields"
              subtitle="Daily constant maturity rates"
              metrics={["treasury2y", "treasury10y"]}
            />
            <HistoryChart
              {...props}
              title="Yield-curve spreads"
              subtitle="Percentage points · below zero indicates inversion"
              metrics={["spread10y2y", "spread10y3m"]}
              unit="pp"
              reference={0}
            />
            <HistoryChart
              {...props}
              title="30-year mortgage rate"
              subtitle="Freddie Mac Primary Mortgage Market Survey · weekly"
              metrics={["mortgage"]}
            />
          </div>
          <ReadingPanel
            snapshot={snapshot}
            keys={["spread10y2y", "spread10y3m", "mortgage"]}
          />
        </>
      )}
      {tab === "Inflation" && (
        <>
          <CumulativeComparison {...props} {...cumulative} />
          <MetricGrid
            print={print}
            snapshot={snapshot}
            metrics={["cpi", "coreCpi", "pce", "corePce"]}
          />
          <div className="chart-grid">
            <HistoryChart
              {...props}
              title="Consumer price inflation"
              subtitle="CPI and core CPI · NSA index, 12-month change"
              metrics={["cpi", "coreCpi"]}
            />
            <HistoryChart
              {...props}
              title="PCE price inflation"
              subtitle="12-month change · 2% line is the headline PCE goal"
              metrics={["pce", "corePce"]}
              reference={2}
            />
            <HistoryChart
              {...props}
              title="CPI: monthly movement"
              subtitle="Seasonally adjusted · change from the exact prior month"
              metrics={["cpiMom"]}
              bar
              reference={0}
            />
            <HistoryChart
              {...props}
              title="Producer prices"
              subtitle="Final demand PPI · NSA index, 12-month change"
              metrics={["ppi"]}
            />
          </div>
          <ReadingPanel snapshot={snapshot} keys={["cpi", "corePce", "ppi"]} />
        </>
      )}
      {tab === "Growth" && (
        <>
          <MetricGrid
            print={print}
            snapshot={snapshot}
            metrics={["gdp", "money", "housing", "sentiment"]}
          />
          <div className="chart-grid">
            <HistoryChart
              {...props}
              title="Real GDP growth"
              subtitle="Quarter-over-quarter · seasonally adjusted annualized rate"
              metrics={["gdp"]}
              bar
              reference={0}
            />
            <HistoryChart
              {...props}
              title="M2 money supply"
              subtitle="Seasonally adjusted level · billions converted to trillions"
              metrics={["money"]}
              unit="$T"
            />
            <HistoryChart
              {...props}
              title="Housing starts"
              subtitle="Total new privately owned units · annualized monthly pace"
              metrics={["housing"]}
              unit="M units"
            />
            <HistoryChart
              {...props}
              title="Consumer sentiment"
              subtitle="University of Michigan · public series delayed one month"
              metrics={["sentiment"]}
              unit="INDEX"
            />
          </div>
          <ReadingPanel
            snapshot={snapshot}
            keys={["gdp", "housing", "money"]}
          />
          <ResearchPanel tab="Growth" />
        </>
      )}
      {tab === "Labor" && (
        <>
          {print ? (
            <p className="cumulative-report-note">
              Cumulative hourly earnings and purchasing power appear in the
              Inflation section of this report.
            </p>
          ) : (
            <CumulativeComparison {...props} {...cumulative} />
          )}
          <MetricGrid
            print={print}
            snapshot={snapshot}
            metrics={["unemployment", "payrolls", "wages", "claims"]}
          />
          <div className="chart-grid">
            <HistoryChart
              {...props}
              title="Unemployment rate"
              subtitle="Civilian unemployment · seasonally adjusted"
              metrics={["unemployment"]}
            />
            <HistoryChart
              {...props}
              title="Monthly payroll change"
              subtitle="Nonfarm employment · exact prior-month difference"
              metrics={["payrolls"]}
              unit="K jobs"
              bar
              reference={0}
            />
            <HistoryChart
              {...props}
              title="Average hourly earnings"
              subtitle="Private payrolls · 12-month change · BLS, not a Goldman tracker"
              metrics={["wages"]}
            />
            <HistoryChart
              {...props}
              title="Initial unemployment claims"
              subtitle="Weekly claims · seasonally adjusted"
              metrics={["claims"]}
              unit="K claims"
            />
            <HistoryChart
              {...props}
              title="Job openings"
              subtitle="JOLTS · total nonfarm openings · seasonally adjusted"
              metrics={["openings"]}
              unit="M jobs"
            />
          </div>
          <ReadingPanel
            snapshot={snapshot}
            keys={["unemployment", "payrolls", "wages"]}
          />
        </>
      )}
      {tab === "Risk" && (
        <>
          <MetricGrid
            print={print}
            snapshot={snapshot}
            metrics={["vix", "conditions", "oil", "sentiment"]}
          />
          <div className="chart-grid">
            <HistoryChart
              {...props}
              title="Equity implied volatility"
              subtitle="CBOE VIX · daily closing observation, not an intraday quote"
              metrics={["vix"]}
              unit="INDEX"
            />
            <HistoryChart
              {...props}
              title="Financial conditions"
              subtitle="Chicago Fed NFCI · zero represents historical average"
              metrics={["conditions"]}
              unit="INDEX"
              reference={0}
            />
            <HistoryChart
              {...props}
              title="WTI crude oil"
              subtitle="Cushing spot price · dollars per barrel, not an ETF price"
              metrics={["oil"]}
              unit="$/BBL"
            />
            <HistoryChart
              {...props}
              title="Consumer sentiment"
              subtitle="University of Michigan · public series delayed one month"
              metrics={["sentiment"]}
              unit="INDEX"
            />
          </div>
          <ReadingPanel
            snapshot={snapshot}
            keys={["conditions", "spread10y2y", "oil"]}
          />
          <ResearchPanel tab="Risk" />
        </>
      )}
    </section>
  );
}

function DataStatus({ snapshot, checkedAt }) {
  const [expanded, setExpanded] = useState(false);
  const entries = Object.values(seriesMetadata).filter(
    (meta) => meta.enabled !== false,
  );
  const usable = entries.filter((meta) =>
    snapshot?.series?.[meta.id]?.observations?.some((p) =>
      Number.isFinite(p.value),
    ),
  ).length;
  const failed = entries.filter(
    (meta) => snapshot?.series?.[meta.id]?.status === "error",
  ).length;
  return (
    <div className="data-status">
      <button
        className="data-status-toggle"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span>
          <StatusDot
            kind={!snapshot ? "unavailable" : failed ? "stale" : "fresh"}
          />
          {usable}/{entries.length} series with observations
          {failed ? ` · ${failed} source errors` : ""}
        </span>
        <span>
          Collection attempt: {formatTimestamp(snapshot?.lastAttemptAt)}{" "}
          <b>{expanded ? "−" : "+"}</b>
        </span>
      </button>
      {expanded && (
        <div className="data-status-content">
          <p>
            <strong>Observation dates</strong> identify the period being
            measured. <strong>Retrieved</strong> identifies when the collector
            obtained a series. <strong>Browser checked</strong> is only the last
            successful read of the published JSON: {formatTimestamp(checkedAt)}.
            Source errors retain the prior validated observations. Release
            schedules and revisions vary by series.
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Series</th>
                  <th>Latest observation</th>
                  <th>Retrieved (UTC)</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((meta) => {
                  const raw = snapshot?.series?.[meta.id];
                  const latest = [...(raw?.observations || [])]
                    .reverse()
                    .find((p) => Number.isFinite(p.value));
                  const state = freshness(snapshot, meta.id, seriesMetadata);
                  return (
                    <tr key={meta.id}>
                      <td>
                        <SourceLink id={meta.id}>{meta.label} ↗</SourceLink>
                        <small>{meta.id}</small>
                      </td>
                      <td>{dateLabel(latest?.date, meta.id)}</td>
                      <td>{formatTimestamp(raw?.fetchedAt)}</td>
                      <td>
                        {raw?.status === "error"
                          ? "Error · retained if available"
                          : state.state === "stale"
                            ? "Aging observation"
                            : raw?.status || "Not published"}
                        {raw?.error && <small>{raw.error}</small>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {snapshot?.notices?.map((notice, index) => (
            <p key={index} className="notice">
              {notice}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const { snapshot, loading, error, checkedAt, refresh } = useSnapshot();
  const [tab, setTab] = useState("Overview");
  const [range, setRange] = useState("3");
  const [startMonth, setStartMonth] = useState(null);
  const [plotInterval, setPlotInterval] = useState("monthly");
  const [cumulativeView, setCumulativeView] = useState("both");
  const cumulative = {
    startMonth,
    interval: plotInterval,
    view: cumulativeView,
    onStartMonth: setStartMonth,
    onInterval: setPlotInterval,
    onView: setCumulativeView,
  };
  const [printing, setPrinting] = useState(false);
  const [orientation, setOrientation] = useState("landscape");
  const [printDialog, setPrintDialog] = useState(false);
  const dialogRef = useRef(null);
  const printButtonRef = useRef(null);
  useEffect(() => {
    function shortcut(event) {
      if (
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        /input|textarea|select/i.test(event.target.tagName) ||
        event.target.isContentEditable
      )
        return;
      const index = Number(event.key) - 1;
      if (index >= 0 && index < TABS.length) setTab(TABS[index]);
    }
    document.addEventListener("keydown", shortcut);
    const beforePrint = () => flushSync(() => setPrinting(true));
    const afterPrint = () => setPrinting(false);
    window.addEventListener("beforeprint", beforePrint);
    window.addEventListener("afterprint", afterPrint);
    return () => {
      document.removeEventListener("keydown", shortcut);
      window.removeEventListener("beforeprint", beforePrint);
      window.removeEventListener("afterprint", afterPrint);
    };
  }, []);
  useEffect(() => {
    if (printDialog) dialogRef.current?.showModal();
    else if (dialogRef.current?.open) dialogRef.current.close();
  }, [printDialog]);
  async function printReport(chosen) {
    setOrientation(chosen);
    setPrintDialog(false);
    setPrinting(true);
    await new Promise((resolve) => window.setTimeout(resolve, 400));
    window.print();
  }
  function closeDialog() {
    setPrintDialog(false);
    printButtonRef.current?.focus();
  }
  return (
    <>
      <style>{`@page { size: letter ${orientation}; margin: 12mm; }`}</style>
      <div className="app-shell screen-only">
        <header className="masthead">
          <a
            className="brand"
            href="#"
            onClick={(event) => {
              event.preventDefault();
              setTab("Overview");
            }}
            aria-label="Macro Terminal overview"
          >
            <span className="brand-icon" aria-hidden="true">
              ▥
            </span>
            <span>
              MACRO<span className="brand-light">TERMINAL</span>
              <small>ECONOMIC INTELLIGENCE / U.S.</small>
            </span>
          </a>
          <div className="header-meta">
            <span className="public-label">PUBLIC-SOURCE OBSERVATIONS</span>
            <span>
              <StatusDot kind={error ? "error" : loading ? "stale" : "fresh"} />
              {loading
                ? "CHECKING SNAPSHOT"
                : error
                  ? "CHECK FAILED"
                  : "PUBLISHED DATA"}
            </span>
          </div>
          <button
            data-testid="print-all"
            className="button print-button"
            ref={printButtonRef}
            onClick={() => setPrintDialog(true)}
          >
            ↗ Print report
          </button>
        </header>
        <div className="nav-bar">
          <nav aria-label="Dashboard sections">
            {TABS.map((name, index) => (
              <button
                data-testid={`tab-${name.toLowerCase()}`}
                key={name}
                type="button"
                className={tab === name ? "active" : ""}
                aria-current={tab === name ? "page" : undefined}
                onClick={() => setTab(name)}
              >
                <span className="tab-number">0{index + 1}</span>
                {name}
              </button>
            ))}
          </nav>
          <span className="shortcut-hint">KEYS 1–6</span>
        </div>
        <main>
          <div className="snapshot-toolbar">
            <div>
              <span className="toolbar-label">DATASET BUILT</span>
              <time dateTime={snapshot?.generatedAt || undefined}>
                {formatTimestamp(snapshot?.generatedAt)}
              </time>
            </div>
            <div className="snapshot-controls">
              <div className="range-control" aria-label="Chart history range">
                {[
                  ["1", "1Y"],
                  ["3", "3Y"],
                  ["5", "5Y"],
                  ["ALL", "ALL"],
                ].map(([value, label]) => (
                  <button
                    type="button"
                    key={value}
                    className={range === value ? "selected" : ""}
                    aria-pressed={range === value}
                    onClick={() => {
                      setRange(value);
                      setStartMonth(null);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <button
                data-testid="refresh-snapshot"
                className="button refresh-button"
                onClick={refresh}
                disabled={loading}
              >
                <span aria-hidden="true" className={loading ? "spinning" : ""}>
                  ↻
                </span>
                {loading ? "Checking…" : "Check for updates"}
              </button>
            </div>
          </div>
          <p className="refresh-note">
            Checks the published snapshot every 5 minutes. Upstream collection
            runs separately; this button does not request new releases.
            {checkedAt && (
              <>
                {" "}
                Last checked{" "}
                {formatDate(checkedAt, {
                  hour: "2-digit",
                  minute: "2-digit",
                  hour12: false,
                })}{" "}
                UTC.
              </>
            )}
          </p>
          {error && (
            <div className="alert" role="alert">
              <strong>
                {snapshot
                  ? "Refresh failed — showing the last usable snapshot."
                  : "The published dataset could not be loaded."}
              </strong>
              <span>{error}</span>
            </div>
          )}
          {!loading &&
            !error &&
            snapshot &&
            !Object.values(snapshot.series).some((series) =>
              series.observations.some((point) => Number.isFinite(point.value)),
            ) && (
              <div className="alert" role="status">
                <strong>
                  Data collection has not produced usable observations yet.
                </strong>
                <span>
                  Coverage and source status appear below. No placeholder
                  economic values are shown.
                </span>
              </div>
            )}
          <Section
            tab={tab}
            snapshot={snapshot}
            range={range}
            cumulative={cumulative}
          />
          <DataStatus snapshot={snapshot} checkedAt={checkedAt} />
        </main>
        <footer className="footer">
          <div>
            <span className="footer-brand">MACRO TERMINAL</span>
            <span>Observation → calculation → context</span>
          </div>
          <p>
            Economic releases are revised. Series update on different schedules.
            Descriptive readings use the observations shown.
          </p>
          <a
            href="https://fred.stlouisfed.org/"
            target="_blank"
            rel="noreferrer"
          >
            Explore source data ↗
          </a>
        </footer>
      </div>
      <dialog
        ref={dialogRef}
        onCancel={closeDialog}
        onClose={closeDialog}
        className="print-dialog"
      >
        <div className="eyebrow">EXPORT / ALL SIX SECTIONS</div>
        <h2>Print the macro report</h2>
        <p>
          Includes charts, observation dates, and source links. Choose a page
          orientation; your browser can save the report as PDF.
        </p>
        <div className="print-choices">
          <button className="button" onClick={() => printReport("portrait")}>
            Portrait
          </button>
          <button
            className="button primary"
            onClick={() => printReport("landscape")}
          >
            Landscape
          </button>
        </div>
        <button className="cancel-button" onClick={closeDialog}>
          Cancel
        </button>
      </dialog>
      <div
        aria-hidden={!printing}
        className="print-document"
        style={{ width: orientation === "landscape" ? "10in" : "7.5in" }}
      >
        <div className="report-heading">
          <h1>MACRO TERMINAL</h1>
          <p>
            U.S. economic monitor · dataset built{" "}
            {formatTimestamp(snapshot?.generatedAt)}
          </p>
          <p>
            Observation periods differ by indicator. History range:{" "}
            {range === "ALL" ? "all published observations" : `${range} years`}.
            Source retrieval times appear below each metric.
          </p>
          {error && <p>Snapshot check failed; retained dataset is shown.</p>}
        </div>
        {TABS.map((name) => (
          <Section
            key={name}
            tab={name}
            snapshot={snapshot}
            range={range}
            cumulative={cumulative}
            print
          />
        ))}
      </div>
    </>
  );
}
