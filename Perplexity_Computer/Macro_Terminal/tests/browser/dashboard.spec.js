import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const published = JSON.parse(
  readFileSync(
    new URL("../../public/data/latest.json", import.meta.url),
    "utf8",
  ),
);
const dataRoute = "**/data/latest.json";
const tabNames = ["overview", "rates", "inflation", "growth", "labor", "risk"];

async function serveSnapshot(page, snapshot = published) {
  await page.route(dataRoute, (route) => route.fulfill({ json: snapshot }));
}

test("published data loads at the nested site URL and all six tabs render", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await serveSnapshot(page);
  await page.goto("./");
  await expect(page.getByTestId("refresh-snapshot")).toBeEnabled();
  await expect(
    page
      .locator(".screen-only")
      .getByTestId("metric-cpi")
      .locator(".metric-number"),
  ).not.toHaveText("—");
  for (const name of tabNames) {
    await page.getByTestId(`tab-${name}`).click();
    await expect(page.locator(`.screen-only .section-${name}`)).toBeVisible();
    await expect(
      page.locator(".screen-only .recharts-surface").first(),
    ).toBeVisible();
    expect(await page.locator(".screen-only").innerText()).not.toMatch(
      /\b(?:NaN|undefined|Infinity)\b/,
    );
  }
  await page.keyboard.press("3");
  await expect(page.locator(".screen-only .section-inflation")).toBeVisible();
  expect(errors).toEqual([]);
});

test("a failed first request exposes an error and never substitutes demonstration values", async ({
  page,
}) => {
  await page.route(dataRoute, (route) =>
    route.fulfill({ status: 503, body: "Unavailable" }),
  );
  await page.goto("./");
  await expect(page.getByRole("alert")).toContainText("could not be loaded");
  for (const number of await page
    .locator(".screen-only .metric-number")
    .allTextContents())
    expect(number).toBe("—");
  await expect(page.locator(".screen-only .chart-empty").first()).toBeVisible();
});

test("a malformed refresh retains the last usable dataset and reports the failure", async ({
  page,
}) => {
  let requests = 0;
  await page.route(dataRoute, (route) =>
    route.fulfill({
      json: ++requests === 1 ? published : { schemaVersion: 999, series: {} },
    }),
  );
  await page.goto("./");
  const card = page
    .locator(".screen-only")
    .getByTestId("metric-cpi")
    .locator(".metric-number");
  await expect(card).not.toHaveText("—");
  const before = await card.innerText();
  await page.getByTestId("refresh-snapshot").click();
  await expect(page.getByRole("alert")).toContainText("last usable snapshot");
  await expect(card).toHaveText(before);
  expect(requests).toBe(2);
});

test("a partial provider failure retains observed values with a visible status", async ({
  page,
}) => {
  const snapshot = structuredClone(published);
  snapshot.series.CPIAUCNS.status = "error";
  snapshot.series.CPIAUCNS.error = "Source request timed out.";
  await serveSnapshot(page, snapshot);
  await page.goto("./");
  const card = page.locator(".screen-only").getByTestId("metric-cpi");
  await expect(card.locator(".metric-number")).not.toHaveText("—");
  await expect(card).toContainText("Retained data");
  await expect(page.locator(".data-status-toggle")).toContainText(
    "source errors",
  );
});

test("print report renders every section and charts in print media", async ({
  page,
}) => {
  await serveSnapshot(page);
  await page.addInitScript(() => {
    window.print = () => window.dispatchEvent(new Event("beforeprint"));
  });
  await page.goto("./");
  await expect(page.getByTestId("refresh-snapshot")).toBeEnabled();
  await page.getByTestId("print-all").click();
  await page.getByRole("button", { name: "Landscape", exact: true }).click();
  await expect(page.locator(".print-document .dashboard-section")).toHaveCount(
    6,
  );
  await page.emulateMedia({ media: "print" });
  for (const name of tabNames) {
    await expect(
      page.locator(`.print-document .section-${name}`),
    ).toBeVisible();
    const chart = page
      .locator(`.print-document .section-${name} .recharts-surface`)
      .first();
    await expect(chart).toBeVisible();
    expect((await chart.boundingBox()).width).toBeGreaterThan(100);
  }
  await expect(page.locator(".app-shell")).toBeHidden();
});

test("mobile layout remains within the viewport on every section", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await serveSnapshot(page);
  await page.goto("./");
  await expect(page.getByTestId("refresh-snapshot")).toBeEnabled();
  for (const name of tabNames) {
    await page.getByTestId(`tab-${name}`).click();
    await expect(page.locator(`.screen-only .section-${name}`)).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(391);
  }
});

test("native PDF printing has already drawn charts with nonzero geometry", async ({
  page,
}) => {
  await serveSnapshot(page);
  await page.goto("./");
  await expect(page.getByTestId("refresh-snapshot")).toBeEnabled();
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".print-document .recharts-line-curve[d]")
        .length > 15,
  );
  await page.evaluate(() => {
    window.addEventListener(
      "beforeprint",
      () => {
        window.__printGeometry = Array.from(
          document.querySelectorAll(".print-document .recharts-surface"),
          (svg) => ({
            width: svg.getBoundingClientRect().width,
            height: svg.getBoundingClientRect().height,
          }),
        );
      },
      { once: true },
    );
  });
  await page.pdf({ printBackground: true, preferCSSPageSize: true });
  const charts = await page.evaluate(() => window.__printGeometry);
  expect(charts.length).toBeGreaterThanOrEqual(20);
  for (const chart of charts) {
    expect(chart.width).toBeGreaterThan(100);
    expect(chart.height).toBeGreaterThan(100);
  }
});
