import test from "node:test";
import assert from "node:assert/strict";
import {
  validateSnapshot,
  pointsFor,
  latestReading,
  yieldCurve,
  TREASURY_MATURITIES,
  formatValue,
  freshness,
  INDICATORS,
} from "../src/model.js";

const timestamp = "2026-10-15T20:30:00.000Z";
const point = (date, value) => ({ date, value });
const series = (id, observations, overrides = {}) => ({
  id,
  observations,
  fetchedAt: timestamp,
  lastAttemptAt: timestamp,
  status: "ok",
  error: null,
  ...overrides,
});
const snapshot = (observations) => ({
  schemaVersion: 1,
  generatedAt: timestamp,
  lastAttemptAt: timestamp,
  series: { TEST: series("TEST", observations) },
  notices: [],
});
const near = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test("validation sorts and deduplicates without mutating or filling explicit null gaps", () => {
  const raw = snapshot([
    point("2026-03-01", 3),
    point("2026-01-01", 1),
    point("2026-02-01", 2),
    point("2026-02-01", null),
  ]);
  const original = structuredClone(raw);
  const result = validateSnapshot(raw);
  assert.deepEqual(result.series.TEST.observations, [
    point("2026-01-01", 1),
    point("2026-02-01", null),
    point("2026-03-01", 3),
  ]);
  assert.deepEqual(raw, original);
  assert.notEqual(result.series.TEST, raw.series.TEST);
});

test("validation rejects malformed dates, values, status, and envelope", () => {
  for (const badPoint of [
    point("2026-02-30", 1),
    point("2025-02-29", 1),
    point("2026-1-01", 1),
    point("2026-01-01", "1.2"),
    point("2026-01-01", NaN),
    point("2026-01-01", Infinity),
    point("2026-01-01", undefined),
    null,
  ])
    assert.throws(
      () => validateSnapshot(snapshot([badPoint])),
      /Invalid snapshot/,
    );
  for (const malformed of [
    null,
    [],
    {},
    { ...snapshot([]), schemaVersion: 2 },
    { ...snapshot([]), generatedAt: "2026-02-30T00:00:00Z" },
    { ...snapshot([]), lastAttemptAt: "yesterday" },
    { ...snapshot([]), generatedAt: "2026-10-15T25:00:00Z" },
    { ...snapshot([]), notices: [1] },
    { ...snapshot([]), series: { TEST: series("OTHER", []) } },
    {
      ...snapshot([]),
      series: { TEST: series("TEST", [], { status: "success" }) },
    },
  ])
    assert.throws(() => validateSnapshot(malformed), /Invalid snapshot/);
  assert.doesNotThrow(() =>
    validateSnapshot(snapshot([point("2024-02-29", 0)])),
  );
  assert.doesNotThrow(() =>
    validateSnapshot({
      ...snapshot([]),
      generatedAt: null,
      lastAttemptAt: null,
    }),
  );
});

test("year-over-year calculations use the same calendar month despite missing intervening rows", () => {
  const data = snapshot([
    point("2024-12-01", 100),
    point("2025-01-01", 200),
    point("2025-12-01", 110),
    point("2026-01-01", 220),
    point("2026-02-01", 230),
  ]);
  const values = pointsFor(data, "TEST", { transform: "yoy" });
  assert.equal(values[0].value, null);
  near(values[2].value, 10);
  near(values[3].value, 10);
  assert.equal(values[4].value, null);
});

test("monthly transforms require the preceding month, preserve nulls, and handle zero bases", () => {
  const data = snapshot([
    point("2025-12-01", 100),
    point("2026-01-01", 110),
    point("2026-03-01", 120),
    point("2026-04-01", null),
    point("2026-05-01", 0),
    point("2026-06-01", 10),
  ]);
  const mom = pointsFor(data, "TEST", { transform: "mom" });
  near(mom[1].value, 10);
  assert.equal(mom[2].value, null);
  assert.equal(mom[3].value, null);
  assert.equal(mom[4].value, null);
  assert.equal(mom[5].value, null);
  const delta = pointsFor(data, "TEST", {
    transform: "monthlyDelta",
    scale: 0.001,
  });
  near(delta[1].value, 0.01);
  assert.equal(delta[2].value, null);
  near(delta[5].value, 0.01);
});

test("monthly comparison matches calendar months even when observation days differ", () => {
  const data = snapshot([point("2025-12-31", 200), point("2026-01-01", 220)]);
  near(pointsFor(data, "TEST", { transform: "mom" })[1].value, 10);
});

test("invalid transforms/scales fail explicitly and overflowing calculations never emit Infinity", () => {
  const data = snapshot([
    point("2025-12-01", 1),
    point("2026-01-01", Number.MAX_VALUE),
  ]);
  assert.throws(
    () => pointsFor(data, "TEST", { transform: "guess" }),
    /Unsupported transform/,
  );
  assert.throws(
    () => pointsFor(data, "TEST", { scale: Infinity }),
    /finite number/,
  );
  assert.equal(pointsFor(data, "TEST", { scale: 100 })[1].value, null);
  assert.equal(pointsFor(data, "TEST", { transform: "mom" })[1].value, null);
});

test("latest transformed headline does not silently fall back when its required lag is missing", () => {
  const data = snapshot([
    point("2025-01-01", 100),
    point("2026-01-01", 105),
    point("2026-02-01", 106),
  ]);
  const reading = latestReading(data, "TEST", {
    transform: "yoy",
    frequency: "Monthly",
  });
  assert.equal(reading.date, "2026-02-01");
  assert.equal(reading.value, null);
  near(reading.previousValue, 5);
  assert.equal(reading.change, null);
});

test("monthly comparisons do not skip a missing previous month or an explicit null", () => {
  for (const observations of [
    [point("2026-01-01", 100), point("2026-03-01", 120)],
    [
      point("2026-01-01", 100),
      point("2026-02-01", null),
      point("2026-03-01", 120),
    ],
  ]) {
    const reading = latestReading(snapshot(observations), "TEST", {
      frequency: "Monthly",
    });
    assert.equal(reading.value, 120);
    assert.equal(reading.previousValue, null);
    assert.equal(reading.change, null);
  }
});

test("daily holiday placeholders do not erase current readings or select a noncomparable null", () => {
  const reading = latestReading(
    snapshot([
      point("2026-10-08", 4),
      point("2026-10-09", null),
      point("2026-10-12", 4.2),
      point("2026-10-13", null),
    ]),
    "TEST",
    { frequency: "Daily" },
  );
  assert.equal(reading.date, "2026-10-12");
  assert.equal(reading.value, 4.2);
  assert.equal(reading.previousDate, "2026-10-08");
  near(reading.change, 0.2);
});

test("quarterly comparisons require the preceding quarter", () => {
  const reading = latestReading(
    snapshot([
      point("2025-10-01", 1),
      point("2026-04-01", 2),
      point("2026-07-01", 3),
    ]),
    "TEST",
    { frequency: "Quarterly" },
  );
  assert.equal(reading.previousDate, "2026-04-01");
  assert.equal(reading.change, 1);
  const gap = latestReading(
    snapshot([point("2025-10-01", 1), point("2026-04-01", 2)]),
    "TEST",
    { frequency: "quarterly" },
  );
  assert.equal(gap.previousValue, null);
});

test("Treasury curve selects one common observation date across every maturity", () => {
  const data = snapshot([]);
  data.series = Object.fromEntries(
    TREASURY_MATURITIES.map(({ id }, index) => [
      id,
      series(id, [
        point("2026-10-13", 3 + index / 10),
        point("2026-10-14", index === 3 ? null : 4 + index / 10),
      ]),
    ]),
  );
  const curve = yieldCurve(data);
  assert.equal(curve.date, "2026-10-13");
  assert.equal(curve.points.length, TREASURY_MATURITIES.length);
  curve.points.forEach((reading, index) => near(reading.value, 3 + index / 10));
  delete data.series.DGS10;
  assert.deepEqual(yieldCurve(data).points, []);
  assert.equal(yieldCurve(data).date, null);
});

test("unavailable values remain unavailable; formatters retain real zero and handle sign/currency", () => {
  assert.equal(formatValue(null), "—");
  assert.equal(formatValue(Infinity), "—");
  assert.equal(formatValue("12"), "—");
  assert.equal(formatValue(0, { suffix: "%" }), "0.0%");
  assert.equal(formatValue(-0.00001, { digits: 2 }), "0.00");
  assert.equal(formatValue(-1234.56, { prefix: "$", digits: 2 }), "-$1,234.56");
  assert.equal(latestReading(null, "TEST").value, null);
  assert.deepEqual(pointsFor(null, "TEST"), []);
});

test("freshness uses observation dates and retains upstream failure state despite recent UI polls", () => {
  const data = snapshot([point("2026-09-01", 100)]);
  const now = new Date("2026-10-15T22:00:00Z");
  assert.equal(
    freshness(data, "TEST", { staleAfterDays: 60 }, now).state,
    "fresh",
  );
  assert.equal(
    freshness(data, "TEST", { staleAfterDays: 30 }, now).state,
    "stale",
  );
  assert.equal(
    freshness(data, "TEST", { staleAfterDays: 60 }, now).ageDays,
    44,
  );
  data.series.TEST.status = "error";
  assert.equal(
    freshness(data, "TEST", { staleAfterDays: 60 }, now).state,
    "error",
  );
  assert.equal(
    freshness(data, "TEST", { enabled: false, reason: "Restricted feed." }, now)
      .message,
    "Restricted feed.",
  );
  assert.equal(freshness(snapshot([]), "TEST", {}, now).state, "unavailable");
});

test("indicator definitions use correct series and transformations for headline metrics", () => {
  assert.equal(INDICATORS.cpi.id, "CPIAUCNS");
  assert.equal(INDICATORS.cpi.transform, "yoy");
  assert.equal(INDICATORS.cpiMom.id, "CPIAUCSL");
  assert.equal(INDICATORS.ppi.id, "PPIFID");
  assert.equal(INDICATORS.payrolls.transform, "monthlyDelta");
  assert.equal(INDICATORS.gdp.transform, "level");
  assert.equal(INDICATORS.claims.scale, 0.001);
});
