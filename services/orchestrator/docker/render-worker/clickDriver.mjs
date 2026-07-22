// rv-26.6 (apex P6) — the interactive click-driver entrypoint (runs INSIDE the container).
//
// Reads /work/params.json ({ url, selector, clicks }) the host `podmanBrowserClickRunner`
// bind-mounts in, launches the container's Playwright chromium, navigates to the served
// dashboard URL, and performs `clicks` REAL clicks on `selector`. It writes the count of
// CONFIRMED clicks to /work/result.json ({ observed }) ONLY after every click landed.
//
// FAIL-LOUD: a launch failure, an unreachable page, an absent selector, or ANY click that
// cannot be confirmed exits non-zero (the host maps that to a fail-closed browser failure)
// and writes NO result.json — never a short/fabricated count reported as success. There is
// NO wall-clock timeout — chromium runs to its own terminal state.
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";

const params = JSON.parse(readFileSync("/work/params.json", "utf8"));
const url = String(params.url);
const selector = String(params.selector);
const clicks = Number(params.clicks);
if (!Number.isInteger(clicks) || clicks < 1) {
  console.error(`RV26_CLICK_BAD_PARAMS: clicks=${String(params.clicks)}`);
  process.exit(2);
}

const browser = await chromium.launch({ args: ["--no-sandbox"] });
let observed = 0;
try {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "load" });
  for (let i = 0; i < clicks; i += 1) {
    // A located single-target click: Playwright waits for actionability then dispatches a
    // REAL click; a missing/ambiguous/non-actionable target throws and aborts the run.
    await page.locator(selector).click();
    observed += 1;
  }
} finally {
  await browser.close();
}
if (observed !== clicks) {
  // Defence in depth: the loop only completes on all-confirmed, but never emit a short count.
  console.error(`RV26_CLICK_SHORT: observed=${observed} requested=${clicks}`);
  process.exit(3);
}
writeFileSync("/work/result.json", JSON.stringify({ observed }), "utf8");
console.log(`RV26_CLICK_OK observed=${observed}`);
