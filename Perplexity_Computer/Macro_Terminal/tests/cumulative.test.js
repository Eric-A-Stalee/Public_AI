import test from "node:test";
import assert from "node:assert/strict";
import { cumulativeComparison } from "../src/cumulative.js";

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
  const result = cumulativeComparison(
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
    partial: false,
  });
  near(result.totals.prices, 21);
  near(result.totals.earnings, 44);
  near(result.totals.realEarnings, (1.44 / 1.21 - 1) * 100);
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
  const result = cumulativeComparison(raw, { range: "ALL" });
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
  assert.equal(cumulativeComparison(raw).startMonth, "2022-07");
  assert.equal(
    cumulativeComparison(raw, { range: "ALL" }).startMonth,
    "2020-01",
  );
  assert.equal(cumulativeComparison(raw, { range: "1" }).startMonth, "2025-06");
  assert.equal(
    cumulativeComparison(raw, { range: "10" }).startMonth,
    "2020-01",
  );
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
    const result = cumulativeComparison(raw, { startMonth });
    assert.ok(result.error);
    assert.equal(result.startMonth, startMonth);
    assert.equal(result.endMonth, "2024-03");
    assert.deepEqual(result.rows, []);
    assert.equal(result.totals, null);
  }
  const single = cumulativeComparison(raw, { startMonth: "2024-03" });
  assert.equal(single.rows.length, 1);
  assert.deepEqual(single.totals, { prices: 0, earnings: 0, realEarnings: 0 });
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
  const result = cumulativeComparison(raw, { range: "ALL" });
  assert.deepEqual(result.baselineMonths, ["2024-01", "2024-06"]);
  assert.equal(result.rows.length, 6);
  assert.deepEqual(result.rows[1], {
    date: "2024-02-01",
    prices: null,
    earnings: null,
    realEarnings: null,
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
  const monthly = cumulativeComparison(raw, options);
  const quarterly = cumulativeComparison(raw, {
    ...options,
    interval: "quarterly",
  });
  const yearly = cumulativeComparison(raw, { ...options, interval: "yearly" });
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
  }
});

test("completed calendar endpoints are not marked partial or duplicated", () => {
  const raw = continuous(2024, 24);
  const result = cumulativeComparison(raw, {
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
  const monthly = cumulativeComparison(raw, { range: "ALL" });
  for (const interval of ["quarterly", "yearly"]) {
    const result = cumulativeComparison(raw, { range: "ALL", interval });
    const may = result.rows.find((row) => row.date === "2024-05-01");
    const august = result.rows.find((row) => row.date === "2024-08-01");
    assert.equal(may.prices, null);
    assert.equal(may.realEarnings, null);
    assert.equal(may.partial, false);
    assert.equal(august.earnings, null);
    assert.equal(august.realEarnings, null);
    assert.equal(august.partial, false);
    assert.deepEqual(result.totals, monthly.totals);
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
    const result = cumulativeComparison(raw);
    assert.ok(result.error);
    assert.equal(result.endMonth, null);
    assert.equal(result.totals, null);
    assert.deepEqual(result.baselineMonths, []);
    assert.deepEqual(result.rows, []);
  }
});

test("duplicate monthly revisions to missing are not revived and unsupported controls report errors", () => {
  const raw = continuous(2024, 3);
  raw.series.CPIAUCSL.observations.push({ date: "2024-02-29", value: null });
  const result = cumulativeComparison(raw, { range: "ALL" });
  assert.deepEqual(result.baselineMonths, ["2024-01", "2024-03"]);
  assert.equal(result.rows[1].prices, null);
  assert.ok(cumulativeComparison(raw, { range: "bogus" }).error);
  assert.ok(cumulativeComparison(raw, { range: "0" }).error);
  assert.ok(cumulativeComparison(raw, { interval: "weekly" }).error);
});
