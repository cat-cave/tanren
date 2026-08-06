import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// NEGATIVE CONTROL for the render-worker entrypoint's fail-closed locale guard.
//
// `docker/render-worker/screenshot.mjs` runs INSIDE the container; `PW_LOCALE` is the
// scenario's locale, DECLARED by the host `podmanScreenshotRunner`. A missing PW_LOCALE
// is a wiring fault, and the entrypoint must fail closed (non-zero exit) rather than
// silently fall back to the container's C-family default (host-architecture-dependent —
// an arm64 chromium reports `en-US@posix`, invalid BCP-47, throws in `Intl`).
//
// The seam/markup assertions live in pixelRenderCaptureHarness.test.ts (they pin that the
// locale reaches the browser context and `<html lang>`). This test pins the LAST line of
// defense: run the real entrypoint with PW_LOCALE OMITTED and assert it exits non-zero
// with the DS4_SHOT_NO_LOCALE marker. The guard runs before any I/O or loading playwright,
// so this stays a host-runnable always-on test (no container, no browser package).

const execFileAsync = promisify(execFile);
const SCRIPT = join(import.meta.dirname, "..", "docker", "render-worker", "screenshot.mjs");

describe("render-worker screenshot.mjs entrypoint", () => {
  it("FAIL-CLOSED: a missing PW_LOCALE exits non-zero with DS4_SHOT_NO_LOCALE", async () => {
    // Deliberately do NOT forward the ambient env — PW_LOCALE must be absent.
    const env: Record<string, string> = { PATH: process.env.PATH ?? "" };
    const result = await execFileAsync(process.execPath, [SCRIPT], { env }).then(
      () => ({ code: 0, stderr: "" }),
      (error: { code?: number; stderr?: string }) => ({
        code: error.code ?? 0,
        stderr: error.stderr ?? "",
      }),
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("DS4_SHOT_NO_LOCALE");
  });
});
