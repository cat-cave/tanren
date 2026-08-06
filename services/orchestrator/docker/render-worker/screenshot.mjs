// ds-4 Slice B — the render-worker screenshot entrypoint (runs INSIDE the container).
//
// Reads /work/page.html (the scenario-wrapped document the host `podmanScreenshotRunner`
// bind-mounts in), launches the container's Playwright chromium at the requested viewport
// (PW_WIDTH/PW_HEIGHT), and writes the REAL screenshot to /work/out.png. On ANY failure it
// exits non-zero (the host maps that to a fail-closed `render_failed(browser)`), never a
// blank PNG. There is NO wall-clock timeout — chromium runs to its own terminal state.
import { readFileSync } from "node:fs";

// The scenario's locale, DECLARED by the host runner. FAIL-CLOSED: a missing PW_LOCALE is
// a wiring fault, not a reason to silently fall back to the container's default locale —
// that default is host-architecture-dependent (an arm64 chromium under a C-family locale
// reports `en-US@posix`, which is not valid BCP-47 and throws in `Intl`). This guard runs
// FIRST — before any I/O or loading playwright — so the entrypoint fails closed (and stays
// host-testable) even when the browser package or the bind-mounted page are absent.
const locale = process.env.PW_LOCALE;
if (!locale) {
  console.error("DS4_SHOT_NO_LOCALE: PW_LOCALE is required (the host runner declares the scenario locale)");
  process.exit(2);
}

const width = Number.parseInt(process.env.PW_WIDTH ?? "1280", 10) || 1280;
const height = Number.parseInt(process.env.PW_HEIGHT ?? "800", 10) || 800;
const html = readFileSync("/work/page.html", "utf8");
const { chromium } = await import("playwright");

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width, height }, locale });
  await page.setContent(html, { waitUntil: "networkidle" });
  await page.screenshot({ path: "/work/out.png" });
} finally {
  await browser.close();
}
console.log("DS4_SHOT_OK");
