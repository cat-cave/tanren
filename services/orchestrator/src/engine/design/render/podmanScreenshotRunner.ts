// ds-4 Slice B — the REAL containerized screenshot runner.
//
// The orchestrator host (NixOS) cannot launch a prebuilt chromium (missing FHS
// libs), but it CAN run one INSIDE a container: podman is already the deploy
// substrate on this host, and Playwright's official image is bookworm/FHS so
// chromium launches there. This runner writes the scenario document to a host temp
// dir, bind-mounts it into the render-worker image, runs a Playwright chromium
// screenshot inside the container, and reads the REAL PNG bytes back off the host
// filesystem — sidestepping the host launch problem entirely.
//
// REUSE the `liveEnvBuildDriver` shape: `execFile` (no wall-clock timeout —
// feedback_no_timeouts_progress_based; a cold container pull/launch streams
// progress and is NEVER killed for elapsed time), a temp dir removed in a finally,
// and a LOUD fail-closed result on any non-zero exit / missing PNG. A blank or
// zero-length PNG is a FAILURE, never a silent pass.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../../observability/logger.js";
import {
  isRealPng,
  type PixelRenderRunner,
  type PixelScreenshotFailure,
  type PixelScreenshotResult,
  type PixelViewport,
} from "./pixelRenderContracts.js";

const execFileAsync = promisify(execFile);
const log = createLogger("ds4-pixel-runner");

/** The render-worker image tag. Built from `docker/render-worker/Dockerfile` (Playwright base + the `playwright` npm package). */
export const DEFAULT_RENDER_WORKER_IMAGE = "localhost/tanren-render-worker:local";
/** Where the screenshot script lives INSIDE the render-worker image (baked at build time). */
const CONTAINER_SCRIPT_PATH = "/app/screenshot.mjs";
/** The bind-mounted host↔container work dir; the runner writes page.html + reads out.png here. */
const CONTAINER_WORK_DIR = "/work";
const PAGE_FILE = "page.html";
const OUT_FILE = "out.png";

export interface PodmanScreenshotRunnerConfig {
  /** The podman binary (default `podman`; the orchestrator host resolves it on PATH). */
  readonly podmanBin?: string;
  /** The render-worker image ref (default {@link DEFAULT_RENDER_WORKER_IMAGE}). */
  readonly image?: string;
}

/**
 * The production {@link PixelRenderRunner}: a REAL containerized Playwright chromium
 * screenshot via podman. Fail-closed — a non-zero exit, a spawn error, a missing
 * out.png, or a non-PNG / trivially-small out.png all surface as an `ok: false`
 * failure the harness maps to `render_failed(browser)`. It NEVER returns a blank
 * screenshot as a success.
 */
export function buildPodmanScreenshotRunner(config: PodmanScreenshotRunnerConfig = {}): PixelRenderRunner {
  const podmanBin = config.podmanBin ?? process.env["TANREN_PODMAN_BIN"] ?? "podman";
  const image = config.image ?? process.env["TANREN_DS4_RENDER_IMAGE"] ?? DEFAULT_RENDER_WORKER_IMAGE;
  return {
    async screenshot(input: {
      readonly documentHtml: string;
      readonly viewport: PixelViewport;
    }): Promise<PixelScreenshotResult | PixelScreenshotFailure> {
      const dir = await mkdtemp(join(tmpdir(), "tanren-ds4-shot-"));
      const outPath = join(dir, OUT_FILE);
      try {
        await writeFile(join(dir, PAGE_FILE), input.documentHtml, "utf8");
        const args = [
          "run",
          "--rm",
          // `:Z` relabels the bind mount for SELinux hosts; a no-op elsewhere.
          "-v",
          `${dir}:${CONTAINER_WORK_DIR}:Z`,
          "-e",
          `PW_WIDTH=${input.viewport.width}`,
          "-e",
          `PW_HEIGHT=${input.viewport.height}`,
          image,
          "node",
          CONTAINER_SCRIPT_PATH,
        ];
        try {
          // NO wall-clock timeout: a cold image pull + chromium launch streams progress
          // and runs to its own terminal exit. A genuine non-zero exit surfaces below.
          await execFileAsync(podmanBin, args, { maxBuffer: 16 * 1024 * 1024 });
        } catch (error) {
          return failure(`podman screenshot run failed: ${describe(error)}`);
        }

        let png: Uint8Array;
        try {
          png = await readFile(outPath);
        } catch (error) {
          // Fail-closed: the browser exited 0 but produced no PNG — an absent artifact
          // is a failure, never a blank pass.
          return failure(`screenshot produced no readable out.png: ${describe(error)}`);
        }
        if (!isRealPng(png)) {
          return failure(`screenshot out.png is not a real PNG (byteLength=${png.byteLength})`);
        }
        log.info("captured containerized screenshot", { image, byteLength: png.byteLength });
        return { ok: true, png, viewport: input.viewport };
      } finally {
        await rm(dir, { recursive: true, force: true }).catch((error: unknown) => {
          log.warn("failed to remove ds4 screenshot temp dir", { dir }, error);
        });
      }
    },
  };
}

/**
 * Fail-closed infra probe: is the render worker actually runnable HERE? True only when
 * podman is on PATH AND the render-worker image exists locally (`podman image exists`
 * exits 0). Any spawn error / missing image → false, so an opted-in project whose
 * container infra is absent is judged INCONCLUSIVE (blocked), never a silent skip that
 * passes. NO wall-clock timeout — the probe is a single fast metadata check.
 */
export async function probeRenderWorkerAvailable(config: PodmanScreenshotRunnerConfig = {}): Promise<boolean> {
  const podmanBin = config.podmanBin ?? process.env["TANREN_PODMAN_BIN"] ?? "podman";
  const image = config.image ?? process.env["TANREN_DS4_RENDER_IMAGE"] ?? DEFAULT_RENDER_WORKER_IMAGE;
  try {
    await execFileAsync(podmanBin, ["image", "exists", image]);
    return true;
  } catch {
    return false;
  }
}

function failure(reason: string): PixelScreenshotFailure {
  return { ok: false, reason };
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
