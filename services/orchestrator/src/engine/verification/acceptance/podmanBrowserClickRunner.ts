// rv-26.6 — the REAL containerized browser click runner.
//
// The orchestrator host (Nix) cannot launch a prebuilt chromium (missing FHS libs), but
// it CAN run one INSIDE the render-worker container (Playwright's bookworm/FHS image),
// exactly as `podmanScreenshotRunner` does for ds-4 screenshots. This runner writes the
// click params to a host temp dir, bind-mounts it into the render-worker image, runs
// `node /app/clickDriver.mjs` inside the container (which navigates + clicks), and reads
// back the count of CONFIRMED clicks off the host filesystem.
//
// REUSE the `podmanScreenshotRunner` shape: `execFile` (NO wall-clock timeout — a cold
// container pull/launch streams progress and is never killed for elapsed time), a temp
// dir removed in a finally, and a LOUD fail-closed result on any non-zero exit / missing
// or short result. `--network=host` lets the container reach the served URL — a public
// deployed dashboard or a local fixture on 127.0.0.1 in tests.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../../observability/logger.js";
import { DEFAULT_RENDER_WORKER_IMAGE } from "../../design/render/podmanScreenshotRunner.js";
import {
  confirmedClickObservations,
  type BrowserClickRunInput,
  type BrowserClickRunResult,
  type BrowserClickRunner,
} from "./browserClickRunner.js";

const execFileAsync = promisify(execFile);
const log = createLogger("rv26-browser-click-runner");

/** Where the click script lives INSIDE the render-worker image (baked at build time). */
const CONTAINER_SCRIPT_PATH = "/app/clickDriver.mjs";
/** The bind-mounted host↔container work dir; the runner writes params.json + reads result.json here. */
const CONTAINER_WORK_DIR = "/work";
const PARAMS_FILE = "params.json";
const RESULT_FILE = "result.json";

export interface PodmanBrowserClickRunnerConfig {
  /** The podman binary (default `podman`; resolved on PATH / `TANREN_PODMAN_BIN`). */
  readonly podmanBin?: string;
  /** The render-worker image ref (default {@link DEFAULT_RENDER_WORKER_IMAGE}). */
  readonly image?: string;
}

/**
 * The production {@link BrowserClickRunner}: a REAL containerized Playwright chromium
 * driven via podman. Fail-closed — a non-zero exit, a spawn error, a missing/unreadable
 * result.json, or an `observed` count that does not EXACTLY equal the requested clicks all
 * surface as `{ ok: false }`. It NEVER returns a short or fabricated click count.
 */
export function buildPodmanBrowserClickRunner(config: PodmanBrowserClickRunnerConfig = {}): BrowserClickRunner {
  const podmanBin = config.podmanBin ?? process.env["TANREN_PODMAN_BIN"] ?? "podman";
  const image = config.image ?? process.env["TANREN_DS4_RENDER_IMAGE"] ?? DEFAULT_RENDER_WORKER_IMAGE;
  return {
    async runClicks(input: BrowserClickRunInput): Promise<BrowserClickRunResult> {
      if (!Number.isInteger(input.clicks) || input.clicks < 1) {
        return { ok: false, kind: "click", reason: `invalid click count ${String(input.clicks)}` };
      }
      const dir = await mkdtemp(join(tmpdir(), "tanren-rv26-click-"));
      const resultPath = join(dir, RESULT_FILE);
      try {
        await writeFile(
          join(dir, PARAMS_FILE),
          JSON.stringify({ url: input.url, selector: input.selector, clicks: input.clicks }),
          "utf8",
        );
        const args = [
          "run",
          "--rm",
          // `--network=host` so the container reaches the served URL (public deploy or a
          // local fixture on 127.0.0.1); `:Z` relabels the bind mount for SELinux hosts.
          "--network=host",
          "-v",
          `${dir}:${CONTAINER_WORK_DIR}:Z`,
          image,
          "node",
          CONTAINER_SCRIPT_PATH,
        ];
        try {
          // NO wall-clock timeout: a cold image pull + chromium launch + N clicks streams
          // progress and runs to its own terminal exit. A genuine failure surfaces below.
          await execFileAsync(podmanBin, args, { maxBuffer: 16 * 1024 * 1024 });
        } catch (error) {
          return { ok: false, kind: "launch", reason: `podman click run failed: ${describe(error)}` };
        }

        let observed: number;
        try {
          const parsed: unknown = JSON.parse(await readFile(resultPath, "utf8"));
          observed = readObserved(parsed);
        } catch (error) {
          // Fail-closed: the container exited 0 but produced no readable count — an absent
          // result is a failure, never a blank pass.
          return { ok: false, kind: "click", reason: `click run produced no readable result.json: ${describe(error)}` };
        }
        if (observed !== input.clicks) {
          // Proof≠effect divergence guard: the count the container reports must EXACTLY
          // equal the requested clicks — a short count is a failure, never laundered.
          return {
            ok: false,
            kind: "click",
            reason: `observed ${String(observed)} clicks but requested ${String(input.clicks)}`,
          };
        }
        log.info("completed containerized click run", { image, observed });
        return { ok: true, observations: confirmedClickObservations(observed) };
      } finally {
        await rm(dir, { recursive: true, force: true }).catch((error: unknown) => {
          log.warn("failed to remove rv26 click temp dir", { dir }, error);
        });
      }
    },
  };
}

/** Read the `observed` integer from the container's result.json, or throw loud on a bad shape. */
function readObserved(parsed: unknown): number {
  if (typeof parsed !== "object" || parsed === null || !("observed" in parsed)) {
    throw new Error("result.json missing an 'observed' count");
  }
  const value = (parsed as { readonly observed: unknown }).observed;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`result.json 'observed' is not a non-negative integer: ${String(value)}`);
  }
  return value;
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
