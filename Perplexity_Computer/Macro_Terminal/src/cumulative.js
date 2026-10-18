/** Base-100 chained indices derived from aligned monthly or quarterly levels. */
const PRICE_SERIES = "CPIAUCSL";
const EARNINGS_SERIES = {
  median: "LES1252881500Q",
  average: "CES0500000003",
};
const INTERVALS = new Set(["monthly", "quarterly", "yearly"]);
const positive = (value) =>
  typeof value === "number" && Number.isFinite(value) && value > 0;
const finiteOrNull = (value) => (Number.isFinite(value) ? value : null);

/** Apply one non-overlapping period change, preserving full numeric precision. */
export function compoundIndex(previousIndex, periodPercent) {
  if (
    typeof previousIndex !== "number" ||
    !Number.isFinite(previousIndex) ||
    typeof periodPercent !== "number" ||
    !Number.isFinite(periodPercent)
  )
    return null;
  return finiteOrNull(previousIndex * (1 + periodPercent / 100));
}

function chainFrom(initialLevel) {
  let previousLevel = initialLevel;
  let previousIndex = 100;
  return (level) => {
    if (!positive(level) || !positive(previousLevel)) return null;
    const periodPercent = (level / previousLevel - 1) * 100;
    const next = compoundIndex(previousIndex, periodPercent);
    if (next !== null) {
      previousLevel = level;
      previousIndex = next;
    }
    // A missing period never advances the anchor. The next observation applies
    // its total change since the last known level, without inventing gap rates.
    return next;
  };
}

function monthOf(date) {
  if (typeof date !== "string") return null;
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(date)) return date;
  if (!/^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === date
    ? date.slice(0, 7)
    : null;
}

function monthlyLevels(snapshot, id) {
  const observations = snapshot?.series?.[id]?.observations;
  const levels = new Map();
  if (!Array.isArray(observations)) return levels;
  // Final record wins for duplicate months, including a revision to missing.
  for (const observation of observations) {
    const month = monthOf(observation?.date);
    if (month !== null)
      levels.set(month, positive(observation.value) ? observation.value : null);
  }
  return levels;
}

function monthNumber(month) {
  return Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
}

function monthFromNumber(value) {
  const year = Math.floor(value / 12);
  return `${String(year).padStart(4, "0")}-${String((value % 12) + 1).padStart(2, "0")}`;
}

function quarterStart(month) {
  const number = monthNumber(month);
  return monthFromNumber(number - (number % 3));
}

function quarterlyPrices(monthly) {
  const quarters = new Map();
  for (const month of monthly.keys()) {
    const quarter = quarterStart(month);
    if (quarters.has(quarter)) continue;
    const first = monthNumber(quarter);
    const values = [0, 1, 2].map((offset) =>
      monthly.get(monthFromNumber(first + offset)),
    );
    // Never calculate a quarter from fewer than three usable monthly levels.
    quarters.set(
      quarter,
      values.every(positive)
        ? finiteOrNull(values.reduce((total, value) => total + value / 3, 0))
        : null,
    );
  }
  return quarters;
}

function isIntervalEnd(month, interval, frequency) {
  const number = Number(month.slice(5, 7));
  if (frequency === "quarterly")
    return interval === "quarterly" || number === 10;
  return (
    interval === "monthly" ||
    (interval === "quarterly" ? number % 3 === 0 : number === 12)
  );
}

/**
 * Compare CPI and nominal earnings from a shared baseline.
 * Median weekly earnings use native quarterly observations and complete-quarter
 * CPI averages. Average hourly earnings retain native monthly observations.
 * Gaps are never carried forward, interpolated, or treated as zero growth.
 * `partial` marks a retained baseline/final endpoint outside a quarter/year end;
 * additional missing-period markers do not describe completed reporting intervals.
 */
export function cumulativeComparison(
  snapshot,
  {
    earningsBasis = "median",
    startMonth = null,
    range = "3",
    interval = earningsBasis === "median" ? "quarterly" : "monthly",
  } = {},
) {
  const median = earningsBasis === "median";
  const frequency = median ? "quarterly" : "monthly";
  const periodName = median ? "quarter" : "month";
  const earningsSeries = Object.hasOwn(EARNINGS_SERIES, earningsBasis)
    ? EARNINGS_SERIES[earningsBasis]
    : null;
  const rawPrices = monthlyLevels(snapshot, PRICE_SERIES);
  const prices = median ? quarterlyPrices(rawPrices) : rawPrices;
  const rawEarnings = monthlyLevels(snapshot, earningsSeries);
  // FRED quarterly observation dates identify the quarter's first month. Do
  // not reinterpret off-cycle source records as new quarterly observations.
  const earnings = median
    ? new Map(
        [...rawEarnings].filter(([month]) => month === quarterStart(month)),
      )
    : rawEarnings;
  const baselineMonths = [...prices.keys()]
    .filter(
      (month) => positive(prices.get(month)) && positive(earnings.get(month)),
    )
    .sort();
  const endMonth = baselineMonths.at(-1) ?? null;
  const result = {
    earningsBasis,
    earningsSeries,
    frequency,
    interval,
    baselineMonths,
    startMonth: typeof startMonth === "string" ? startMonth : null,
    endMonth,
    rows: [],
    totals: null,
    indexTotals: null,
    error: null,
  };
  const fail = (error) => ({ ...result, error });

  if (!earningsSeries)
    return fail("Choose median weekly earnings or average hourly earnings.");
  if (!INTERVALS.has(interval))
    return fail("Choose a monthly, quarterly, or yearly comparison interval.");
  if (median && interval === "monthly")
    return fail(
      "Median weekly earnings are published quarterly. Choose a quarterly or yearly interval.",
    );
  if (!endMonth)
    return fail(
      median
        ? "No shared quarter has median earnings and all three monthly CPI observations."
        : "No shared month has usable CPI and earnings observations.",
    );

  if (startMonth !== null) {
    if (
      typeof startMonth !== "string" ||
      !/^\d{4}-\d{2}$/.test(startMonth) ||
      !baselineMonths.includes(startMonth)
    )
      return fail(
        `The selected baseline ${periodName} does not have usable CPI and earnings observations.`,
      );
  } else if (String(range).toUpperCase() === "ALL") {
    startMonth = baselineMonths[0];
  } else {
    const years = Number(range);
    if (!Number.isInteger(years) || years < 1)
      return fail("Choose a positive whole-year history range or ALL.");
    const threshold = monthNumber(endMonth) - years * 12;
    startMonth = baselineMonths.find(
      (month) => monthNumber(month) >= threshold,
    );
  }

  const initialPrice = prices.get(startMonth);
  const initialEarnings = earnings.get(startMonth);
  const chainPrices = chainFrom(initialPrice);
  const chainEarnings = chainFrom(initialEarnings);
  const chainRealEarnings = chainFrom(initialEarnings / initialPrice);
  const periods = [];
  for (
    let index = monthNumber(startMonth);
    index <= monthNumber(endMonth);
    index += median ? 3 : 1
  ) {
    const month = monthFromNumber(index);
    const price = prices.get(month);
    const wage = earnings.get(month);
    const indices = {
      prices: chainPrices(price),
      earnings: chainEarnings(wage),
      realEarnings: chainRealEarnings(
        positive(price) && positive(wage) ? wage / price : null,
      ),
    };
    const endpoint = month === startMonth || month === endMonth;
    periods.push({
      date: `${month}-01`,
      indices,
      prices: indices.prices === null ? null : indices.prices - 100,
      earnings: indices.earnings === null ? null : indices.earnings - 100,
      realEarnings:
        indices.realEarnings === null ? null : indices.realEarnings - 100,
      partial: endpoint && !isIntervalEnd(month, interval, frequency),
    });
  }

  // Preserve every missing period as a null marker even when calendar sampling
  // would omit it. Charts with connectNulls=false cannot bridge those gaps.
  const rows = periods.filter(
    (row, index) =>
      index === 0 ||
      index === periods.length - 1 ||
      isIntervalEnd(row.date.slice(0, 7), interval, frequency) ||
      row.prices === null ||
      row.earnings === null ||
      row.realEarnings === null,
  );
  const last = periods.at(-1);
  return {
    ...result,
    startMonth,
    rows,
    totals: {
      prices: last.prices,
      earnings: last.earnings,
      realEarnings: last.realEarnings,
    },
    indexTotals: { ...last.indices },
  };
}
