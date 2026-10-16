import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL:
      "http://127.0.0.1:4173/Public_AI/Perplexity_Computer/Macro_Terminal/",
    trace: "retain-on-failure",
    launchOptions: {
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    },
  },
  webServer: {
    command: "node tests/browser/serve-build.mjs",
    url: "http://127.0.0.1:4173/Public_AI/Perplexity_Computer/Macro_Terminal/",
    reuseExistingServer: !process.env.CI,
  },
});
