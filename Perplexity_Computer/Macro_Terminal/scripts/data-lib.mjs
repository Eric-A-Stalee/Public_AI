/** Shared validation and collection logic. No dependencies or browser-side secrets. */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const ID_PATTERN = /^[A-Z][A-Z0-9]{0,39}$/;
const NUMERIC_PATTERN = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
const MAX_BYTES = 6 * 1024 * 1024;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

function validTimestamp(value) {
  if (value === null) return true;
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  )
    return false;
  const parsed = new Date(value);
  const canonical = value.includes(".") ? value : value.replace("Z", ".000Z");
  return (
    Number.isFinite(parsed.getTime()) && parsed.toISOString() === canonical
  );
}

/** Last occurrence wins for a duplicate date, including explicit missing revisions. */
export function normalizeObservations(rows, { startDate, endDate } = {}) {
  if (!Array.isArray(rows) || rows.length === 0)
    throw new Error("Provider returned no observations.");
  const byDate = new Map();
  for (const row of rows) {
    if (!row || !validDate(row.date))
      throw new Error("Provider returned an invalid observation date.");
    if (endDate && row.date > endDate)
      throw new Error("Provider returned a future observation.");
    let value = row.value;
    if (value === null || value === "" || value === ".") value = null;
    else if (typeof value === "string" && NUMERIC_PATTERN.test(value.trim()))
      value = Number(value);
    else if (typeof value !== "number")
      throw new Error("Provider returned an invalid observation value.");
    if (value !== null && !Number.isFinite(value))
      throw new Error("Provider returned a non-finite observation value.");
    if (!startDate || row.date >= startDate)
      byDate.set(row.date, { date: row.date, value });
  }
  const observations = [...byDate.values()].sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  if (!observations.some((row) => row.value !== null))
    throw new Error(
      "Provider returned no usable observations in the requested window.",
    );
  return observations;
}

/** RFC-style quoted fields, including CRLF/BOM; rejects malformed CSV and HTML. */
export function parseCsvRows(text) {
  if (typeof text !== "string" || !text.trim() || text.length > MAX_BYTES)
    throw new Error("Invalid CSV payload.");
  const input = text.replace(/^\uFEFF/, "");
  const rows = [];
  let row = [],
    field = "",
    inQuotes = false,
    closedQuote = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (inQuotes) {
      if (char === '"' && input[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
        closedQuote = true;
      } else field += char;
      continue;
    }
    if (char === '"' && field === "" && !closedQuote) {
      inQuotes = true;
      continue;
    }
    if (char === "," || char === "\n" || char === "\r") {
      row.push(field);
      field = "";
      closedQuote = false;
      if (char !== ",") {
        if (row.some((cell) => cell !== "")) rows.push(row);
        row = [];
        if (char === "\r" && input[i + 1] === "\n") i += 1;
      }
    } else {
      if (closedQuote || char === '"')
        throw new Error("Malformed CSV quoting.");
      field += char;
    }
  }
  if (inQuotes) throw new Error("Unclosed CSV quoted field.");
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function parseFredCsv(text, id, options = {}) {
  const rows = parseCsvRows(text);
  const header = rows.shift();
  if (
    !header ||
    header.length !== 2 ||
    !["DATE", "observation_date"].includes(header[0]) ||
    header[1] !== id
  ) {
    throw new Error("CSV header does not match the requested FRED series.");
  }
  return normalizeObservations(
    rows.map((row) => {
      if (row.length !== 2)
        throw new Error("CSV row has an unexpected field count.");
      return { date: row[0], value: row[1] };
    }),
    options,
  );
}

export function parseFredJson(text, options = {}) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("Provider returned invalid JSON.");
  }
  if (!payload || payload.error_code || !Array.isArray(payload.observations))
    throw new Error("Provider JSON is missing observations.");
  if (payload.offset !== undefined && payload.offset !== 0)
    throw new Error("Provider returned an unexpected page offset.");
  if (
    payload.count !== undefined &&
    Number(payload.count) > payload.observations.length
  )
    throw new Error("Provider response was truncated.");
  return normalizeObservations(payload.observations, options);
}

export function validateConfig(config) {
  if (
    !config ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    Object.keys(config).length === 0
  )
    throw new Error("Expected a series configuration record.");
  for (const [id, series] of Object.entries(config)) {
    if (
      !ID_PATTERN.test(id) ||
      series.id !== id ||
      typeof series.enabled !== "boolean" ||
      !["daily", "weekly", "monthly", "quarterly"].includes(series.frequency)
    )
      throw new Error(`Invalid series configuration: ${id}`);
    if (
      !series.label ||
      !series.unit ||
      !series.source ||
      !/^https:\/\//.test(series.sourceUrl) ||
      !Number.isFinite(series.staleAfterDays) ||
      series.staleAfterDays <= 0
    )
      throw new Error(`Incomplete series metadata: ${id}`);
    if (!series.enabled && !series.reason)
      throw new Error(`Disabled series needs a reason: ${id}`);
  }
  return config;
}

/** Reject corrupted caches rather than silently replacing them with an empty file. */
export function validateSnapshot(snapshot) {
  if (
    !snapshot ||
    snapshot.schemaVersion !== 1 ||
    !snapshot.series ||
    typeof snapshot.series !== "object" ||
    Array.isArray(snapshot.series) ||
    !validTimestamp(snapshot.generatedAt) ||
    !validTimestamp(snapshot.lastAttemptAt)
  )
    throw new Error("Invalid existing data snapshot.");
  for (const [id, series] of Object.entries(snapshot.series)) {
    if (
      !ID_PATTERN.test(id) ||
      series.id !== id ||
      !Array.isArray(series.observations) ||
      !["ok", "error", "unavailable"].includes(series.status) ||
      !validTimestamp(series.fetchedAt) ||
      !validTimestamp(series.lastAttemptAt) ||
      !(series.error === null || typeof series.error === "string")
    )
      throw new Error(`Invalid cached series: ${id}`);
    let previousDate = "";
    for (const observation of series.observations) {
      if (
        !validDate(observation.date) ||
        observation.date <= previousDate ||
        !(
          observation.value === null ||
          (typeof observation.value === "number" &&
            Number.isFinite(observation.value))
        )
      )
        throw new Error(`Invalid cached observations: ${id}`);
      previousDate = observation.date;
    }
    if (
      series.status === "ok" &&
      (!series.fetchedAt ||
        !series.observations.some((row) => row.value !== null))
    )
      throw new Error(`Successful cached series has no data: ${id}`);
  }
  return snapshot;
}

export async function readSnapshot(path) {
  try {
    return validateSnapshot(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** Temp file lives beside destination so rename is atomic on the same filesystem. */
export async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx" });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

class ProviderError extends Error {
  constructor(message, retryable = false, retryAfterMs = 0) {
    super(message);
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

async function responseText(response) {
  const statedLength = Number(response.headers.get("content-length"));
  if (statedLength > MAX_BYTES)
    throw new ProviderError("Provider response exceeded the size limit.");
  if (!response.body) throw new ProviderError("Provider response was empty.");
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) {
        await reader.cancel();
        throw new ProviderError("Provider response exceeded the size limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function fetchFredSeries(
  id,
  {
    apiKey = "",
    startDate,
    endDate,
    fetchImpl = fetch,
    timeoutMs = 15_000,
    retries = 2,
    sleep = delay,
  } = {},
) {
  if (
    !ID_PATTERN.test(id) ||
    !validDate(startDate) ||
    !validDate(endDate) ||
    startDate > endDate
  )
    throw new Error("Invalid provider request configuration.");
  if (
    !Number.isInteger(retries) ||
    retries < 0 ||
    retries > 3 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 60_000
  )
    throw new Error("Invalid retry or timeout configuration.");
  const useApi = Boolean(apiKey);
  // Graph CSV is a documented export surface, not a versioned API. It permits an
  // initial no-key bootstrap. Configured API failures NEVER fall back to CSV.
  const url = new URL(
    useApi
      ? "https://api.stlouisfed.org/fred/series/observations"
      : "https://fred.stlouisfed.org/graph/fredgraph.csv",
  );
  if (useApi) {
    Object.entries({
      series_id: id,
      api_key: apiKey,
      file_type: "json",
      observation_start: startDate,
      observation_end: endDate,
      sort_order: "asc",
      units: "lin",
      limit: "100000",
      offset: "0",
    }).forEach(([key, value]) => url.searchParams.set(key, value));
  } else {
    Object.entries({ id, cosd: startDate, coed: endDate }).forEach(
      ([key, value]) => url.searchParams.set(key, value),
    );
  }
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let retryDelay = 0;
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        headers: {
          Accept: useApi ? "application/json" : "text/csv, application/csv",
        },
      });
      if (!response.ok) {
        const retryable =
          [408, 425, 429].includes(response.status) || response.status >= 500;
        const retryAfter = response.headers.get("retry-after");
        const retryAfterMs =
          retryAfter && /^\d+$/.test(retryAfter)
            ? Math.min(Number(retryAfter) * 1000, 30_000)
            : 0;
        await response.body?.cancel();
        throw new ProviderError(
          `FRED returned HTTP ${response.status}.`,
          retryable,
          retryAfterMs,
        );
      }
      const contentType = response.headers.get("content-type") || "";
      if (/html/i.test(contentType))
        throw new ProviderError("FRED returned HTML instead of observations.");
      const body = await responseText(response);
      return useApi
        ? parseFredJson(body, { startDate, endDate })
        : parseFredCsv(body, id, { startDate, endDate });
    } catch (error) {
      const retryable =
        error instanceof ProviderError
          ? error.retryable
          : controller.signal.aborted ||
            error instanceof TypeError ||
            error.name === "AbortError";
      if (!retryable || attempt === retries) {
        // Never log error.message from fetch; it can contain the API-key URL.
        if (error instanceof ProviderError) throw new Error(error.message);
        if (controller.signal.aborted)
          throw new Error("FRED request timed out.");
        if (error instanceof TypeError || error.name === "AbortError")
          throw new Error("FRED network request failed.");
        throw error;
      }
      retryDelay = Math.max(500 * 2 ** attempt, error.retryAfterMs || 0);
    } finally {
      clearTimeout(timer);
    }
    await sleep(retryDelay);
  }
}

export function backfillStart(today, years = 7) {
  if (!validDate(today) || !Number.isInteger(years) || years < 5 || years > 30)
    throw new Error("Backfill must cover 5–30 years.");
  // Beginning of month avoids leap-day subtraction and includes complete YoY lags.
  return `${Number(today.slice(0, 4)) - years}-${today.slice(5, 7)}-01`;
}

export async function collectSnapshot(
  config,
  previous = null,
  {
    apiKey = "",
    now = () => new Date(),
    years = 7,
    concurrency = 3,
    fetchSeries = fetchFredSeries,
    requestOptions = {},
    sleep = delay,
    requestSpacingMs = 250,
    onResult = () => {},
  } = {},
) {
  validateConfig(config);
  if (previous) validateSnapshot(previous);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 5)
    throw new Error("Concurrency must be between 1 and 5.");
  const attemptedAt = now().toISOString();
  const today = attemptedAt.slice(0, 10);
  const startDate = backfillStart(today, years);
  const entries = Object.entries(config);
  const results = new Map();
  let position = 0,
    successes = 0;
  const worker = async () => {
    for (;;) {
      const item = entries[position++];
      if (!item) break;
      const [id, metadata] = item;
      if (!metadata.enabled) {
        results.set(id, {
          id,
          observations: [],
          fetchedAt: null,
          lastAttemptAt: null,
          status: "unavailable",
          error: metadata.reason,
        });
        continue;
      }
      const prior = previous?.series[id];
      try {
        const observations = normalizeObservations(
          await fetchSeries(id, {
            ...requestOptions,
            apiKey,
            startDate,
            endDate: today,
          }),
          { startDate, endDate: today },
        );
        results.set(id, {
          id,
          observations,
          fetchedAt: now().toISOString(),
          lastAttemptAt: attemptedAt,
          status: "ok",
          error: null,
        });
        successes += 1;
      } catch (error) {
        const message = String(error.message || "Data refresh failed.");
        const safeMessage = apiKey
          ? message.split(apiKey).join("[redacted]")
          : message;
        results.set(id, {
          id,
          observations: prior?.observations ?? [],
          fetchedAt: prior?.fetchedAt ?? null,
          lastAttemptAt: attemptedAt,
          status: "error",
          error: safeMessage.slice(0, 300),
        });
      }
      onResult(results.get(id));
      if (requestSpacingMs > 0) await sleep(requestSpacingMs);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, entries.length) }, worker),
  );
  return {
    schemaVersion: 1,
    generatedAt: successes
      ? now().toISOString()
      : (previous?.generatedAt ?? null),
    lastAttemptAt: attemptedAt,
    series: Object.fromEntries(entries.map(([id]) => [id, results.get(id)])),
    notices: [
      apiKey
        ? "Retrieved through the FRED observations API."
        : "Bootstrap mode: retrieved from official FRED graph CSV exports without an API key. Configure FRED_API_KEY for the supported observations API; the graph export URL is not a versioned API contract.",
      "Observation dates identify the measured period, not the retrieval time. Monthly and quarterly observations are often dated at the start of their period; releases can be delayed and revised.",
      "Each successful request replaces its historical window to incorporate revisions. Failed series retain their last successful observations and retrieval timestamp.",
      "Source attribution and series-specific restrictions are recorded in config/series.json. FRED is an aggregator; original providers retain their applicable rights.",
    ],
  };
}
