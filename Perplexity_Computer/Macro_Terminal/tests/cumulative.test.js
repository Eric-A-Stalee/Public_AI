import test from "node:test";
import assert from "node:assert/strict";
import { compoundIndex, cumulativeComparison } from "../src/cumulative.js";

const averageComparison = (raw, options = {}) =>
  cumulativeComparison(raw, { earningsBasis: "average", ...options });

const points = (values) =>
  values.map(([date, value]) => ({
    date: date.length === 7 ? `${date}-01` : date,
    value,
  }));
const snapshot = (prices, earnings) => ({
  series: {
    CPIAUCSL: { observations: points(prices) },
    CES0500000003: { observations: points(earnings) },
  },
});
const near = (actual, expected) => {
  assert.equal(typeof actual, "number");
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
};

function continuous(startYear = 2024, count = 26) {
  const prices = [],
    earnings = [];
  for (let i = 0; i < count; i += 1) {
    const month = `${startYear + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
    prices.push([month, 100 * 1.01 ** i]);
    earnings.push([month, 20 * 1.015 ** i]);
  }
  return snapshot(prices, earnings);
}

test("cumulative levels compound and real earnings use the exact ratio, not subtraction", () => {
  const result = averageComparison(
    snapshot(
      [
        ["2024-01", 100],
        ["2024-02", 110],
        ["2024-03", 121],
      ],
      [
        ["2024-01", 100],
        ["2024-02", 120],
        ["2024-03", 144],
      ],
    ),
    { startMonth: "2024-01" },
  );
  assert.equal(result.error, null);
  assert.deepEqual(result.rows[0], {
    date: "2024-01-01",
    prices: 0,
    earnings: 0,
    realEarnings: 0,
    indices: { prices: 100, earnings: 100, realEarnings: 100 },
    partial: false,
  });
  near(result.totals.prices, 21);
  near(result.totals.earnings, 44);
  near(result.totals.realEarnings, (1.44 / 1.21 - 1) * 100);
  near(result.indexTotals.realEarnings, (1.44 / 1.21) * 100);
  assert.notEqual(result.totals.realEarnings, 44 - 21);
});

test("normalizes observation dates by month and ends at the latest shared usable month", () => {
  const raw = snapshot(
    [
      ["2024-03-31", 121],
      ["2024-01-10", 100],
      ["2024-02-29", 110],
      ["2024-04", 130],
    ],
    [
      ["2024-01-31", 20],
      ["2024-02-01", 21],
      ["2024-03-05", 22],
      ["2024-04", null],
      ["2024-05", 24],
    ],
  );
  const before = structuredClone(raw);
  const result = averageComparison(raw, { range: "ALL" });
  assert.deepEqual(result.baselineMonths, ["2024-01", "2024-02", "2024-03"]);
  assert.equal(result.startMonth, "2024-01");
  assert.equal(result.endMonth, "2024-03");
  assert.equal(result.rows.at(-1).date, "2024-03-01");
  near(result.totals.earnings, 10);
  assert.deepEqual(raw, before);
});

test("automatic range uses the first shared month on or after the calendar cutoff", () => {
  const raw = snapshot(
    [
      ["2020-01", 80],
      ["2022-06", 90],
      ["2022-07", 92],
      ["2023-07", 95],
      ["2025-06", 100],
    ],
    [
      ["2020-01", 16],
      ["2022-06", null],
      ["2022-07", 18],
      ["2023-07", 19],
      ["2025-06", 20],
    ],
  );
  assert.equal(averageComparison(raw).startMonth, "2022-07");
  assert.equal(averageComparison(raw, { range: "ALL" }).startMonth, "2020-01");
  assert.equal(averageComparison(raw, { range: "1" }).startMonth, "2025-06");
  assert.equal(averageComparison(raw, { range: "10" }).startMonth, "2020-01");
});

test("unavailable or invalid explicit baselines return errors rather than silently rebasing", () => {
  const raw = snapshot(
    [
      ["2024-01", 100],
      ["2024-02", 105],
      ["2024-03", 110],
    ],
    [
      ["2024-01", 20],
      ["2024-02", null],
      ["2024-03", 22],
    ],
  );
  for (const startMonth of [
    "2024-02",
    "2023-12",
    "2024-04",
    "2024-13",
    "2024-01-01",
    "",
  ]) {
    const result = averageComparison(raw, { startMonth });
    assert.ok(result.error);
    assert.equal(result.startMonth, startMonth);
    assert.equal(result.endMonth, "2024-03");
    assert.deepEqual(result.rows, []);
    assert.equal(result.totals, null);
    assert.equal(result.indexTotals, null);
  }
  const single = averageComparison(raw, { startMonth: "2024-03" });
  assert.equal(single.rows.length, 1);
  assert.deepEqual(single.totals, { prices: 0, earnings: 0, realEarnings: 0 });
  assert.deepEqual(single.indexTotals, {
    prices: 100,
    earnings: 100,
    realEarnings: 100,
  });
});

test("internal absent months, nulls and nonpositive levels remain gaps with no division by zero", () => {
  const raw = snapshot(
    [
      ["2024-01", 100],
      ["2024-03", 0],
      ["2024-04", 104],
      ["2024-05", -1],
      ["2024-06", 110],
    ],
    [
      ["2024-01", 20],
      ["2024-03", 21],
      ["2024-04", null],
      ["2024-05", 0],
      ["2024-06", 22],
    ],
  );
  const result = averageComparison(raw, { range: "ALL" });
  assert.deepEqual(result.baselineMonths, ["2024-01", "2024-06"]);
  assert.equal(result.rows.length, 6);
  assert.deepEqual(result.rows[1], {
    date: "2024-02-01",
    prices: null,
    earnings: null,
    realEarnings: null,
    indices: { prices: null, earnings: null, realEarnings: null },
    partial: false,
  });
  assert.equal(result.rows[2].prices, null);
  near(result.rows[2].earnings, 5);
  assert.equal(result.rows[2].realEarnings, null);
  near(result.rows[3].prices, 4);
  assert.equal(result.rows[3].earnings, null);
  assert.equal(result.rows[3].realEarnings, null);
  assert.equal(result.rows[4].prices, null);
  assert.equal(result.rows[4].earnings, null);
  assert.ok(
    result.rows.every((row) =>
      [row.prices, row.earnings, row.realEarnings].every(
        (value) => value === null || Number.isFinite(value),
      ),
    ),
  );
});

test("quarterly and yearly sampling preserve baseline and partial latest endpoint without changing totals", () => {
  const raw = continuous();
  const options = { startMonth: "2024-02" };
  const monthly = averageComparison(raw, options);
  const quarterly = averageComparison(raw, {
    ...options,
    interval: "quarterly",
  });
  const yearly = averageComparison(raw, { ...options, interval: "yearly" });
  assert.equal(monthly.endMonth, "2026-02");
  assert.ok(monthly.rows.every((row) => row.partial === false));
  assert.deepEqual(
    quarterly.rows.map((row) => row.date),
    [
      "2024-02-01",
      "2024-03-01",
      "2024-06-01",
      "2024-09-01",
      "2024-12-01",
      "2025-03-01",
      "2025-06-01",
      "2025-09-01",
      "2025-12-01",
      "2026-02-01",
    ],
  );
  assert.deepEqual(
    yearly.rows.map((row) => row.date),
    ["2024-02-01", "2024-12-01", "2025-12-01", "2026-02-01"],
  );
  for (const comparison of [quarterly, yearly]) {
    assert.equal(comparison.rows[0].partial, true);
    assert.equal(comparison.rows.at(-1).partial, true);
    assert.ok(
      comparison.rows.slice(1, -1).every((row) => row.partial === false),
    );
    assert.deepEqual(comparison.totals, monthly.totals);
    assert.deepEqual(comparison.indexTotals, monthly.indexTotals);
  }
});

test("completed calendar endpoints are not marked partial or duplicated", () => {
  const raw = continuous(2024, 24);
  const result = averageComparison(raw, {
    startMonth: "2024-12",
    interval: "yearly",
  });
  assert.deepEqual(
    result.rows.map((row) => [row.date, row.partial]),
    [
      ["2024-12-01", false],
      ["2025-12-01", false],
    ],
  );
});

test("downsampling retains off-cycle missing-month markers so charts cannot bridge gaps", () => {
  const raw = continuous(2024, 12);
  raw.series.CPIAUCSL.observations = raw.series.CPIAUCSL.observations.filter(
    (row) => row.date !== "2024-05-01",
  );
  raw.series.CES0500000003.observations.find(
    (row) => row.date === "2024-08-01",
  ).value = null;
  const monthly = averageComparison(raw, { range: "ALL" });
  for (const interval of ["quarterly", "yearly"]) {
    const result = averageComparison(raw, { range: "ALL", interval });
    const may = result.rows.find((row) => row.date === "2024-05-01");
    const august = result.rows.find((row) => row.date === "2024-08-01");
    assert.equal(may.prices, null);
    assert.equal(may.realEarnings, null);
    assert.equal(may.partial, false);
    assert.equal(august.earnings, null);
    assert.equal(august.realEarnings, null);
    assert.equal(august.partial, false);
    assert.deepEqual(result.totals, monthly.totals);
    assert.deepEqual(result.indexTotals, monthly.indexTotals);
  }
});

test("missing sources and wholly invalid levels return an honest unavailable result", () => {
  for (const raw of [
    null,
    {},
    snapshot([], []),
    snapshot([["2024-01", 0]], [["2024-01", 20]]),
    snapshot([["2024-01", 100]], [["2024-01", Infinity]]),
    snapshot([["2024-01", "100"]], [["2024-01", 20]]),
    snapshot([["2024-02-30", 100]], [["2024-02", 20]]),
  ]) {
    const result = averageComparison(raw);
    assert.ok(result.error);
    assert.equal(result.endMonth, null);
    assert.equal(result.totals, null);
    assert.equal(result.indexTotals, null);
    assert.deepEqual(result.baselineMonths, []);
    assert.deepEqual(result.rows, []);
  }
});

test("duplicate monthly revisions to missing are not revived and unsupported controls report errors", () => {
  const raw = continuous(2024, 3);
  raw.series.CPIAUCSL.observations.push({ date: "2024-02-29", value: null });
  const result = averageComparison(raw, { range: "ALL" });
  assert.deepEqual(result.baselineMonths, ["2024-01", "2024-03"]);
  assert.equal(result.rows[1].prices, null);
  assert.ok(averageComparison(raw, { range: "bogus" }).error);
  assert.ok(averageComparison(raw, { range: "0" }).error);
  assert.ok(averageComparison(raw, { interval: "weekly" }).error);
});

test("the explicit +3%, +2%, +9% chain is 100 → 103 → 105.06 → 114.5154", () => {
  const indices = [100];
  for (const change of [3, 2, 9])
    indices.push(compoundIndex(indices.at(-1), change));
  [100, 103, 105.06, 114.5154].forEach((expected, index) =>
    near(indices[index], expected),
  );
  assert.notEqual(indices.at(-1), 114);
  assert.notEqual(
    indices.at(-1),
    114.52,
    "Intermediate or final values must not be rounded",
  );
});

test("raw source levels are explicitly chained into their own base-100 indices", () => {
  const result = averageComparison(
    snapshot(
      [
        ["2024-01", 200],
        ["2024-02", 206],
        ["2024-03", 210.12],
        ["2024-04", 229.0308],
      ],
      [
        ["2024-01", 50],
        ["2024-02", 51.5],
        ["2024-03", 52.53],
        ["2024-04", 57.2577],
      ],
    ),
    { range: "ALL" },
  );
  [100, 103, 105.06, 114.5154].forEach((expected, index) => {
    near(result.rows[index].indices.prices, expected);
    near(result.rows[index].indices.earnings, expected);
    near(result.rows[index].indices.realEarnings, 100);
  });
  near(result.indexTotals.prices, 114.5154);
  near(result.totals.prices, 14.5154);
  for (const row of result.rows) {
    for (const key of ["prices", "earnings", "realEarnings"])
      assert.equal(row[key], row.indices[key] - 100);
  }
});

test("negative growth compounds declines and subsequent recoveries", () => {
  near(compoundIndex(100, -10), 90);
  near(compoundIndex(90, 5), 94.5);
  const result = averageComparison(
    snapshot(
      [
        ["2024-01", 200],
        ["2024-02", 180],
        ["2024-03", 189],
      ],
      [
        ["2024-01", 100],
        ["2024-02", 95],
        ["2024-03", 104.5],
      ],
    ),
    { range: "ALL" },
  );
  near(result.indexTotals.prices, 94.5);
  near(result.totals.prices, -5.5);
  near(result.indexTotals.earnings, 104.5);
  near(result.indexTotals.realEarnings, (100 * (104.5 / 100)) / (189 / 200));
  near(result.rows[1].indices.realEarnings, (100 * 0.95) / 0.9);
});

test("indices resume across missing months from each last valid anchor and remain ratio-equivalent", () => {
  const raw = snapshot(
    [
      ["2024-01", 100],
      ["2024-02", null],
      ["2024-03", 121],
      ["2024-04", 133.1],
      ["2024-05", 151.25],
    ],
    [
      ["2024-01", 20],
      ["2024-02", 22],
      ["2024-03", null],
      ["2024-04", 24.2],
      ["2024-05", 26.62],
    ],
  );
  const result = averageComparison(raw, { range: "ALL" });
  assert.equal(result.rows[1].indices.prices, null);
  assert.equal(result.rows[1].prices, null);
  assert.equal(result.rows[1].indices.realEarnings, null);
  assert.equal(result.rows[2].indices.earnings, null);
  assert.equal(result.rows[2].earnings, null);
  assert.equal(result.rows[2].indices.realEarnings, null);
  near(result.rows[2].indices.prices, 121);
  near(result.rows[3].indices.earnings, 121);
  near(
    result.rows[3].indices.realEarnings,
    (100 * (24.2 / 20)) / (133.1 / 100),
  );
  near(result.indexTotals.prices, 151.25);
  near(result.indexTotals.earnings, 133.1);
  near(result.indexTotals.realEarnings, 88);
  for (const interval of ["quarterly", "yearly"]) {
    const sampled = averageComparison(raw, { range: "ALL", interval });
    assert.deepEqual(sampled.indexTotals, result.indexTotals);
    assert.deepEqual(sampled.totals, result.totals);
    assert.deepEqual(
      sampled.rows.find((row) => row.date === "2024-02-01").indices,
      result.rows[1].indices,
    );
    assert.deepEqual(
      sampled.rows.find((row) => row.date === "2024-03-01").indices,
      result.rows[2].indices,
    );
  }
});

test("compoundIndex rejects non-finite or nonnumeric operands and overflow", () => {
  for (const invalid of [null, undefined, "3", NaN, Infinity, -Infinity]) {
    assert.equal(compoundIndex(invalid, 3), null);
    assert.equal(compoundIndex(100, invalid), null);
  }
  assert.equal(compoundIndex(Number.MAX_VALUE, 100), null);
  assert.equal(compoundIndex(100, 0), 100);
  assert.equal(compoundIndex(100, -100), 0);
});

const medianSnapshot = (prices, earnings) => ({
  series: {
    CPIAUCSL: { observations: points(prices) },
    LES1252881500Q: { observations: points(earnings) },
  },
});

function quarterlyFixture(startYear = 2023, count = 10) {
  const prices = [],
    earnings = [];
  for (let i = 0; i < count; i += 1) {
    const year = startYear + Math.floor(i / 4);
    const first = (i % 4) * 3 + 1;
    const month = (value) => `${year}-${String(value).padStart(2, "0")}`;
    // The quarter-end CPI is deliberately different from its quarterly mean.
    const level = 100 * 1.02 ** i;
    prices.push(
      [month(first), level - 10],
      [month(first + 1), level],
      [month(first + 2), level + 10],
    );
    earnings.push([month(first), 1000 * 1.03 ** i]);
  }
  return medianSnapshot(prices, earnings);
}

test("median defaults to quarterly data and aligns three-month CPI averages, not quarter-start or end values", () => {
  const raw = medianSnapshot(
    [
      ["2024-01", 90],
      ["2024-02", 100],
      ["2024-03", 110],
      ["2024-04", 110],
      ["2024-05", 125],
      ["2024-06", 140],
    ],
    [
      ["2024-01", 1000],
      ["2024-04", 1300],
    ],
  );
  const before = structuredClone(raw);
  const result = cumulativeComparison(raw);
  assert.equal(result.error, null);
  assert.equal(result.earningsBasis, "median");
  assert.equal(result.earningsSeries, "LES1252881500Q");
  assert.equal(result.frequency, "quarterly");
  assert.equal(result.interval, "quarterly");
  assert.deepEqual(result.baselineMonths, ["2024-01", "2024-04"]);
  assert.deepEqual(
    result.rows.map(({ date }) => date),
    ["2024-01-01", "2024-04-01"],
  );
  assert.ok(result.rows.every(({ partial }) => !partial));
  assert.deepEqual(result.rows[0].indices, {
    prices: 100,
    earnings: 100,
    realEarnings: 100,
  });
  near(result.indexTotals.prices, 125);
  near(result.indexTotals.earnings, 130);
  near(result.indexTotals.realEarnings, 104);
  near(result.totals.realEarnings, 4);
  assert.deepEqual(raw, before);
});

test("median explicitly compounds the requested +3%, +2%, +9% earnings chain without intermediate rounding", () => {
  const raw = quarterlyFixture(2024, 4);
  [1000, 1030, 1050.6, 1145.154].forEach((value, index) => {
    raw.series.LES1252881500Q.observations[index].value = value;
  });
  const result = cumulativeComparison(raw, { range: "ALL" });
  [100, 103, 105.06, 114.5154].forEach((expected, index) =>
    near(result.rows[index].indices.earnings, expected),
  );
  near(result.indexTotals.earnings, 114.5154);
  near(result.totals.earnings, 14.5154);
  near(result.indexTotals.realEarnings, 114.5154 / 1.02 ** 3);
});

test("incomplete CPI quarters and unpublished median quarters cannot become a shared endpoint or baseline", () => {
  const raw = quarterlyFixture(2024, 4);
  raw.series.CPIAUCSL.observations.pop(); // Missing December, despite Q4 earnings.
  raw.series.LES1252881500Q.observations[2].value = null; // Q3 unreported.
  const result = cumulativeComparison(raw, { range: "ALL" });
  assert.equal(result.endMonth, "2024-04");
  assert.deepEqual(result.baselineMonths, ["2024-01", "2024-04"]);
  assert.equal(result.rows.length, 2);
  for (const startMonth of ["2024-02", "2024-07", "2024-10"]) {
    const invalid = cumulativeComparison(raw, { startMonth });
    assert.match(invalid.error, /baseline quarter/);
    assert.equal(invalid.startMonth, startMonth);
    assert.equal(invalid.indexTotals, null);
  }
});

test("missing quarterly CPI or earnings remains a gap and subsequent indices resume the full span", () => {
  const raw = quarterlyFixture(2024, 6);
  raw.series.CPIAUCSL.observations.find(
    ({ date }) => date === "2024-05-01",
  ).value = null;
  raw.series.LES1252881500Q.observations.find(
    ({ date }) => date === "2024-07-01",
  ).value = null;
  const quarterly = cumulativeComparison(raw, { range: "ALL" });
  assert.equal(quarterly.rows[1].prices, null);
  near(quarterly.rows[1].indices.earnings, 103);
  assert.equal(quarterly.rows[1].realEarnings, null);
  assert.equal(quarterly.rows[2].earnings, null);
  near(quarterly.rows[2].indices.prices, 104.04);
  assert.equal(quarterly.rows[2].realEarnings, null);
  near(quarterly.rows[3].indices.realEarnings, 100 * (1.03 / 1.02) ** 3);
  near(quarterly.indexTotals.earnings, 100 * 1.03 ** 5);
  const yearly = cumulativeComparison(raw, {
    range: "ALL",
    interval: "yearly",
  });
  for (const date of ["2024-04-01", "2024-07-01"]) {
    assert.deepEqual(
      yearly.rows.find((row) => row.date === date),
      quarterly.rows.find((row) => row.date === date),
    );
  }
  assert.deepEqual(yearly.indexTotals, quarterly.indexTotals);
});

test("median yearly sampling uses Q4 and retains baseline and latest complete quarter without inventing annual medians", () => {
  const raw = quarterlyFixture();
  const quarterly = cumulativeComparison(raw, { startMonth: "2023-04" });
  const yearly = cumulativeComparison(raw, {
    startMonth: "2023-04",
    interval: "yearly",
  });
  assert.deepEqual(
    yearly.rows.map(({ date, partial }) => [date, partial]),
    [
      ["2023-04-01", true],
      ["2023-10-01", false],
      ["2024-10-01", false],
      ["2025-04-01", true],
    ],
  );
  assert.deepEqual(yearly.totals, quarterly.totals);
  assert.deepEqual(yearly.indexTotals, quarterly.indexTotals);
  const completed = cumulativeComparison(quarterlyFixture(2024, 4), {
    range: "ALL",
    interval: "yearly",
  });
  assert.equal(completed.rows.at(-1).partial, false);
});

test("median automatic ranges and a single shared quarter retain an honest base of 100", () => {
  const raw = quarterlyFixture();
  assert.equal(cumulativeComparison(raw, { range: "1" }).startMonth, "2024-04");
  assert.equal(
    cumulativeComparison(raw, { range: "ALL" }).startMonth,
    "2023-01",
  );
  const single = cumulativeComparison(raw, { startMonth: "2025-04" });
  assert.equal(single.rows.length, 1);
  assert.deepEqual(single.indexTotals, {
    prices: 100,
    earnings: 100,
    realEarnings: 100,
  });
  assert.deepEqual(single.totals, { prices: 0, earnings: 0, realEarnings: 0 });
});

test("median rejects synthetic monthly views, unknown measures and unavailable data without falling back to the average", () => {
  const raw = quarterlyFixture();
  assert.match(
    cumulativeComparison(raw, { interval: "monthly" }).error,
    /published quarterly/,
  );
  assert.match(
    cumulativeComparison(raw, { earningsBasis: "invalid" }).error,
    /Choose median/,
  );
  assert.match(cumulativeComparison(continuous()).error, /No shared quarter/);
  const missing = cumulativeComparison({
    series: { LES1252881500Q: raw.series.LES1252881500Q },
  });
  assert.equal(missing.endMonth, null);
  assert.equal(missing.totals, null);
  assert.deepEqual(missing.rows, []);
});

test("quarterly observations keep missing revisions and ignore off-cycle records", () => {
  const raw = quarterlyFixture(2024, 4);
  raw.series.LES1252881500Q.observations.push(
    { date: "2024-04-01", value: null },
    { date: "2024-05-01", value: 9999 },
  );
  raw.series.CPIAUCSL.observations.push({ date: "2024-08-01", value: null });
  const result = cumulativeComparison(raw, { range: "ALL" });
  assert.deepEqual(result.baselineMonths, ["2024-01", "2024-10"]);
  assert.equal(result.rows[1].earnings, null);
  assert.equal(result.rows[2].prices, null);
  near(result.indexTotals.earnings, 100 * 1.03 ** 3);
});
