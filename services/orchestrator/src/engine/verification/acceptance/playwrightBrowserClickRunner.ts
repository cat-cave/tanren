/**
 * rv-26.6: the in-process {@link BrowserClickRunner} — a REAL Playwright
 * chromium that navigates to the served URL and clicks the target selector N times.
 *
 * This is the runner for hosts that CAN launch a prebuilt chromium directly (CI lanes,
 * FHS hosts). The Nix orchestrator host cannot (missing FHS libs — see
 * `podmanScreenshotRunner`), so production wires {@link buildPodmanBrowserClickRunner};
 * both implement the identical seam and identical fail-loud contract.
 *
 * FAIL-LOUD: a launch failure, an unreachable page, an absent selector, or ANY click
 * that cannot be confirmed returns `{ ok: false }` with the failure kind — NEVER a
 * short or fabricated observation list. Every click is `await`ed against the located
 * element so a click that does not land throws and aborts the run.
 *
 * DOCTRINE: no wall-clock timeout; the click sequence runs to its own terminal state.
 */

import { chromium, type Browser } from "playwright";
import {
  confirmedClickObservations,
  type BrowserClickRunInput,
  type BrowserClickRunResult,
  type BrowserClickRunner,
} from "./browserClickRunner.js";

export interface PlaywrightBrowserClickRunnerConfig {
  /** Extra chromium launch args (e.g. `--no-sandbox` in a container). */
  readonly launchArgs?: readonly string[];
}

/**
 * The in-process Playwright runner. Constructs a fresh browser per run and closes it in
 * a `finally`, so no page/context leaks across runs.
 */
export function buildPlaywrightBrowserClickRunner(config: PlaywrightBrowserClickRunnerConfig = {}): BrowserClickRunner {
  return {
    async runClicks(input: BrowserClickRunInput): Promise<BrowserClickRunResult> {
      if (!Number.isInteger(input.clicks) || input.clicks < 1) {
        return { ok: false, kind: "click", reason: `invalid click count ${String(input.clicks)}` };
      }
      let browser: Browser;
      try {
        browser = await chromium.launch({ args: [...(config.launchArgs ?? [])] });
      } catch (error) {
        return { ok: false, kind: "launch", reason: `browser launch failed: ${describe(error)}` };
      }
      try {
        const page = await browser.newPage();
        try {
          await page.goto(input.url, { waitUntil: "load" });
        } catch (error) {
          return { ok: false, kind: "navigate", reason: `navigation to ${input.url} failed: ${describe(error)}` };
        }
        for (let performed = 0; performed < input.clicks; performed += 1) {
          try {
            // A located, single-target click: Playwright waits for the element to be
            // actionable then dispatches a REAL click. A missing/ambiguous selector or
            // a non-actionable element throws — the run fails loud, never a short count.
            await page.locator(input.selector).click();
          } catch (error) {
            return {
              ok: false,
              kind: "click",
              reason: `click ${String(performed + 1)}/${String(input.clicks)} on '${input.selector}' failed: ${describe(error)}`,
            };
          }
        }
        return { ok: true, observations: confirmedClickObservations(input.clicks) };
      } finally {
        await browser.close().catch(() => {});
      }
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message.split("\n")[0]}` : String(error);
}
