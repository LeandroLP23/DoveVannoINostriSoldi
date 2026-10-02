import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RECHARTS_ROUTES } from "../scripts/browser/recharts-interactions.mjs";
import { open, test, viewportFor } from "./fixtures.mjs";

// Playwright port of scripts/browser/chart-interactions.mjs: same scenarios and assertions.
const chronology = JSON.parse(readFileSync(new URL("../scripts/etl/specs/government-scorecard-chronology.json", import.meta.url), "utf8"));
const number = (value) => Number(value.split(" · ")[0].replaceAll(".", "").replace(",", "."));

// Element handles, not locators: ~600 reads per government, and a locator re-queries the DOM on each.
async function inspectGovernmentChart(page, card, touch) {
  const svg = await card.$('svg[tabindex="0"]');
  if (!svg) return;
  const id = await card.evaluate((element) => element.dataset.slideId);
  const read = () => card.evaluate((element) => ({
    id: element.dataset.slideId,
    period: element.querySelector('[role="status"] strong').textContent,
    summaries: [...element.querySelectorAll("[data-series-summary]")].map((summary) => ({
      period: summary.querySelector("[data-selected-period]")?.textContent,
      value: summary.querySelector("[data-selected-value]")?.textContent,
      change: summary.querySelector("[data-selected-change]")?.textContent,
    })),
    periods: [...element.querySelectorAll("thead th")].slice(1, -1).map((cell) => cell.textContent),
    rows: [...element.querySelectorAll("tbody tr")].map((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent)),
  }));
  await svg.evaluate((element) => element.scrollIntoView({ block: "center", behavior: "instant" }));
  for (const key of ["Home", "ArrowRight", "End", "ArrowLeft"]) {
    const previous = await read();
    const currentIndex = previous.periods.indexOf(previous.period);
    const expectedIndex = key === "Home" ? 0 : key === "End" ? previous.periods.length - 1
      : Math.max(0, Math.min(previous.periods.length - 1, currentIndex + (key === "ArrowRight" ? 1 : -1)));
    await svg.evaluate((element) => element.focus({ preventScroll: true }));
    await page.keyboard.press(key);
    await page.waitForFunction(([element, expected]) =>
      element.querySelector('[role="status"] strong')?.textContent === expected,
    [card, previous.periods[expectedIndex]], { timeout: 8_000 });
    const state = await read();
    assert.equal(state.id, id, `${id}: i tasti del grafico cambiano indicatore`);
    assert.equal(state.summaries.length, 4, `${id}: riepiloghi della selezione assenti`);
    const index = state.periods.indexOf(state.period);
    assert.ok(index >= 0);
    if (key === "Home") assert.equal(index, 0);
    if (key === "End") assert.equal(index, state.periods.length - 1);
    for (const [countryIndex, summary] of state.summaries.entries()) {
      const observations = state.rows[countryIndex].slice(0, -1).filter((value) => value !== "Non disponibile");
      if (observations.length === 0) {
        assert.equal(summary.value, undefined);
        continue;
      }
      assert.ok(summary.period.includes(state.period), `${id}: riepilogo fermo su un altro periodo`);
      assert.equal(summary.value, state.rows[countryIndex][index], `${id}: valore diverso dalla tabella`);
      if (summary.value !== "Non disponibile" && observations.length >= 2) {
        const tolerance = (await card.evaluate((element) => element.textContent.includes("Valori: Euro"))) ? 1 : 0.02;
        assert.ok(Math.abs(number(summary.change) - (number(summary.value) - number(observations[0]))) <= tolerance,
          `${id}: variazione incoerente con il valore selezionato`);
      } else assert.equal(summary.change, "Non disponibile");
    }
  }
  // Real pointer coordinates in the SVG viewBox, including its responsive transform.
  const target = await svg.evaluate((element) => {
    const point = element.createSVGPoint();
    point.x = 62;
    point.y = 120;
    const screen = point.matrixTransform(element.getScreenCTM());
    return { x: screen.x, y: screen.y };
  });
  if (touch) await page.touchscreen.tap(target.x, target.y);
  else await page.mouse.move(target.x, target.y);
  await page.waitForFunction((slideId) => {
    const element = document.querySelector(`[data-slide-id="${slideId}"]`);
    return element.querySelector('[role="status"] strong').textContent === element.querySelector("thead th:nth-child(2)").textContent;
  }, id);
  const pointerState = await read();
  assert.ok(pointerState.summaries.every((summary) => summary.period === undefined || summary.period.includes(pointerState.period)),
    `${id}: puntatore e riepilogo non sincronizzati`);
}

async function inspectRecharts(page, minimumCharts, touch) {
  const unavailable = /Distribuzione non disponibile dalla fonte IPA|non è disponibile ora/i;
  await page.waitForFunction(([minimum, source]) => {
    if (document.querySelectorAll(".recharts-wrapper svg").length >= minimum) return true;
    return new RegExp(source, "i").test(document.body?.innerText ?? "");
  }, [minimumCharts, unavailable.source], { timeout: 45_000 });

  const charts = await page.$$(".recharts-wrapper");
  if (charts.length < minimumCharts) {
    assert.ok(unavailable.test(await page.locator("body").innerText()), `attesi almeno ${minimumCharts} grafici Recharts`);
    return;
  }
  for (const [index, chart] of charts.entries()) {
    await chart.evaluate((element) => element.scrollIntoView({ block: "center", behavior: "instant" }));
    const targets = await chart.evaluate((element) => {
      const bars = [...element.querySelectorAll(".recharts-bar-rectangle path")];
      const tiles = [...element.querySelectorAll(".recharts-treemap-depth-1 rect")];
      const marks = bars.length ? bars : tiles;
      if (marks.length) return marks.map((mark) => {
        const box = mark.getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 + scrollY, width: box.width, height: box.height };
      }).filter((box) => box.width > 2 && box.height > 2).slice(0, 3);
      const grid = element.querySelector(".recharts-cartesian-grid");
      if (!grid) return [];
      const box = grid.getBoundingClientRect();
      return [0.15, 0.5, 0.85].map((ratio) => ({ x: box.x + box.width * ratio, y: box.y + box.height / 2 + scrollY }));
    });
    assert.ok(targets.length >= 2, `grafico ${index}: almeno due punti da controllare`);
    const texts = [];
    for (const target of targets) {
      // Tall rankings exceed the viewport: bring each mark below the sticky header first.
      const position = await page.evaluate((point) => {
        window.scrollTo({ top: point.y - innerHeight / 2, behavior: "instant" });
        return { x: point.x, y: point.y - scrollY };
      }, target);
      if (touch) await page.touchscreen.tap(position.x, position.y);
      else await page.mouse.move(position.x, position.y);
      await page.waitForFunction((element) => {
        const tooltip = element.querySelector(".recharts-tooltip-wrapper");
        return tooltip && getComputedStyle(tooltip).visibility === "visible" && tooltip.textContent.length > 0;
      }, chart);
      texts.push(await chart.evaluate((element) => element.querySelector(".recharts-tooltip-wrapper").textContent));
    }
    assert.ok(new Set(texts).size >= 2, `grafico ${index}: il contenuto non segue il punto selezionato`);
  }
}

for (const width of [390, 768, 1280]) {
  test.describe(`${width}px`, () => {
    test.use(viewportFor(width));
    const touch = width <= 390;
    const governments = width === 1280 ? chronology.governments.map((government) => government.id) : ["berlusconi-iv"];

    for (const id of governments) {
      test(`governo ${id}`, async ({ page }) => {
        await open(page, `/governi/${id}`, "[data-slide-id]");
        await inspectGovernmentChart(page, await page.$("[data-slide-id]"), touch);
        await page.locator("button").filter({ hasText: /^Vista elenco$/ }).evaluate((button) => button.click());
        await page.waitForSelector('[data-view="list"]', { state: "attached" });
        for (const scope of ["Mandato", "Serie completa"]) {
          await page.locator("button").filter({ hasText: new RegExp(`^${scope}$`) }).evaluate((button) => button.click());
          for (const card of await page.$$("[data-slide-id]")) await inspectGovernmentChart(page, card, touch);
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, "overflow della pagina");
      });
    }

    for (const [pathname, minimumCharts] of RECHARTS_ROUTES) {
      test(`grafici ${pathname}`, async ({ page }) => {
        await open(page, pathname);
        await inspectRecharts(page, minimumCharts, touch);
      });
    }
  });
}
