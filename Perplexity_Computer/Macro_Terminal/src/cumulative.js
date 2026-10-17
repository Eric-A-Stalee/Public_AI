/** Base-100 chained indices and percentage changes derived from raw monthly levels. */
const PRICE_SERIES = "CPIAUCSL";
const EARNINGS_SERIES = "CES0500000003";
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
    // A missing month never advances the anchor. The next observation applies
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

function isIntervalEnd(month, interval) {
  const number = Number(month.slice(5, 7));
  return (
    interval === "monthly" ||
    (interval === "quarterly" ? number % 3 === 0 : number === 12)
  );
}

/**
 * Compare CPI and nominal average hourly earnings from a shared baseline.
 * Gaps are never carried forward, interpolated, or treated as zero growth.
 * `partial` marks a retained baseline/final endpoint outside a quarter/year end;
 * additional missing-month markers do not describe completed reporting intervals.
 */
export function cumulativeComparison(
  snapshot,
  { startMonth = null, range = "3", interval = "monthly" } = {},
) {
  const prices = monthlyLevels(snapshot, PRICE_SERIES);
  const earnings = monthlyLevels(snapshot, EARNINGS_SERIES);
  const baselineMonths = [...prices.keys()]
    .filter(
      (month) => positive(prices.get(month)) && positive(earnings.get(month)),
    )
    .sort();
  const endMonth = baselineMonths.at(-1) ?? null;
  const result = {
    baselineMonths,
    startMonth: typeof startMonth === "string" ? startMonth : null,
    endMonth,
    rows: [],
    totals: null,
    indexTotals: null,
    error: null,
  };
  const fail = (error) => ({ ...result, error });

  if (!INTERVALS.has(interval))
    return fail("Choose a monthly, quarterly, or yearly comparison interval.");
  if (!endMonth)
    return fail("No shared month has usable CPI and earnings observations.");

  if (startMonth !== null) {
    if (
      typeof startMonth !== "string" ||
      !/^\d{4}-\d{2}$/.test(startMonth) ||
      !baselineMonths.includes(startMonth)
    )
      return fail(
        "The selected baseline month does not have usable CPI and earnings observations.",
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
  const monthly = [];
  for (
    let index = monthNumber(startMonth);
    index <= monthNumber(endMonth);
    index += 1
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
    monthly.push({
      date: `${month}-01`,
      indices,
      prices: indices.prices === null ? null : indices.prices - 100,
      earnings: indices.earnings === null ? null : indices.earnings - 100,
      realEarnings:
        indices.realEarnings === null ? null : indices.realEarnings - 100,
      partial: endpoint && !isIntervalEnd(month, interval),
    });
  }

  // Preserve every missing month as a null marker even when calendar sampling
  // would omit it. Charts with connectNulls=false cannot bridge those gaps.
  const rows = monthly.filter(
    (row, index) =>
      index === 0 ||
      index === monthly.length - 1 ||
      isIntervalEnd(row.date.slice(0, 7), interval) ||
      row.prices === null ||
      row.earnings === null ||
      row.realEarnings === null,
  );
  const last = monthly.at(-1);
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
