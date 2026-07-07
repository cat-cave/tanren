// LIVE (subprocess) wirings for the F2 runtime-validity smoke seams.
//
// Extracted from `runtimeValiditySmoke.ts` so the smoke module stays under the
// 500-line architecture cap AND stays free of a `node:child_process` import
// (the `no-host-process-spawn` invariant confines subprocess spawn to a small
// allowlisted set — this module is added to that allowlist because a fragment-
// validation spawn on the ORCHESTRATOR HOST is analogous to the env-image build
// spawn in `liveEnvBuildDriver.ts`: authoring-time validation, not workload
// execution over SSH).
//
// TIMEOUT DOCTRINE (feedback_no_timeouts_progress_based). The invokers run the
// subprocess to its own terminal exit — NO wall-clock kill timer. A working
// pnpm/bundle streams progress unbounded; kill only on evidence of death (exit
// code, spawn error). If an operator later wants a progress-based bound, the
// `ActivityWatchdog` + `retryUntilConverged` primitives are the idiomatic
// wrappers; nothing in this module reads elapsed time.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { parsePnpmError, type BundleInvoker, type PnpmInvoker } from "./runtimeValiditySmoke.js";

const execFileAsync = promisify(execFile);

/** Build the production `PnpmInvoker` — shells out to real pnpm in the given
 * cwd. Runs with the flags:
 *   - `--frozen-lockfile=false` — the composed scaffold doesn't ship a lockfile
 *     (fresh checkout) so the frozen mode would immediately fail,
 *   - `--prefer-offline` — reuses the cache when possible so a validation run
 *     doesn't re-download the world,
 *   - `--no-strict-peer-dependencies` — peer warnings are a writer's rework
 *     concern, not a validation reject.
 *
 * NO wall-clock kill timer (feedback_no_timeouts_progress_based). Errors are
 * parsed for the specific broken dep so the rejection message names WHICH dep
 * is unresolvable. */
export function buildLivePnpmInvoker(overrides: { readonly pnpmBinary?: string } = {}): PnpmInvoker {
  const pnpmBinary = overrides.pnpmBinary ?? "pnpm";
  return async ({ cwd }) => {
    try {
      await execFileAsync(
        pnpmBinary,
        ["install", "--frozen-lockfile=false", "--prefer-offline", "--no-strict-peer-dependencies"],
        {
          cwd,
          maxBuffer: 32 * 1024 * 1024,
          env: { ...process.env, CI: "true" },
        },
      );
      return { kind: "ok" };
    } catch (err) {
      const combined = collectExecOutput(err);
      return { kind: "failed", message: parsePnpmError(combined) };
    }
  };
}

/** Build the production `BundleInvoker` — shells out to real bundle. Returns
 * `unavailable` when the binary isn't on PATH so the caller falls back to the
 * lighter Gemfile syntax check. */
export function buildLiveBundleInvoker(overrides: { readonly bundleBinary?: string } = {}): BundleInvoker {
  const bundleBinary = overrides.bundleBinary ?? "bundle";
  return async ({ cwd, gemfilePath }) => {
    try {
      await execFileAsync(bundleBinary, ["check", `--gemfile=${gemfilePath}`], {
        cwd,
        maxBuffer: 4 * 1024 * 1024,
      });
      return { kind: "ok" };
    } catch (err) {
      // ENOENT (spawn error, no binary on PATH) → unavailable so the caller
      // falls back to the syntax check. Any other non-zero exit is a real
      // Gemfile problem and surfaces as failed.
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") return { kind: "unavailable" };
      const combined = collectExecOutput(err);
      return { kind: "failed", message: firstNonEmptyLine(combined) };
    }
  };
}

interface ExecErrorLike {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly message?: string;
}

/** Concatenate stdout + stderr + message from an exec error into a single
 * string the parser can scan. */
function collectExecOutput(err: unknown): string {
  const shaped = err as ExecErrorLike;
  const parts = [shaped.stdout ?? "", shaped.stderr ?? "", shaped.message ?? ""];
  return parts.filter((p) => p.length > 0).join("\n");
}

function firstNonEmptyLine(output: string): string {
  const line = output
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ?? "install failed with no output";
}
