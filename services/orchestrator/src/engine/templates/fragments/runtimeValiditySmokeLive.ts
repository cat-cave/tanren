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
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  type BundleInvoker,
  type CargoInvoker,
  type GoInvoker,
  type PipInvoker,
  type PnpmInvoker,
} from "./runtimeValiditySmoke.js";
import { parseCargoError, parseGoError, parsePipError, parsePnpmError } from "./runtimeValiditySmokeParsers.js";

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

/** Build the production `PipInvoker` — resolves a pyproject.toml (or a
 * requirements.txt when the scaffold produced one) against the operator's
 * host Python resolver.
 *
 * PREFERENCE ORDER:
 *   1. `uv pip compile pyproject.toml -o /dev/stdout` — the modern, fast
 *      option that resolves without needing a build backend. Preferred when
 *      `uv` is on PATH.
 *   2. `pip install --dry-run -r requirements.txt` — when the scaffold ships
 *      a requirements.txt.
 *   3. `pip install --dry-run --ignore-installed --no-build-isolation .` —
 *      the fallback for a pyproject-only scaffold on a host with pip but no
 *      uv. This requires a build backend so it's the slower + more brittle
 *      arm; the `uv pip compile` path is dramatically preferred.
 *
 * Returns `unavailable` when neither `uv` nor `pip` is on PATH so the caller
 * falls back to the shallow pyproject.toml sniff. No wall-clock kill timer
 * (feedback_no_timeouts_progress_based). */
export function buildLivePipInvoker(
  overrides: { readonly pipBinary?: string; readonly uvBinary?: string } = {},
): PipInvoker {
  const pipBinary = overrides.pipBinary ?? "pip";
  const uvBinary = overrides.uvBinary ?? "uv";
  return async ({ cwd, pyprojectPath }) => {
    const requirementsPath = join(cwd, "requirements.txt");
    const hasRequirements = existsSync(requirementsPath);
    const hasPyproject = existsSync(pyprojectPath);
    // Try uv first when available — no build backend needed.
    const uvResult = await tryUvPipCompile(uvBinary, cwd, hasPyproject, hasRequirements, requirementsPath);
    if (uvResult !== null) return uvResult;
    // Fall back to plain pip.
    const pipResult = await tryPipDryRun(pipBinary, cwd, hasRequirements, requirementsPath);
    if (pipResult !== null) return pipResult;
    return { kind: "unavailable" };
  };
}

async function tryUvPipCompile(
  uvBinary: string,
  cwd: string,
  hasPyproject: boolean,
  hasRequirements: boolean,
  requirementsPath: string,
): Promise<Awaited<ReturnType<PipInvoker>> | null> {
  const target = hasPyproject ? "pyproject.toml" : hasRequirements ? requirementsPath : null;
  if (target === null) return null;
  try {
    await execFileAsync(uvBinary, ["pip", "compile", "--quiet", "-o", "/dev/null", target], {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, CI: "true" },
    });
    return { kind: "ok" };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return null;
    return { kind: "failed", message: parsePipError(collectExecOutput(err)) };
  }
}

async function tryPipDryRun(
  pipBinary: string,
  cwd: string,
  hasRequirements: boolean,
  requirementsPath: string,
): Promise<Awaited<ReturnType<PipInvoker>> | null> {
  const args = hasRequirements
    ? ["install", "--dry-run", "--ignore-installed", "-r", requirementsPath]
    : ["install", "--dry-run", "--ignore-installed", "--no-build-isolation", "."];
  try {
    await execFileAsync(pipBinary, args, {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, CI: "true" },
    });
    return { kind: "ok" };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return null;
    return { kind: "failed", message: parsePipError(collectExecOutput(err)) };
  }
}

/** Build the production `GoInvoker` — runs `go mod download` in the manifest
 * directory. Returns `unavailable` when `go` is not on PATH. No wall-clock
 * kill timer (feedback_no_timeouts_progress_based). */
export function buildLiveGoInvoker(overrides: { readonly goBinary?: string } = {}): GoInvoker {
  const goBinary = overrides.goBinary ?? "go";
  return async ({ cwd }) => {
    try {
      await execFileAsync(goBinary, ["mod", "download"], {
        cwd,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, CI: "true" },
      });
      return { kind: "ok" };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") return { kind: "unavailable" };
      return { kind: "failed", message: parseGoError(collectExecOutput(err)) };
    }
  };
}

/** Build the production `CargoInvoker` — runs `cargo fetch` against the
 * manifest. Preferred over `cargo check` because it resolves + downloads deps
 * without compiling anything — faster + more targeted at the "does this
 * dependency exist" question this smoke asks. Returns `unavailable` when
 * `cargo` is not on PATH. No wall-clock kill timer
 * (feedback_no_timeouts_progress_based). */
export function buildLiveCargoInvoker(overrides: { readonly cargoBinary?: string } = {}): CargoInvoker {
  const cargoBinary = overrides.cargoBinary ?? "cargo";
  return async ({ cwd, cargoTomlPath }) => {
    try {
      await execFileAsync(cargoBinary, ["fetch", "--manifest-path", cargoTomlPath], {
        cwd,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, CI: "true" },
      });
      return { kind: "ok" };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") return { kind: "unavailable" };
      return { kind: "failed", message: parseCargoError(collectExecOutput(err)) };
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
