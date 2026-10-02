import { defineConfig } from "@playwright/test";
import { resolveBrowserExecutable } from "./scripts/browser/harness.mjs";

const port = process.env.NEXT_PORT ?? "3000";
const baseURL = process.env.DVNS_BASE_URL ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  // One retry records a trace of the failure; --fail-on-flaky-tests keeps the gate strict.
  retries: 1,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  outputDir: "artifacts/playwright/results",
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "artifacts/playwright/report" }],
    ["json", { outputFile: "artifacts/playwright/results.json" }],
  ],
  use: {
    baseURL,
    actionTimeout: 10_000,
    navigationTimeout: 45_000,
    // Recording every test slows heavy evaluate loops ~12x (3 s -> 40 s per government chart).
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    // Same Chrome binary as the Puppeteer suites; PW_BROWSER=shell (pilot
    // measurement) uses Playwright's chromium-headless-shell instead.
    launchOptions: {
      executablePath: process.env.PW_BROWSER === "shell" ? undefined : resolveBrowserExecutable(),
      args: ["--disable-dev-shm-usage"],
    },
  },
  projects: [
    { name: "chiaro", use: { colorScheme: "light" } },
    { name: "scuro", use: { colorScheme: "dark" } },
  ],
  webServer: process.env.DVNS_BASE_URL ? undefined : {
    command: `node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port ${port}`,
    url: `${baseURL}/territori/irpef`,
    timeout: 90_000,
    reuseExistingServer: false,
  },
});
