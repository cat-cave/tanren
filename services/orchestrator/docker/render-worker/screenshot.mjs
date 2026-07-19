// ds-4 Slice B — the render-worker screenshot entrypoint (runs INSIDE the container).
//
// Reads /work/page.html (the scenario-wrapped document the host `podmanScreenshotRunner`
// bind-mounts in), launches the container's Playwright chromium at the requested viewport
// (PW_WIDTH/PW_HEIGHT), and writes the REAL screenshot to /work/out.png. On ANY failure it
// exits non-zero (the host maps that to a fail-closed `render_failed(browser)`), never a
// blank PNG. There is NO wall-clock timeout — chromium runs to its own terminal state.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const width = Number.parseInt(process.env.PW_WIDTH ?? "1280", 10) || 1280;
const height = Number.parseInt(process.env.PW_HEIGHT ?? "800", 10) || 800;
const html = readFileSync("/work/page.html", "utf8");

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setContent(html, { waitUntil: "networkidle" });
  await page.screenshot({ path: "/work/out.png" });
} finally {
  await browser.close();
}
console.log("DS4_SHOT_OK");
