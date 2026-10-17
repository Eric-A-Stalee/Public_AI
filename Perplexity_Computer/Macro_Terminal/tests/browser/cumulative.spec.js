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
  const panel = screenPanel(page);
  await expect(
    panel.getByRole("combobox", { name: "Starting month", exact: true }),
  ).toHaveValue("");
  await expectTotals(panel, "25.00%", "30.00%", "4.00%");
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
        "0.00%",
        "0.00%",
        "0.00%",
      ]);
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
  let panel = screenPanel(page);
  await panel
    .getByRole("combobox", { name: "Starting month", exact: true })
    .selectOption("2025-01");
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
