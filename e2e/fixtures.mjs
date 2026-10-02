import { test as base, expect } from "@playwright/test";
import { relevantRequestFailure } from "../scripts/browser/harness.mjs";

// Same browser-error contract as harness.mjs: page errors, console errors,
// unexpected request failures and same-origin HTTP >= 400 fail the test.
async function withDiagnostics(page, baseURL, provide, testInfo) {
  const origin = new URL(baseURL).origin;
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const { url, lineNumber } = message.location();
    errors.push(`console.error: ${message.text()}${url ? ` (${url}:${lineNumber ?? 0})` : ""}`);
  });
  page.on("requestfailed", (request) => {
    const failure = relevantRequestFailure(request, origin);
    if (failure) errors.push(`requestfailed: ${failure}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400 && new URL(response.url()).origin === origin) {
      errors.push(`HTTP ${response.status()}: ${response.url()}`);
    }
  });
  await provide(page);
  if (testInfo.status !== testInfo.expectedStatus) return;
  // Late errors from the last interaction, as in harness.mjs.
  await page.waitForTimeout(150);
  expect(errors, `${testInfo.title}: errori browser`).toEqual([]);
}

// PW_SHARED_CONTEXT=1 (pilot measurement): one context per worker and viewport
// profile, a fresh page per test. Pages share the HTTP cache, like Puppeteer.
const sharedContexts = new Map();

const isolatedPage = async ({ page, baseURL }, provide, testInfo) => withDiagnostics(page, baseURL, provide, testInfo);

const sharedPage = async ({ browser, baseURL, viewport, hasTouch, isMobile, deviceScaleFactor, colorScheme }, provide, testInfo) => {
  const options = { baseURL, viewport, hasTouch, isMobile, deviceScaleFactor, colorScheme };
  const key = JSON.stringify(options);
  if (!sharedContexts.has(key)) sharedContexts.set(key, await browser.newContext(options));
  const page = await sharedContexts.get(key).newPage();
  try {
    await withDiagnostics(page, baseURL, provide, testInfo);
  } finally {
    await page.close();
  }
};

export const test = base.extend({
  page: process.env.PW_SHARED_CONTEXT === "1" ? sharedPage : isolatedPage,
  closeSharedContexts: [async ({ browser }, provide) => {
    await provide(browser);
    for (const context of sharedContexts.values()) await context.close();
  }, { scope: "worker", auto: true }],
});

export { expect };

export function viewportFor(width) {
  return {
    viewport: { width, height: width <= 460 ? 844 : 900 },
    deviceScaleFactor: 1,
    hasTouch: width <= 390,
    isMobile: width <= 390,
  };
}

export async function open(page, pathname, readySelector = "main h1") {
  const response = await page.goto(pathname, { waitUntil: "domcontentloaded" });
  expect([200, 304], `${pathname}: HTTP ${response?.status()}`).toContain(response?.status());
  await expect(page.locator(readySelector).first()).toBeVisible({ timeout: 45_000 });
  await page.evaluate(() => document.fonts.ready);
}
