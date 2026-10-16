#!/usr/bin/env node
/** Fetch seven years of observations and atomically update the public snapshot. */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { atomicWriteJson, collectSnapshot, readSnapshot } from "./data-lib.mjs";

const configPath = fileURLToPath(
  new URL("../config/series.json", import.meta.url),
);
const outputPath = fileURLToPath(
  new URL("../public/data/latest.json", import.meta.url),
);

try {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const previous = await readSnapshot(outputPath);
  const snapshot = await collectSnapshot(config, previous, {
    apiKey: process.env.FRED_API_KEY?.trim() || "",
    onResult: (series) =>
      console.log(
        `${series.id}: ${series.status}${series.error ? ` — ${series.error}` : ` (${series.observations.length} observations)`}`,
      ),
  });
  await atomicWriteJson(outputPath, snapshot);
  const entries = Object.values(snapshot.series);
  const ok = entries.filter((series) => series.status === "ok").length;
  const failed = entries.filter((series) => series.status === "error").length;
  console.log(
    `Saved ${ok} refreshed, ${failed} failed, ${entries.length - ok - failed} disabled series.`,
  );
  // Partial refreshes are valid deployable snapshots. Total failure signals CI
  // failure after saving honest failure metadata; old observations remain intact.
  if (ok === 0) process.exitCode = 1;
} catch (error) {
  console.error(`Data refresh stopped: ${error.message}`);
  process.exitCode = 1;
}
