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
 *     concern, not a validation reject,
 *   - `--config.dangerouslyAllowAllBuilds=true` — pnpm 10/11 blocks unapproved
 *     dependency build scripts by DEFAULT and exits non-zero with
 *     `ERR_PNPM_IGNORED_BUILDS`. This is a RESOLVABILITY smoke (see
 *     `runtimeValiditySmoke.ts`): the deps resolved fine — pnpm merely declined
 *     to run their postinstall/build scripts. Approving all builds
 *     non-interactively keeps a valid scaffold from being rejected on a
 *     warning-class condition. Safe because the smoke runs in a THROWAWAY temp
 *     dir (`runtimeValiditySmoke.ts` mkdtemp) — nothing here is ever shipped.
 *     NOT `--ignore-scripts`, which would MASK real script failures. As
 *     defense-in-depth, `parsePnpmError` also treats `ERR_PNPM_IGNORED_BUILDS`
 *     as non-fatal so a pnpm that doesn't honor the flag still doesn't reject.
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
        [
          "install",
          "--frozen-lockfile=false",
          "--prefer-offline",
          "--no-strict-peer-dependencies",
          "--config.dangerouslyAllowAllBuilds=true",
        ],
        {
          cwd,
          maxBuffer: 32 * 1024 * 1024,
          env: { ...process.env, CI: "true" },
        },
      );
      return { kind: "ok" };
    } catch (err) {
      const combined = collectExecOutput(err);
      // ERR_PNPM_IGNORED_BUILDS is a warning-class condition (deps resolved;
      // pnpm merely declined to run their build scripts), NOT a resolvability
      // failure — tolerate it even when the flag above wasn't honored.
      if (isIgnoredBuildsOnly(combined)) return { kind: "ok" };
      return { kind: "failed", message: parsePnpmError(combined) };
    }
  };
}

/** True when pnpm's combined output reports ONLY the ignored-build-scripts
 * warning (`ERR_PNPM_IGNORED_BUILDS`) with no accompanying resolvability error
 * code (e.g. `ERR_PNPM_NO_MATCHING_VERSION`, `ERR_PNPM_FETCH_404`). This is the
 * defense-in-depth guard for a pnpm that doesn't honor
 * `--config.dangerouslyAllowAllBuilds`: a scaffold whose deps resolved fine but
 * whose build scripts were skipped must NOT be rejected by this resolvability
 * smoke. A genuine resolvability failure that ALSO logs ignored builds still
 * carries its own `ERR_PNPM_*` code and stays fatal. */
function isIgnoredBuildsOnly(output: string): boolean {
  if (!output.includes("ERR_PNPM_IGNORED_BUILDS")) return false;
  const otherErr = output.replaceAll("ERR_PNPM_IGNORED_BUILDS", "").match(/ERR_PNPM_[A-Z0-9_]+/u);
  return otherErr === null;
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
 *   1. `uv pip compile pyproject.toml -o /dev/null` — the modern, fast
 *      option that resolves without needing a build backend. Preferred when
 *      `uv` is on PATH.
 *   2. `pip install --dry-run -r requirements.txt` — when the scaffold ships
 *      a requirements.txt.
 *   3. `pip install --dry-run --ignore-installed .` — the fallback for a
 *      pyproject-only scaffold on a host with pip but no uv. Runs with pip's
 *      default build-isolation so the declared build backend (hatchling /
 *      poetry-core / setuptools>=64 / etc.) is installed into an isolated env
 *      before the resolver runs. The `uv pip compile` path is dramatically
 *      preferred (no backend install needed at all) but this arm now Just
 *      Works against a modern pyproject.toml.
 *
 * `--no-build-isolation` was DROPPED (Codex round-III H6): with it, the
 * fallback ran pip against the operator's ambient env which almost never has
 * `hatchling` pre-installed — every valid pyproject.toml on a
 * uv-less host got rejected with "Cannot import 'hatchling.build'" and no
 * user-facing dep in the message. Letting pip build-isolate normally is
 * slower on first run (it downloads the backend into a temp env) but is
 * correct for every modern pyproject and preserves the "name the failing
 * dep" contract the parser relies on.
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
  // NB: `--no-build-isolation` was DROPPED from the pyproject arm (Codex
  // round-III H6). With it, pip needed the build backend (hatchling /
  // poetry-core / setuptools>=64) pre-installed in the ambient env — a
  // fresh temp dir with no venv setup does not, so every valid pyproject on
  // a uv-less host rejected with "Cannot import 'hatchling.build'" and named
  // no user-facing dep. Letting pip build-isolate normally installs the
  // declared backend into a temp env (slower first run, correct behavior).
  const args = hasRequirements
    ? ["install", "--dry-run", "--ignore-installed", "-r", requirementsPath]
    : ["install", "--dry-run", "--ignore-installed", "."];
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
