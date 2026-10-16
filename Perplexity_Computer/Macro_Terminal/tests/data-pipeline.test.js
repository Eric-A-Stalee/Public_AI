import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  atomicWriteJson,
  backfillStart,
  collectSnapshot,
  fetchFredSeries,
  normalizeObservations,
  parseFredCsv,
  parseFredJson,
  readSnapshot,
  validDate,
  validateSnapshot,
} from "../scripts/data-lib.mjs";

const attempted = "2026-10-16T02:00:00.000Z";
const priorTime = "2026-10-15T02:00:00.000Z";
const clock = () => new Date(attempted);
const metadata = (id, extra = {}) => ({
  id,
  label: id,
  unit: "percent",
  frequency: "monthly",
  staleAfterDays: 75,
  source: "FRED test fixture",
  sourceUrl: `https://fred.stlouisfed.org/series/${id}`,
  enabled: true,
  ...extra,
});
const oldSeries = (id) => ({
  id,
  observations: [
    { date: "2026-08-01", value: 4.2 },
    { date: "2026-09-01", value: 4.1 },
  ],
  fetchedAt: priorTime,
  lastAttemptAt: priorTime,
  status: "ok",
  error: null,
});
const previous = () => ({
  schemaVersion: 1,
  generatedAt: priorTime,
  lastAttemptAt: priorTime,
  series: { UNRATE: oldSeries("UNRATE"), PAYEMS: oldSeries("PAYEMS") },
});
const noDelay = { now: clock, requestSpacingMs: 0, sleep: async () => {} };

// Parser tests focus on provider edge cases that can corrupt economic indicators.
test("FRED CSV handles BOM, quoted fields, CRLF, gaps and out-of-order revisions", () => {
  const result = parseFredCsv(
    '\uFEFF"observation_date","UNRATE"\r\n2026-09-01,4.1\r\n2026-07-01,.\r\n2026-08-01,4.3\r\n2026-08-01,4.2\r\n2026-10-01,\r\n',
    "UNRATE",
  );
  assert.deepEqual(result, [
    { date: "2026-07-01", value: null },
    { date: "2026-08-01", value: 4.2 },
    { date: "2026-09-01", value: 4.1 },
    { date: "2026-10-01", value: null },
  ]);
});

test("a revised missing observation remains null rather than a stale number", () => {
  assert.deepEqual(
    normalizeObservations([
      { date: "2026-08-01", value: 4 },
      { date: "2026-09-01", value: 4.2 },
      { date: "2026-09-01", value: "." },
    ]),
    [
      { date: "2026-08-01", value: 4 },
      { date: "2026-09-01", value: null },
    ],
  );
});

test("invalid dates, wrong series, HTML, empty and malformed numeric payloads reject", () => {
  for (const payload of [
    "observation_date,WRONG\n2026-09-01,4.2",
    "<html>Temporarily unavailable</html>",
    "observation_date,UNRATE\n2026-02-30,4.2",
    "observation_date,UNRATE\n2026-09-01,NaN",
    "observation_date,UNRATE\n2026-09-01,Infinity",
    "observation_date,UNRATE\n2026-09-01,0x22",
    "observation_date,UNRATE\n2026-09-01,4.2oops",
    "observation_date,UNRATE\n2026-09-01,4.2,5",
    'observation_date,UNRATE\n2026-09-01,"4.2',
    'observation_date,UNRATE\n2026-09-01,"4.2"oops',
    "observation_date,UNRATE\n2026-09-01,.",
    "observation_date,UNRATE",
  ])
    assert.throws(() => parseFredCsv(payload, "UNRATE"));
});

test("date-window validation rejects future data and keeps complete historical window", () => {
  assert.equal(validDate("2024-02-29"), true);
  assert.equal(validDate("2025-02-29"), false);
  assert.equal(validDate("2026-9-1"), false);
  assert.equal(backfillStart("2024-02-29"), "2017-02-01");
  assert.throws(() => backfillStart("2026-10-16", 1));
  const rows = [
    { date: "2018-01-01", value: 1 },
    { date: "2026-09-01", value: 4.2 },
  ];
  assert.deepEqual(
    normalizeObservations(rows, {
      startDate: "2019-10-01",
      endDate: "2026-10-16",
    }),
    [rows[1]],
  );
  assert.throws(
    () =>
      normalizeObservations([{ date: "2026-11-01", value: 4 }], {
        endDate: "2026-10-16",
      }),
    /future/,
  );
});

test("API JSON rejects errors, truncated pages and non-numeric values", () => {
  assert.deepEqual(
    parseFredJson(
      JSON.stringify({
        count: 2,
        offset: 0,
        observations: [
          { date: "2026-08-01", value: "4.2" },
          { date: "2026-09-01", value: "." },
        ],
      }),
    ),
    [
      { date: "2026-08-01", value: 4.2 },
      { date: "2026-09-01", value: null },
    ],
  );
  for (const payload of [
    "{bad json",
    JSON.stringify({ error_code: 400, error_message: "Bad key" }),
    JSON.stringify({
      count: 3,
      observations: [{ date: "2026-09-01", value: "4.2" }],
    }),
    JSON.stringify({
      offset: 1,
      observations: [{ date: "2026-09-01", value: "4.2" }],
    }),
    JSON.stringify({ observations: [{ date: "2026-09-01", value: false }] }),
  ])
    assert.throws(() => parseFredJson(payload));
});

test("partial failure preserves previous observations and fetch timestamp, replaces revised success", async () => {
  const old = previous();
  const before = structuredClone(old);
  const config = {
    UNRATE: metadata("UNRATE"),
    PAYEMS: metadata("PAYEMS"),
    ICSA: metadata("ICSA"),
  };
  const snapshot = await collectSnapshot(config, old, {
    ...noDelay,
    fetchSeries: async (id) => {
      if (id === "UNRATE")
        return [
          { date: "2026-08-01", value: 4.4 },
          { date: "2026-09-01", value: null },
        ];
      throw new Error("FRED returned HTTP 503.");
    },
  });
  assert.equal(snapshot.generatedAt, attempted);
  assert.equal(snapshot.lastAttemptAt, attempted);
  assert.equal(snapshot.series.UNRATE.status, "ok");
  assert.equal(snapshot.series.UNRATE.fetchedAt, attempted);
  assert.deepEqual(snapshot.series.UNRATE.observations, [
    { date: "2026-08-01", value: 4.4 },
    { date: "2026-09-01", value: null },
  ]);
  assert.equal(snapshot.series.PAYEMS.status, "error");
  assert.equal(snapshot.series.PAYEMS.fetchedAt, priorTime);
  assert.equal(snapshot.series.PAYEMS.lastAttemptAt, attempted);
  assert.deepEqual(
    snapshot.series.PAYEMS.observations,
    old.series.PAYEMS.observations,
  );
  assert.deepEqual(snapshot.series.ICSA.observations, []);
  assert.equal(snapshot.series.ICSA.fetchedAt, null);
  assert.deepEqual(
    old,
    before,
    "Collection must not mutate the previous snapshot",
  );
});

test("all failures do not advance generatedAt; first run failures have no fake snapshot date", async () => {
  const config = { UNRATE: metadata("UNRATE") };
  const options = {
    ...noDelay,
    fetchSeries: async () => {
      throw new Error("FRED request timed out.");
    },
  };
  assert.equal(
    (await collectSnapshot(config, previous(), options)).generatedAt,
    priorTime,
  );
  const snapshot = await collectSnapshot(config, null, options);
  assert.equal(snapshot.generatedAt, null);
  assert.equal(snapshot.lastAttemptAt, attempted);
});

test("restricted series are unavailable, never fetched, and contain no observations", async () => {
  const snapshot = await collectSnapshot(
    {
      BAMLH0A0HYM2: metadata("BAMLH0A0HYM2", {
        enabled: false,
        reason: "Requires redistribution license.",
      }),
    },
    null,
    {
      ...noDelay,
      fetchSeries: () => assert.fail("Disabled source must not be requested"),
    },
  );
  assert.deepEqual(snapshot.series.BAMLH0A0HYM2, {
    id: "BAMLH0A0HYM2",
    observations: [],
    fetchedAt: null,
    lastAttemptAt: null,
    status: "unavailable",
    error: "Requires redistribution license.",
  });
});

test("API authentication errors do not fall back to CSV and never expose the secret", async () => {
  const seen = [];
  await assert.rejects(
    fetchFredSeries("UNRATE", {
      apiKey: "TEST_SECRET_DO_NOT_PRINT",
      startDate: "2019-01-01",
      endDate: "2026-10-16",
      retries: 2,
      fetchImpl: async (url) => {
        seen.push(url);
        return new Response("Invalid key", { status: 400 });
      },
      sleep: async () => assert.fail("HTTP 400 is not retryable"),
    }),
    /FRED returned HTTP 400/,
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].hostname, "api.stlouisfed.org");
  const snapshot = await collectSnapshot({ UNRATE: metadata("UNRATE") }, null, {
    ...noDelay,
    apiKey: "TEST_SECRET_DO_NOT_PRINT",
    fetchSeries: async () => {
      throw new Error("Failure TEST_SECRET_DO_NOT_PRINT");
    },
  });
  assert.equal(
    JSON.stringify(snapshot).includes("TEST_SECRET_DO_NOT_PRINT"),
    false,
  );
});

test("retryable provider failure has bounded retries then parses a valid response", async () => {
  let attempts = 0;
  const waits = [];
  const result = await fetchFredSeries("UNRATE", {
    startDate: "2019-01-01",
    endDate: "2026-10-16",
    retries: 2,
    fetchImpl: async () =>
      ++attempts < 3
        ? new Response("", { status: 429, headers: { "retry-after": "120" } })
        : new Response("observation_date,UNRATE\n2026-09-01,4.2", {
            headers: { "content-type": "application/csv" },
          }),
    sleep: async (ms) => waits.push(ms),
  });
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [30_000, 30_000]);
  assert.deepEqual(result, [{ date: "2026-09-01", value: 4.2 }]);
});

test("worker concurrency stays within its configured budget", async () => {
  let active = 0,
    maximum = 0;
  const ids = ["UNRATE", "PAYEMS", "ICSA", "M2SL", "PCEPI"];
  await collectSnapshot(
    Object.fromEntries(ids.map((id) => [id, metadata(id)])),
    null,
    {
      ...noDelay,
      concurrency: 2,
      fetchSeries: async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 3));
        active -= 1;
        return [{ date: "2026-09-01", value: 1 }];
      },
    },
  );
  assert.equal(maximum, 2);
});

test("a hung request is aborted at the timeout and does not leak its URL", async () => {
  let aborted = false;
  await assert.rejects(
    fetchFredSeries("UNRATE", {
      apiKey: "TEST_SECRET_DO_NOT_PRINT",
      startDate: "2019-01-01",
      endDate: "2026-10-16",
      retries: 0,
      timeoutMs: 5,
      fetchImpl: async (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        }),
    }),
    /FRED request timed out\./,
  );
  assert.equal(aborted, true);
});

test("atomic snapshot write roundtrips and leaves no temporary files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "macro-terminal-"));
  const path = join(directory, "latest.json");
  try {
    assert.equal(await readSnapshot(path), null);
    await atomicWriteJson(path, previous());
    assert.deepEqual(await readSnapshot(path), previous());
    assert.deepEqual(await readdir(directory), ["latest.json"]);
    assert.equal(JSON.parse(await readFile(path, "utf8")).schemaVersion, 1);
    assert.throws(() => validateSnapshot({ ...previous(), schemaVersion: 0 }));
    assert.throws(() =>
      validateSnapshot({
        ...previous(),
        generatedAt: "2026-02-30T00:00:00.000Z",
      }),
    );
    assert.throws(() =>
      validateSnapshot({
        ...previous(),
        series: {
          UNRATE: {
            ...oldSeries("UNRATE"),
            observations: [{ date: "2026-09-01", value: "4.2" }],
          },
        },
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
