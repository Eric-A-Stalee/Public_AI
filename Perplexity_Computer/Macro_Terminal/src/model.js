/** Pure data validation and calculations shared by all dashboard views. */

const DAY_MS = 24 * 60 * 60 * 1000;
const TRANSFORMS = new Set(["level", "yoy", "mom", "monthlyDelta"]);
const STATUSES = new Set(["ok", "error", "unavailable"]);

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

function validDay(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function validTimestamp(value) {
  if (value === null) return true;
  if (typeof value !== "string") return false;
  const match = value.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/,
  );
  if (
    !match ||
    !validDay(match[1]) ||
    +match[2] > 23 ||
    +match[3] > 59 ||
    +match[4] > 59
  )
    return false;
  if (
    match[5] !== "Z" &&
    (+match[5].slice(1, 3) > 23 || +match[5].slice(4, 6) > 59)
  )
    return false;
  return Number.isFinite(Date.parse(value));
}

function requireTimestamp(value, field) {
  if (!validTimestamp(value))
    throw new Error(
      `Invalid snapshot: ${field} must be an ISO timestamp or null.`,
    );
}

/**
 * Reject malformed snapshots before replacing a last-known-good UI dataset.
 * Duplicate dates use the final record, including explicit missing values.
 * Validation never converts a numeric-looking string, fills a gap, or mutates input.
 */
export function validateSnapshot(raw) {
  if (!isRecord(raw) || raw.schemaVersion !== 1 || !isRecord(raw.series)) {
    throw new Error(
      "Invalid snapshot: expected schemaVersion 1 and a series object.",
    );
  }
  requireTimestamp(raw.generatedAt, "generatedAt");
  requireTimestamp(raw.lastAttemptAt, "lastAttemptAt");
  if (
    raw.notices !== undefined &&
    (!Array.isArray(raw.notices) ||
      raw.notices.some((notice) => typeof notice !== "string"))
  ) {
    throw new Error("Invalid snapshot: notices must be an array of strings.");
  }

  const seriesEntries = Object.entries(raw.series).map(([id, series]) => {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id) ||
      !isRecord(series) ||
      series.id !== id ||
      !Array.isArray(series.observations)
    ) {
      throw new Error(`Invalid snapshot: malformed series ${id}.`);
    }
    requireTimestamp(series.fetchedAt, `${id}.fetchedAt`);
    requireTimestamp(series.lastAttemptAt, `${id}.lastAttemptAt`);
    if (
      !STATUSES.has(series.status) ||
      !(series.error === null || typeof series.error === "string")
    ) {
      throw new Error(`Invalid snapshot: malformed refresh status for ${id}.`);
    }
    const byDate = new Map();
    for (const point of series.observations) {
      if (
        !isRecord(point) ||
        !validDay(point.date) ||
        !(point.value === null || isNumber(point.value))
      ) {
        throw new Error(`Invalid snapshot: malformed observation in ${id}.`);
      }
      byDate.set(point.date, { date: point.date, value: point.value });
    }
    return [
      id,
      {
        ...series,
        observations: [...byDate.values()].sort((left, right) =>
          left.date.localeCompare(right.date),
        ),
      },
    ];
  });

  return {
    ...raw,
    series: Object.fromEntries(seriesEntries),
    notices: [...(raw.notices ?? [])],
  };
}

function getSeries(snapshot, id) {
  return snapshot?.series && Object.hasOwn(snapshot.series, id)
    ? snapshot.series[id]
    : null;
}

function observationsFor(snapshot, id) {
  return getSeries(snapshot, id)?.observations ?? [];
}

function monthKey(date, offset = 0) {
  const [year, month] = date.split("-").map(Number);
  const absoluteMonth = year * 12 + month - 1 + offset;
  const shiftedYear = Math.floor(absoluteMonth / 12);
  const shiftedMonth = absoluteMonth - shiftedYear * 12 + 1;
  return `${String(shiftedYear).padStart(4, "0")}-${String(shiftedMonth).padStart(2, "0")}`;
}

/** Transform monthly series using calendar months, never the nth available row. */
export function pointsFor(
  snapshot,
  id,
  { transform = "level", scale = 1 } = {},
) {
  if (!TRANSFORMS.has(transform))
    throw new Error(`Unsupported transform: ${transform}`);
  if (!isNumber(scale)) throw new Error("Scale must be a finite number.");
  const observations = observationsFor(snapshot, id);
  const byMonth = new Map(
    observations.map((point) => [monthKey(point.date), point]),
  );

  return observations.map((point) => {
    let value = point.value;
    if (isNumber(value) && transform !== "level") {
      const prior = byMonth.get(
        monthKey(point.date, transform === "yoy" ? -12 : -1),
      );
      if (!prior || !isNumber(prior.value)) value = null;
      else if (transform === "monthlyDelta") value -= prior.value;
      else value = prior.value === 0 ? null : (value / prior.value - 1) * 100;
    }
    value = isNumber(value) ? value * scale : null;
    return { date: point.date, value: isNumber(value) ? value : null };
  });
}

/**
 * Use the latest finite raw observation, excluding daily holiday placeholders.
 * If that observation lacks the lag required for a transform, return a null value
 * at its actual date rather than silently displaying an older calculation.
 */
export function latestReading(snapshot, id, options = {}) {
  const series = getSeries(snapshot, id);
  const observations = observationsFor(snapshot, id);
  const points = pointsFor(snapshot, id, options);
  let latestIndex = observations.length - 1;
  while (latestIndex >= 0 && !isNumber(observations[latestIndex].value))
    latestIndex -= 1;
  if (latestIndex < 0) {
    return {
      value: null,
      date: null,
      previousValue: null,
      previousDate: null,
      change: null,
      series,
    };
  }

  const current = points[latestIndex];
  const frequency = String(
    options.frequency ??
      (options.transform && options.transform !== "level" ? "monthly" : ""),
  ).toLowerCase();
  let previous;
  if (
    frequency.startsWith("month") ||
    frequency.startsWith("quarter") ||
    frequency.startsWith("annual") ||
    frequency.startsWith("year")
  ) {
    const lag = frequency.startsWith("quarter")
      ? 3
      : frequency.startsWith("annual") || frequency.startsWith("year")
        ? 12
        : 1;
    const priorMonth = monthKey(current.date, -lag);
    previous = points.findLast((point) => monthKey(point.date) === priorMonth);
  } else {
    let previousIndex = latestIndex - 1;
    while (previousIndex >= 0 && !isNumber(observations[previousIndex].value))
      previousIndex -= 1;
    previous = previousIndex >= 0 ? points[previousIndex] : undefined;
  }
  const previousValue = previous?.value ?? null;
  const delta =
    isNumber(current.value) && isNumber(previousValue)
      ? current.value - previousValue
      : null;

  return {
    value: current.value,
    date: current.date,
    previousValue,
    previousDate: previous?.date ?? null,
    change: isNumber(delta) ? delta : null,
    series,
  };
}

export const TREASURY_MATURITIES = Object.freeze(
  [
    ["DGS1MO", "1M"],
    ["DGS3MO", "3M"],
    ["DGS6MO", "6M"],
    ["DGS1", "1Y"],
    ["DGS2", "2Y"],
    ["DGS5", "5Y"],
    ["DGS7", "7Y"],
    ["DGS10", "10Y"],
    ["DGS20", "20Y"],
    ["DGS30", "30Y"],
  ].map(([id, label]) => Object.freeze({ id, label })),
);

/** A curve is one cross-section in time; no point may use a different date. */
export function yieldCurve(snapshot) {
  const maps = TREASURY_MATURITIES.map(
    ({ id }) =>
      new Map(
        observationsFor(snapshot, id)
          .filter((point) => isNumber(point.value))
          .map((point) => [point.date, point.value]),
      ),
  );
  const commonDate = [...maps[0].keys()]
    .sort()
    .reverse()
    .find((date) => maps.every((map) => map.has(date)));
  if (!commonDate)
    return {
      date: null,
      points: [],
      reason:
        "No shared observation date is available for every Treasury maturity.",
    };
  return {
    date: commonDate,
    points: TREASURY_MATURITIES.map(({ id, label }, index) => ({
      id,
      label,
      value: maps[index].get(commonDate),
    })),
    reason: null,
  };
}

export function formatValue(
  value,
  { digits = 1, prefix = "", suffix = "" } = {},
) {
  if (!isNumber(value)) return "—";
  const precision = Number.isInteger(digits)
    ? Math.min(20, Math.max(0, digits))
    : 1;
  const rounded = Number(value.toFixed(precision));
  const formatted = Math.abs(rounded).toLocaleString("en-US", {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  });
  return `${rounded < 0 ? "-" : ""}${prefix}${formatted}${suffix}`;
}

/** Observation age and retrieval errors are separate from a successful page poll. */
export function freshness(snapshot, id, metadata = {}, now = Date.now()) {
  const meta = metadata?.[id] ?? metadata ?? {};
  const reading = latestReading(snapshot, id);
  const series = reading.series;
  const currentTime =
    now instanceof Date
      ? now.getTime()
      : typeof now === "string"
        ? Date.parse(now)
        : now;
  const ageDays =
    reading.date && Number.isFinite(currentTime)
      ? Math.floor(
          (currentTime - Date.parse(`${reading.date}T00:00:00Z`)) / DAY_MS,
        )
      : null;
  const common = {
    ageDays,
    observedDate: reading.date,
    fetchedAt: series?.fetchedAt ?? null,
  };
  if (meta.enabled === false || !reading.date) {
    return {
      ...common,
      state: "unavailable",
      message:
        meta.reason ??
        series?.error ??
        "No published observations are available.",
    };
  }
  if (series.status === "error") {
    return {
      ...common,
      state: "error",
      message:
        "Latest collection failed; showing the last successfully collected observations.",
    };
  }
  if (ageDays === null || ageDays < 0 || !isNumber(meta.staleAfterDays)) {
    return {
      ...common,
      state: "unknown",
      message: "Observation freshness could not be determined.",
    };
  }
  if (ageDays > meta.staleAfterDays) {
    return {
      ...common,
      state: "stale",
      message: `Latest observation is ${ageDays} days old, beyond the ${meta.staleAfterDays}-day freshness threshold.`,
    };
  }
  return {
    ...common,
    state: "fresh",
    message: `Latest observation is dated ${reading.date}, within this series’ freshness threshold.`,
  };
}

const indicator = (
  id,
  label,
  unit,
  suffix,
  digits,
  transform,
  scale,
  description,
) =>
  Object.freeze({
    id,
    label,
    unit,
    suffix,
    digits,
    transform,
    scale,
    description,
  });

export const INDICATORS = Object.freeze({
  policy: indicator(
    "DFEDTARU",
    "Fed target ceiling",
    "%",
    "%",
    2,
    "level",
    1,
    "Upper bound of the federal funds target range.",
  ),
  cpi: indicator(
    "CPIAUCNS",
    "Headline CPI",
    "% YoY",
    "%",
    1,
    "yoy",
    1,
    "Consumer prices, all items, not seasonally adjusted; change from the same calendar month one year earlier.",
  ),
  coreCpi: indicator(
    "CPILFENS",
    "Core CPI",
    "% YoY",
    "%",
    1,
    "yoy",
    1,
    "Consumer prices excluding food and energy, not seasonally adjusted; year-over-year change.",
  ),
  corePce: indicator(
    "PCEPILFE",
    "Core PCE",
    "% YoY",
    "%",
    1,
    "yoy",
    1,
    "Personal consumption expenditure prices excluding food and energy; year-over-year change.",
  ),
  pce: indicator(
    "PCEPI",
    "Headline PCE",
    "% YoY",
    "%",
    1,
    "yoy",
    1,
    "Personal consumption expenditure price index; year-over-year change.",
  ),
  cpiMom: indicator(
    "CPIAUCSL",
    "CPI monthly change",
    "% MoM",
    "%",
    1,
    "mom",
    1,
    "Seasonally adjusted consumer price index; change from the previous calendar month.",
  ),
  ppi: indicator(
    "PPIFID",
    "Final-demand PPI",
    "% YoY",
    "%",
    1,
    "yoy",
    1,
    "Producer price index for final demand, not seasonally adjusted; year-over-year change.",
  ),
  gdp: indicator(
    "A191RL1Q225SBEA",
    "Real GDP growth",
    "% SAAR",
    "%",
    1,
    "level",
    1,
    "Real GDP change from the preceding quarter at a seasonally adjusted annual rate, as published by BEA.",
  ),
  money: indicator(
    "M2SL",
    "M2 money supply",
    "USD trillions",
    "T",
    2,
    "level",
    0.001,
    "Seasonally adjusted M2 money stock, converted from billions to trillions of dollars.",
  ),
  housing: indicator(
    "HOUST",
    "Housing starts",
    "millions SAAR",
    "M",
    2,
    "level",
    0.001,
    "New privately owned housing starts, seasonally adjusted annual rate, in millions of units.",
  ),
  unemployment: indicator(
    "UNRATE",
    "Unemployment rate",
    "%",
    "%",
    1,
    "level",
    1,
    "Civilian unemployment rate, seasonally adjusted.",
  ),
  payrolls: indicator(
    "PAYEMS",
    "Nonfarm payroll change",
    "thousand jobs MoM",
    "K",
    0,
    "monthlyDelta",
    1,
    "Change in seasonally adjusted nonfarm payroll employment from the previous calendar month, in thousands.",
  ),
  wages: indicator(
    "CES0500000003",
    "Hourly earnings growth",
    "% YoY",
    "%",
    1,
    "yoy",
    1,
    "Average hourly earnings of all private nonfarm employees; year-over-year change.",
  ),
  claims: indicator(
    "ICSA",
    "Initial jobless claims",
    "thousand claims",
    "K",
    0,
    "level",
    0.001,
    "Seasonally adjusted weekly initial unemployment insurance claims, in thousands.",
  ),
  openings: indicator(
    "JTSJOL",
    "Job openings",
    "million openings",
    "M",
    2,
    "level",
    0.001,
    "Seasonally adjusted total nonfarm job openings, converted from thousands to millions.",
  ),
  vix: indicator(
    "VIXCLS",
    "VIX",
    "index",
    "",
    2,
    "level",
    1,
    "Cboe volatility index daily close; an index of option-implied equity volatility.",
  ),
  sentiment: indicator(
    "UMCSENT",
    "Consumer sentiment",
    "index",
    "",
    1,
    "level",
    1,
    "University of Michigan consumer sentiment index. FRED availability can lag the initial release.",
  ),
  conditions: indicator(
    "NFCI",
    "Financial conditions",
    "index",
    "",
    2,
    "level",
    1,
    "Chicago Fed National Financial Conditions Index; positive values indicate tighter-than-average conditions.",
  ),
  oil: indicator(
    "DCOILWTICO",
    "WTI crude oil",
    "USD per barrel",
    "",
    2,
    "level",
    1,
    "West Texas Intermediate crude oil spot price in dollars per barrel.",
  ),
  spread10y2y: indicator(
    "T10Y2Y",
    "10Y − 2Y spread",
    "percentage points",
    " pp",
    2,
    "level",
    1,
    "Ten-year minus two-year Treasury constant maturity yield, in percentage points.",
  ),
  spread10y3m: indicator(
    "T10Y3M",
    "10Y − 3M spread",
    "percentage points",
    " pp",
    2,
    "level",
    1,
    "Ten-year minus three-month Treasury constant maturity yield, in percentage points.",
  ),
  mortgage: indicator(
    "MORTGAGE30US",
    "30-year mortgage",
    "%",
    "%",
    2,
    "level",
    1,
    "Freddie Mac average 30-year fixed mortgage rate in the United States.",
  ),
  treasury10y: indicator(
    "DGS10",
    "10-year Treasury",
    "%",
    "%",
    2,
    "level",
    1,
    "Daily market yield on ten-year Treasury securities at constant maturity.",
  ),
  treasury2y: indicator(
    "DGS2",
    "2-year Treasury",
    "%",
    "%",
    2,
    "level",
    1,
    "Daily market yield on two-year Treasury securities at constant maturity.",
  ),
});
