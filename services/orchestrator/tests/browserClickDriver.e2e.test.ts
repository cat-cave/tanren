// rv-26.6 — the REAL end-to-end proof, gated on TANREN_RV26_BROWSER_E2E=1 (the
// RLS-suite pattern) because it needs podman + the render-worker image, not present in
// every CI lane. It serves a static target-control fixture page over node:http and
// drives 100 REAL clicks through a REAL containerized Playwright chromium, asserting the
// runner observes EXACTLY 100 confirmed clicks. The negative arm serves a page WITHOUT the
// button and asserts the runner FAILS LOUD (never a short/fabricated count).
//
// Run: TANREN_RV26_BROWSER_E2E=1 corepack pnpm exec vitest run \
//   services/orchestrator/tests/browserClickDriver.e2e.test.ts   (from the worktree root)
//
// On an FHS host that can launch chromium directly, set TANREN_RV26_BROWSER_INPROCESS=1 to
// ALSO exercise the in-process runner against the same fixture.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_RENDER_WORKER_IMAGE } from "../src/engine/design/render/podmanScreenshotRunner.js";
import {
  buildPlaywrightBrowserClickRunner,
  buildPodmanBrowserClickRunner,
} from "../src/engine/verification/acceptance/index.js";

const execFileAsync = promisify(execFile);
const ENABLED = process.env["TANREN_RV26_BROWSER_E2E"] === "1";
const INPROCESS = process.env["TANREN_RV26_BROWSER_INPROCESS"] === "1";
const PODMAN = process.env["TANREN_PODMAN_BIN"] ?? "podman";
const SELECTOR = "#target-control";

function fixturePage(withButton: boolean): string {
  const button = withButton ? `<button id="target-control">Target control</button>` : `<p>no control here</p>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>browser click fixture</title></head>
<body>${button}<script>
let n = 0;
const el = document.getElementById("target-control");
if (el) el.addEventListener("click", () => { n += 1; document.title = "clicks:" + n; });
</script></body></html>`;
}

function serve(withButton: boolean): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(fixturePage(withButton));
    });
    // 0.0.0.0 so the podman `--network=host` container reaches it on 127.0.0.1.
    server.listen(0, "0.0.0.0", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, url: `http://127.0.0.1:${port}/` });
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

describe.runIf(ENABLED)("browser click driver — REAL 100 clicks against a served fixture", () => {
  beforeAll(async () => {
    // Build the render-worker image (idempotent — layers cache) so the containerized runner
    // has a browser. A cold build (base image + npm install) streams progress and can exceed
    // vitest's default hook timeout, so the hook is given a generous ceiling — this is TEST
    // harness setup, outside the production timeout-eradication territory.
    await execFileAsync(PODMAN, [
      "build",
      "-t",
      process.env["TANREN_DS4_RENDER_IMAGE"] ?? DEFAULT_RENDER_WORKER_IMAGE,
      join(process.cwd(), "services/orchestrator/docker/render-worker"),
    ]);
  }, 600_000);

  it("DECISIVE: 100 real clicks on the fixture ⇒ exactly 100 confirmed observations (podman)", async () => {
    const { server, url } = await serve(true);
    try {
      const runner = buildPodmanBrowserClickRunner();
      const result = await runner.runClicks({ url, selector: SELECTOR, clicks: 100 });
      expect(result.ok).toBe(true);
      expect(result.ok ? result.observations.length : -1).toBe(100);
    } finally {
      await close(server);
    }
  });

  it("NEGATIVE CONTROL: a fixture WITHOUT the button ⇒ fail loud, no fabricated count (podman)", async () => {
    const { server, url } = await serve(false);
    try {
      const runner = buildPodmanBrowserClickRunner();
      const result = await runner.runClicks({ url, selector: SELECTOR, clicks: 100 });
      expect(result.ok).toBe(false);
    } finally {
      await close(server);
    }
  });
});

describe.runIf(ENABLED && INPROCESS)("browser click driver — in-process Playwright arm", () => {
  it("DECISIVE: 100 real clicks ⇒ exactly 100 confirmed observations (in-process)", async () => {
    const { server, url } = await serve(true);
    try {
      const runner = buildPlaywrightBrowserClickRunner({ launchArgs: ["--no-sandbox"] });
      const result = await runner.runClicks({ url, selector: SELECTOR, clicks: 100 });
      expect(result.ok).toBe(true);
      expect(result.ok ? result.observations.length : -1).toBe(100);
    } finally {
      await close(server);
    }
  });

  it("NEGATIVE CONTROL: absent button ⇒ fail loud (in-process)", async () => {
    const { server, url } = await serve(false);
    try {
      const runner = buildPlaywrightBrowserClickRunner({ launchArgs: ["--no-sandbox"] });
      const result = await runner.runClicks({ url, selector: SELECTOR, clicks: 100 });
      expect(result.ok).toBe(false);
    } finally {
      await close(server);
    }
  });
});
