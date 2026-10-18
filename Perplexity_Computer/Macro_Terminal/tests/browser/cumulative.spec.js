import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const published = JSON.parse(
  readFileSync(
    new URL("../../public/data/latest.json", import.meta.url),
    "utf8",
  ),
);

/**
 * Known levels make the distinction between nominal and real growth observable:
 * Jan 2024 → Jul 2025: prices +25%, earnings +30%, real earnings +4%.
 * Jan 2025 → Jul 2025: prices +4.17%, earnings +4%, real earnings −0.16%.
 */
function cumulativeSnapshot() {
  const snapshot = structuredClone(published);
  const observations = { CPIAUCSL: [], CES0500000003: [] };
  for (let month = 0; month <= 18; month += 1) {
    const date = new Date(Date.UTC(2024, month, 1)).toISOString().slice(0, 10);
    const prices =
      month <= 12 ? 100 + (20 * month) / 12 : 120 + (5 * (month - 12)) / 6;
    const earnings =
      month <= 12 ? 20 + (5 * month) / 12 : 25 + (month - 12) / 6;
    observations.CPIAUCSL.push({ date, value: prices });
    observations.CES0500000003.push({ date, value: earnings });
  }
  for (const id of Object.keys(observations)) {
    snapshot.series[id] = {
      ...snapshot.series[id],
      id,
      observations: observations[id],
      fetchedAt: "2025-08-15T12:00:00Z",
      lastAttemptAt: "2025-08-15T12:00:00Z",
      status: "ok",
      error: null,
    };
  }
  return snapshot;
}

/**
 * Q1 2024 → Q2 2025: quarterly mean CPI 100 → 125; median weekly pay
 * $1,000 → $1,300. Unequal monthly CPI observations distinguish the quarterly
 * mean from either the first or final month, so the expected real gain is 4%.
 */
function medianSnapshot() {
  const snapshot = cumulativeSnapshot();
  const prices = [];
  const earnings = [];
  const quarterlyEarnings = [1000, 1080, 1120, 1160, 1250, 1300];
  for (let quarter = 0; quarter < quarterlyEarnings.length; quarter += 1) {
    const mean = 100 + quarter * 5;
    const date = new Date(Date.UTC(2024, quarter * 3, 1))
      .toISOString()
      .slice(0, 10);
    earnings.push({ date, value: quarterlyEarnings[quarter] });
    for (let month = 0; month < 3; month += 1) {
      prices.push({
        date: new Date(Date.UTC(2024, quarter * 3 + month, 1))
          .toISOString()
          .slice(0, 10),
        value: mean + (month - 1) * 20,
      });
    }
  }
  for (const [id, observations] of Object.entries({
    CPIAUCSL: prices,
    LES1252881500Q: earnings,
  })) {
    snapshot.series[id] = {
      ...snapshot.series[id],
      id,
      observations,
      fetchedAt: "2025-08-15T12:00:00Z",
      lastAttemptAt: "2025-08-15T12:00:00Z",
      status: "ok",
      error: null,
    };
  }
  return snapshot;
}

function screenPanel(page) {
  return page.locator(".screen-only").getByTestId("cumulative-comparison");
}

function intervalGroup(panel) {
  return panel.getByRole("group", { name: "Cumulative plotting interval" });
}

function seriesGroup(panel) {
  return panel.getByRole("group", { name: "Cumulative chart series" });
}

async function openInflation(page, getSnapshot = () => cumulativeSnapshot()) {
  await page.route("**/data/latest.json", (route) =>
    route.fulfill({ json: getSnapshot() }),
  );
  await page.goto("./");
  await expect(page.getByTestId("refresh-snapshot")).toBeEnabled();
  await page.getByTestId("tab-inflation").click();
  await expect(screenPanel(page)).toBeVisible();
}

async function selectAverageEarnings(page) {
  await screenPanel(page)
    .getByRole("combobox", { name: "Earnings measure", exact: true })
    .selectOption("average");
}

async function expectTotals(panel, prices, earnings, real) {
  // Check the numeric readings rather than requiring a particular plus-sign style.
  await expect(panel.getByTestId("cumulative-total-prices")).toContainText(
    prices,
  );
  await expect(panel.getByTestId("cumulative-total-earnings")).toContainText(
    earnings,
  );
  await expect(
    panel.getByTestId("cumulative-total-realEarnings"),
  ).toContainText(real);
}

test("cumulative plotting intervals preserve the full-period totals and series can be inspected separately", async ({
  page,
}) => {
  await openInflation(page);
  await selectAverageEarnings(page);
  const panel = screenPanel(page);
  await expect(
    panel.getByRole("combobox", { name: "Starting month", exact: true }),
  ).toHaveValue("");
  await expectTotals(panel, "25.00%", "30.00%", "4.00%");
  await expect(panel.getByTestId("cumulative-index-prices")).toContainText(
    "125.00",
  );
  await expect(panel.getByTestId("cumulative-index-earnings")).toContainText(
    "130.00",
  );
  await expect(
    panel.getByTestId("cumulative-index-realEarnings"),
  ).toContainText("104.00");
  await expect(
    panel.getByTestId("cumulative-nominal-chart").locator(".recharts-line"),
  ).toHaveCount(2);
  await expect(
    panel.getByTestId("cumulative-real-chart").locator(".recharts-line"),
  ).toHaveCount(1);

  for (const interval of ["Quarterly", "Yearly", "Monthly"]) {
    const button = intervalGroup(panel).getByRole("button", {
      name: interval,
      exact: true,
    });
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
    // Jul 2025 is a partial quarter/year; interval sampling must keep its endpoint.
    await expectTotals(panel, "25.00%", "30.00%", "4.00%");
    if (interval === "Yearly") {
      const methodology = panel.locator(".cumulative-method");
      await methodology.locator("summary").click();
      const baseline = methodology
        .getByRole("row")
        .filter({ hasText: "Jan 2024 · start" });
      await expect(baseline.locator("td")).toHaveText([
        "Jan 2024 · start",
        "100.00",
        "100.00",
        "100.00",
      ]);
      await panel
        .getByRole("group", { name: "Cumulative value scale" })
        .getByRole("button", { name: "% change", exact: true })
        .click();
      await expect(baseline.locator("td")).toHaveText([
        "Jan 2024 · start",
        "0.00%",
        "0.00%",
        "0.00%",
      ]);
      await expectTotals(panel, "25.00%", "30.00%", "4.00%");
      await panel
        .getByRole("group", { name: "Cumulative value scale" })
        .getByRole("button", { name: "Index (100)", exact: true })
        .click();
      await methodology.locator("summary").click();
    }
  }

  for (const series of ["Inflation", "Hourly earnings"]) {
    const button = seriesGroup(panel).getByRole("button", {
      name: series,
      exact: true,
    });
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expect(
      panel.getByTestId("cumulative-nominal-chart").locator(".recharts-line"),
    ).toHaveCount(1);
  }
  await seriesGroup(panel)
    .getByRole("button", { name: "Overlay", exact: true })
    .click();
  await expect(
    panel.getByTestId("cumulative-nominal-chart").locator(".recharts-line"),
  ).toHaveCount(2);
  expect(await panel.innerText()).not.toMatch(/\b(?:NaN|undefined|Infinity)\b/);
});

test("a custom baseline persists between tabs and prints once with the chosen plotting settings", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.print = () => window.dispatchEvent(new Event("beforeprint"));
  });
  await openInflation(page);
  await selectAverageEarnings(page);
  let panel = screenPanel(page);
  await panel
    .getByRole("combobox", { name: "Starting month", exact: true })
    .selectOption("2025-01");
  await panel
    .getByRole("group", { name: "Cumulative value scale" })
    .getByRole("button", { name: "% change", exact: true })
    .click();
  await intervalGroup(panel)
    .getByRole("button", { name: "Quarterly", exact: true })
    .click();
  await seriesGroup(panel)
    .getByRole("button", { name: "Hourly earnings", exact: true })
    .click();
  await expectTotals(panel, "4.17%", "4.00%", /[−-]0\.16%/);

  await page.getByTestId("tab-labor").click();
  panel = screenPanel(page);
  await expect(
    panel
      .getByRole("group", { name: "Cumulative value scale" })
      .getByRole("button", { name: "% change", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    panel.getByRole("combobox", { name: "Starting month", exact: true }),
  ).toHaveValue("2025-01");
  await expect(
    intervalGroup(panel).getByRole("button", {
      name: "Quarterly",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    seriesGroup(panel).getByRole("button", {
      name: "Hourly earnings",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await expectTotals(panel, "4.17%", "4.00%", /[−-]0\.16%/);

  await page.getByTestId("print-all").click();
  await page.getByRole("button", { name: "Landscape", exact: true }).click();
  await page.emulateMedia({ media: "print" });
  const reportPanel = page
    .locator(".print-document .section-inflation")
    .getByTestId("cumulative-comparison");
  await expect(reportPanel).toBeVisible();
  await expect(
    page.locator(".print-document").getByTestId("cumulative-comparison"),
  ).toHaveCount(1);
  await expect(
    page
      .locator(".print-document .section-labor")
      .getByTestId("cumulative-comparison"),
  ).toHaveCount(0);
  await expect(reportPanel.locator(".cumulative-period")).toContainText(
    /Jan 2025.*Jul 2025/,
  );
  await expect(reportPanel.locator(".cumulative-period")).toContainText(
    "Quarterly",
  );
  await expect(reportPanel.locator(".cumulative-period")).toContainText(
    "0% at start",
  );
  await expect(
    reportPanel
      .getByTestId("cumulative-nominal-chart")
      .locator(".recharts-line"),
  ).toHaveCount(1);
  await expect(reportPanel.locator(".chart-legend")).toHaveText(
    "Average hourly earnings",
  );
  await expectTotals(reportPanel, "4.17%", "4.00%", /[−-]0\.16%/);

  await page.emulateMedia({ media: "screen" });
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  await page
    .locator(".screen-only .range-control")
    .getByRole("button", { name: "1Y", exact: true })
    .click();
  await expect(
    screenPanel(page).getByRole("combobox", {
      name: "Starting month",
      exact: true,
    }),
  ).toHaveValue("");
});

test("cumulative comparisons identify aging or retained sources and do not invent a missing source", async ({
  page,
}) => {
  let snapshot = cumulativeSnapshot();
  await openInflation(page, () => snapshot);
  await selectAverageEarnings(page);
  const panel = screenPanel(page);
  await expectTotals(panel, "25.00%", "30.00%", "4.00%");
  await expect(
    panel.locator(".cumulative-source-warning").first(),
  ).toContainText(/aging|stale/i);

  snapshot = structuredClone(snapshot);
  snapshot.series.CPIAUCSL.status = "error";
  snapshot.series.CPIAUCSL.error = "Source request timed out.";
  await page.getByTestId("refresh-snapshot").click();
  await expect(page.getByTestId("refresh-snapshot")).toBeEnabled();
  await expect(
    panel.locator(".cumulative-source-warning").first(),
  ).toContainText("Retained data");
  await expectTotals(panel, "25.00%", "30.00%", "4.00%");

  snapshot = structuredClone(snapshot);
  snapshot.series.CPIAUCSL = {
    ...snapshot.series.CPIAUCSL,
    observations: [],
    fetchedAt: null,
    status: "unavailable",
    error: "Source unavailable for this test.",
  };
  await page.getByTestId("refresh-snapshot").click();
  await expect(page.getByTestId("refresh-snapshot")).toBeEnabled();
  await expect(panel.getByTestId("cumulative-total-prices")).toHaveCount(0);
  await expect(panel.getByTestId("cumulative-total-realEarnings")).toHaveCount(
    0,
  );
  await expect(panel.locator(".chart-empty").first()).toBeVisible();
  expect(await panel.innerText()).not.toMatch(/\b(?:NaN|undefined|Infinity)\b/);
});

test("isolated annual observations remain visible across missing monthly data", async ({
  page,
}) => {
  const snapshot = cumulativeSnapshot();
  snapshot.series.CPIAUCSL.observations = [];
  snapshot.series.CES0500000003.observations = [];
  for (let month = 0; month <= 90; month += 1) {
    const date = new Date(Date.UTC(2018, month, 1)).toISOString().slice(0, 10);
    snapshot.series.CPIAUCSL.observations.push({
      date,
      value: date.slice(5, 7) === "05" ? null : 100 + (25 * month) / 90,
    });
    snapshot.series.CES0500000003.observations.push({
      date,
      value: 20 + (6 * month) / 90,
    });
  }
  await openInflation(page, () => snapshot);
  await selectAverageEarnings(page);
  await page
    .locator(".screen-only .snapshot-controls .range-control")
    .getByRole("button", { name: "ALL", exact: true })
    .click();
  const panel = screenPanel(page);
  await intervalGroup(panel)
    .getByRole("button", { name: "Yearly", exact: true })
    .click();
  await expectTotals(panel, "25.00%", "30.00%", "4.00%");
  await expect(panel.locator(".cumulative-period")).toContainText(
    /Jan 2018.*Jul 2025/,
  );

  // Each missing May interrupts the annual line. Actual observations must still
  // be drawn even when numerous sampled rows normally suppress chart dots.
  const pricePoints = panel
    .getByTestId("cumulative-nominal-chart")
    .locator(".cumulative-point");
  const realPoints = panel
    .getByTestId("cumulative-real-chart")
    .locator(".cumulative-point");
  for (const points of [pricePoints, realPoints]) {
    await expect(points.first()).toBeVisible();
    const box = await points.first().boundingBox();
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
  }
});

test("the base-100 index compounds 3%, 2%, then 9% and keeps the same total at every interval", async ({
  page,
}) => {
  const snapshot = cumulativeSnapshot();
  const dates = ["2024-01-01", "2024-02-01", "2024-03-01", "2024-04-01"];
  snapshot.series.CPIAUCSL.observations = dates.map((date) => ({
    date,
    value: 100,
  }));
  snapshot.series.CES0500000003.observations = [20, 20.6, 21.012, 22.90308].map(
    (value, index) => ({ date: dates[index], value }),
  );
  await openInflation(page, () => snapshot);
  await selectAverageEarnings(page);
  const panel = screenPanel(page);
  await expectTotals(panel, "0.00%", "14.52%", "14.52%");
  await expect(panel.getByTestId("cumulative-index-earnings")).toContainText(
    "114.52",
  );
  await expect(
    panel.getByTestId("cumulative-index-realEarnings"),
  ).toContainText("114.52");
  const methodology = panel.locator(".cumulative-method");
  await methodology.locator("summary").click();
  for (const [month, level] of [
    ["Jan 2024 · start", "100.00"],
    ["Feb 2024", "103.00"],
    ["Mar 2024", "105.06"],
    ["Apr 2024", "114.52"],
  ]) {
    const row = methodology
      .getByRole("row")
      .filter({ has: page.getByRole("cell", { name: month, exact: true }) });
    await expect(row.locator("td")).toHaveText([month, "100.00", level, level]);
  }
  for (const interval of ["Quarterly", "Yearly"]) {
    await intervalGroup(panel)
      .getByRole("button", { name: interval, exact: true })
      .click();
    await expectTotals(panel, "0.00%", "14.52%", "14.52%");
    await expect(
      panel.getByTestId("cumulative-index-realEarnings"),
    ).toContainText("114.52");
  }
});

test("median weekly earnings default to real quarterly observations and CPI quarterly means", async ({
  page,
}) => {
  await openInflation(page, () => medianSnapshot());
  const panel = screenPanel(page);
  await expect(
    panel.getByRole("combobox", { name: "Earnings measure", exact: true }),
  ).toHaveValue("median");
  const baseline = panel.getByRole("combobox", {
    name: "Starting quarter",
    exact: true,
  });
  await expect(baseline).toHaveValue("");
  await expect(baseline.locator("option")).toHaveCount(7);
  await expect(baseline.locator('option[value="2024-01"]')).toHaveText(
    "Q1 2024",
  );
  await expect(baseline.locator('option[value="2024-02"]')).toHaveCount(0);
  await expect(
    intervalGroup(panel).getByRole("button", {
      name: "Quarterly",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    intervalGroup(panel).getByRole("button", { name: "Monthly", exact: true }),
  ).toHaveCount(0);
  await expect(panel.locator(".cumulative-period")).toContainText(
    /Q1 2024.*Q2 2025/,
  );
  await expectTotals(panel, "25.00%", "30.00%", "4.00%");
  for (const [key, index] of [
    ["prices", "125.00"],
    ["earnings", "130.00"],
    ["realEarnings", "104.00"],
  ]) {
    await expect(panel.getByTestId(`cumulative-index-${key}`)).toContainText(
      index,
    );
  }
  await expect(panel.locator(".chart-legend")).toContainText(
    "Median weekly earnings",
  );
  await expect(
    panel.getByRole("heading", {
      name: "Real median weekly earnings",
      exact: true,
    }),
  ).toBeVisible();

  const methodology = panel.locator(".cumulative-method");
  await methodology.locator("summary").click();
  await expect(methodology.locator("tbody tr")).toHaveCount(6);
  await expect(methodology.locator("tbody tr td:first-child")).toHaveText([
    "Q2 2025",
    "Q1 2025",
    "Q4 2024",
    "Q3 2024",
    "Q2 2024",
    "Q1 2024 · start",
  ]);
  await expect(
    methodology
      .getByRole("row")
      .filter({ hasText: "Q1 2024 · start" })
      .locator("td"),
  ).toHaveText(["Q1 2024 · start", "100.00", "100.00", "100.00"]);

  // Annual sampling uses the observed Q4 (October key), not a synthetic
  // December wage observation, and retains the latest non-Q4 endpoint.
  await intervalGroup(panel)
    .getByRole("button", { name: "Yearly", exact: true })
    .click();
  await expect(methodology.locator("tbody tr td:first-child")).toHaveText([
    "Q2 2025 · partial",
    "Q4 2024",
    "Q1 2024 · start",
  ]);
  await expect(panel.locator(".cumulative-period")).toContainText(
    /Q2 2025 is a partial year endpoint/,
  );
  await expectTotals(panel, "25.00%", "30.00%", "4.00%");
  expect(await panel.innerText()).not.toMatch(/\b(?:NaN|undefined|Infinity)\b/);
});

test("median comparisons preserve incomplete-quarter and missing-earnings gaps without inventing CPI means", async ({
  page,
}) => {
  let snapshot = medianSnapshot();
  snapshot.series.CPIAUCSL.observations.find(
    (point) => point.date === "2024-08-01",
  ).value = null;
  snapshot.series.LES1252881500Q.observations.find(
    (point) => point.date === "2024-10-01",
  ).value = null;
  await openInflation(page, () => snapshot);
  const panel = screenPanel(page);
  await expectTotals(panel, "25.00%", "30.00%", "4.00%");
  const baseline = panel.getByRole("combobox", {
    name: "Starting quarter",
    exact: true,
  });
  await expect(baseline.locator('option[value="2024-07"]')).toHaveCount(0);
  await expect(baseline.locator('option[value="2024-10"]')).toHaveCount(0);

  const methodology = panel.locator(".cumulative-method");
  await methodology.locator("summary").click();
  await expect(
    methodology
      .getByRole("row")
      .filter({ has: page.getByRole("cell", { name: "Q3 2024", exact: true }) })
      .locator("td"),
  ).toHaveText(["Q3 2024", "—", "112.00", "—"]);
  await expect(
    methodology
      .getByRole("row")
      .filter({ has: page.getByRole("cell", { name: "Q4 2024", exact: true }) })
      .locator("td"),
  ).toHaveText(["Q4 2024", "115.00", "—", "—"]);

  // Gap markers survive annual sampling, including a non-Q4 gap, so a plotted
  // line cannot imply uninterrupted observation across the incomplete quarter.
  await intervalGroup(panel)
    .getByRole("button", { name: "Yearly", exact: true })
    .click();
  await expect(
    methodology.getByRole("cell", { name: "Q3 2024", exact: true }),
  ).toBeVisible();
  await expectTotals(panel, "25.00%", "30.00%", "4.00%");

  snapshot = structuredClone(snapshot);
  snapshot.series.CPIAUCSL.observations.find(
    (point) => point.date === "2025-06-01",
  ).value = null;
  await page.getByTestId("refresh-snapshot").click();
  await expect(page.getByTestId("refresh-snapshot")).toBeEnabled();
  await expect(panel.locator(".cumulative-period")).toContainText(
    /Q1 2024.*Q1 2025/,
  );
  await expect(baseline.locator('option[value="2025-04"]')).toHaveCount(0);
  await expectTotals(panel, "20.00%", "25.00%", "4.17%");
  expect(await panel.innerText()).not.toMatch(/\b(?:NaN|undefined|Infinity)\b/);
});

test("earnings basis resets the baseline, retains per-basis intervals across tabs, and prints the shared median selection at 320px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.addInitScript(() => {
    window.print = () => window.dispatchEvent(new Event("beforeprint"));
  });
  await openInflation(page, () => medianSnapshot());
  let panel = screenPanel(page);
  await panel
    .getByRole("combobox", { name: "Starting quarter", exact: true })
    .selectOption("2025-01");
  await intervalGroup(panel)
    .getByRole("button", { name: "Yearly", exact: true })
    .click();
  await seriesGroup(panel)
    .getByRole("button", { name: "Weekly earnings", exact: true })
    .click();
  await panel
    .getByRole("group", { name: "Cumulative value scale" })
    .getByRole("button", { name: "% change", exact: true })
    .click();
  await expectTotals(panel, "4.17%", "4.00%", /[−-]0\.16%/);

  await page.getByTestId("tab-labor").click();
  panel = screenPanel(page);
  await expect(
    panel.getByRole("combobox", { name: "Earnings measure", exact: true }),
  ).toHaveValue("median");
  await expect(
    panel.getByRole("combobox", { name: "Starting quarter", exact: true }),
  ).toHaveValue("2025-01");
  await expect(
    intervalGroup(panel).getByRole("button", { name: "Yearly", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    seriesGroup(panel).getByRole("button", {
      name: "Weekly earnings",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    panel
      .getByRole("group", { name: "Cumulative value scale" })
      .getByRole("button", { name: "% change", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expectTotals(panel, "4.17%", "4.00%", /[−-]0\.16%/);

  await selectAverageEarnings(page);
  await expect(
    panel.getByRole("combobox", { name: "Starting month", exact: true }),
  ).toHaveValue("");
  await expect(panel.locator(".cumulative-basis-notice")).toContainText(
    "Starting month reset to the automatic range start",
  );
  await expect(
    intervalGroup(panel).getByRole("button", { name: "Monthly", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await panel
    .getByRole("combobox", { name: "Starting month", exact: true })
    .selectOption("2024-04");
  await intervalGroup(panel)
    .getByRole("button", { name: "Quarterly", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    )
    .toBeLessThanOrEqual(1);

  await panel
    .getByRole("combobox", { name: "Earnings measure", exact: true })
    .selectOption("median");
  await expect(
    panel.getByRole("combobox", { name: "Starting quarter", exact: true }),
  ).toHaveValue("");
  await expect(panel.locator(".cumulative-basis-notice")).toContainText(
    "Starting quarter reset to the automatic range start",
  );
  await expect(
    intervalGroup(panel).getByRole("button", { name: "Yearly", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");

  // Switching back also restores the average series' own plotting interval.
  await selectAverageEarnings(page);
  await expect(
    intervalGroup(panel).getByRole("button", {
      name: "Quarterly",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await panel
    .getByRole("combobox", { name: "Earnings measure", exact: true })
    .selectOption("median");
  await panel
    .getByRole("combobox", { name: "Starting quarter", exact: true })
    .selectOption("2024-01");
  await expect(panel.locator(".cumulative-basis-notice")).toHaveCount(0);
  await page.getByTestId("tab-inflation").click();
  panel = screenPanel(page);
  await expect(
    panel.getByRole("combobox", { name: "Starting quarter", exact: true }),
  ).toHaveValue("2024-01");
  await expectTotals(panel, "25.00%", "30.00%", "4.00%");
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    )
    .toBeLessThanOrEqual(1);

  await page.getByTestId("print-all").click();
  await page.getByRole("button", { name: "Landscape", exact: true }).click();
  await page.emulateMedia({ media: "print" });
  const reportPanel = page
    .locator(".print-document .section-inflation")
    .getByTestId("cumulative-comparison");
  await expect(reportPanel).toBeVisible();
  await expect(
    page.locator(".print-document").getByTestId("cumulative-comparison"),
  ).toHaveCount(1);
  await expect(reportPanel.getByRole("combobox")).toHaveCount(0);
  await expect(reportPanel.locator(".cumulative-period")).toContainText(
    /Q1 2024.*Q2 2025/,
  );
  await expect(reportPanel.locator(".cumulative-period")).toContainText(
    "Median weekly earnings",
  );
  await expect(reportPanel.locator(".cumulative-period")).toContainText(
    "Yearly",
  );
  await expect(reportPanel.locator(".cumulative-period")).toContainText(
    "0% at start",
  );
  await expect(reportPanel.locator(".chart-legend")).toHaveText(
    "Median weekly earnings",
  );
  await expect(
    reportPanel.getByRole("heading", {
      name: "Real median weekly earnings",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    reportPanel
      .getByTestId("cumulative-nominal-chart")
      .locator(".recharts-line"),
  ).toHaveCount(1);
  await expectTotals(reportPanel, "25.00%", "30.00%", "4.00%");
});
