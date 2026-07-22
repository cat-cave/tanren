// RUNTIME-VALIDITY SMOKE — the final step in the F2 fragment-authoring VALIDATE
// pipeline. Composition-validity is NOT runtime-validity: a fragment can declare
// `"vitest": "^99.0.0"` in package.json, pass isolated smoke, pass full-library
// smoke, then explode at project bootstrap when the writer runs
// `pnpm install` against the scaffold and hits `ERR_PNPM_NO_MATCHING_VERSION`.
// That is a full trial burned on a bug the fragment pipeline could have
// caught in seconds.
//
// This module runs AFTER the isolated + full-library smoke compositions and
// BEFORE persist: materialize the composed VFS into a temp dir, run the runtime's
// dependency resolver against it, and reject with an ACTIONABLE reason if the
// resolver fails ("no matching version for vitest ^99.0.0"), so the writer's
// next rework iteration sees the specific broken dep instead of a generic
// "install failed".
//
// SCOPE per runtime (v1 — the non-Node runtimes now have real resolver seams too;
// v0 shipped only the shallow manifest sniffs, which passed pyproject.toml with
// `fastapi==999.999.999`):
//   - node-pnpm: `pnpm install --frozen-lockfile=false --prefer-offline
//     --no-strict-peer-dependencies` in the temp dir. Errors are parsed for the
//     specific unresolved dep so the rejection names WHICH dep is broken.
//   - ruby-bundler: `bundle check --gemfile=<Gemfile>` when a `BundleInvoker` is
//     wired; else a lighter Gemfile syntax sanity check that flags obvious
//     regressions (missing `source`, malformed `gem` line).
//   - python: `uv pip compile pyproject.toml` (preferred — no build backend
//     needed) or `pip install --dry-run -r requirements.txt` when a `PipInvoker`
//     is wired. When unwired OR unavailable, falls back to the shallow
//     pyproject.toml sniff (structural sections + no leading-operator deps).
//   - go: `go mod download` in the manifest dir when a `GoInvoker` is wired.
//     When unwired OR unavailable, falls back to the shallow go.mod sniff.
//   - rust: `cargo fetch --manifest-path <path>` when a `CargoInvoker` is wired.
//     When unwired OR unavailable, falls back to the shallow Cargo.toml sniff.
//   - unrecognized runtime: skipped with an explicit log so a maintainer can see
//     which fragments never hit the runtime-validity gate.
//
// TIMEOUT DOCTRINE (feedback_no_timeouts_progress_based). The `PnpmInvoker` seam
// runs the subprocess to its own terminal exit — NO wall-clock kill timer. A
// working pnpm install streams progress unbounded; kill only on evidence of
// death (exit code, spawn error). If an operator later wants a progress-based
// bound, the `ActivityWatchdog` + `retryUntilConverged` primitives are the
// idiomatic wrappers; nothing in this module reads elapsed time.
//
// TEST SEAM. Both `PnpmInvoker` and `BundleInvoker` are injected. Production
// wires `buildLivePnpmInvoker` / `buildLiveBundleInvoker` (below) which shell
// out to real pnpm / bundle. Tests inject a fake that returns canned results
// so `just fast-check` never spawns an actual package manager.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createLogger } from "../../observability/logger.js";
import { composeTemplate } from "./compose.js";
import { loadFragmentLibrary } from "./library/index.js";
import { deriveRuntimeLanguage, type SupportedRuntimeLanguage } from "./runtimeLanguage.js";
import type { FragmentSpec } from "./selectFragmentConfig.js";
import { configForFullLibrarySmoke } from "./smokeComposition.js";
import type { SmokeResult } from "./smokeComposition.js";
import {
  checkCargoManifest,
  checkGemfileSyntax,
  checkGoModManifest,
  checkPythonManifest,
} from "./runtimeValiditySmokeSniffs.js";
import { type Fragment, type FragmentLibrary, type VirtualFileSystem } from "./types.js";

// Re-export the parsers so callers of this module get them at the historical
// import path. The parser bodies live in `runtimeValiditySmokeParsers.ts` to
// keep this file under the 500-line architecture cap.
export { parseCargoError, parseGoError, parsePipError, parsePnpmError } from "./runtimeValiditySmokeParsers.js";

const log = createLogger("fragment-runtime-validity-smoke");

// ── Invoker seams ───────────────────────────────────────────────────────────

/** Input to the pnpm invoker — just the working directory to run in. The
 * composed scaffold has already been materialized into `cwd` before this call. */
export interface PnpmInvokerInput {
  readonly cwd: string;
}

/** Outcome of a pnpm install invocation. `failed.message` is a single-line
 * summary suitable for the fragment writer's rejection feedback — the seam
 * (not the caller) parses pnpm's stderr for the specific broken dep. */
export type PnpmInvokerResult = { readonly kind: "ok" } | { readonly kind: "failed"; readonly message: string };

/** The pnpm subprocess seam. Production wires this to `buildLivePnpmInvoker`;
 * tests inject a canned fake. The invoker runs the install to its own terminal
 * exit — NO wall-clock kill (feedback_no_timeouts_progress_based). */
export type PnpmInvoker = (input: PnpmInvokerInput) => Promise<PnpmInvokerResult>;

/** Input to the bundler invoker. The Gemfile has been materialized into `cwd`. */
export interface BundleInvokerInput {
  readonly cwd: string;
  readonly gemfilePath: string;
}

/** Outcome of a `bundle check` invocation. `unavailable` triggers the fallback
 * lighter syntax check when the operator's host has no bundle on PATH. */
export type BundleInvokerResult =
  | { readonly kind: "ok" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "unavailable" };

/** The bundle subprocess seam. Production wires this to `buildLiveBundleInvoker`;
 * tests inject a canned fake. Optional — when omitted, the Gemfile syntax
 * fallback runs. */
export type BundleInvoker = (input: BundleInvokerInput) => Promise<BundleInvokerResult>;

/** Input to the pip invoker. The pyproject.toml (and any requirements.txt the
 * scaffold produced) has been materialized into `cwd`. */
export interface PipInvokerInput {
  readonly cwd: string;
  readonly pyprojectPath: string;
}

/** Outcome of a `pip install --dry-run` / `uv pip compile` invocation. Same
 * three-arm union as the bundle invoker: `unavailable` (no `pip`/`uv` on PATH)
 * triggers the fallback shallow manifest check. */
export type PipInvokerResult =
  | { readonly kind: "ok" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "unavailable" };

/** The pip subprocess seam. Production wires this to `buildLivePipInvoker`;
 * tests inject a canned fake. Optional — when omitted, the pyproject.toml
 * shallow sniff runs. */
export type PipInvoker = (input: PipInvokerInput) => Promise<PipInvokerResult>;

/** Input to the go invoker. The go.mod is at `cwd`. */
export interface GoInvokerInput {
  readonly cwd: string;
  readonly gomodPath: string;
}

/** Outcome of a `go mod download` invocation. Same three-arm union as bundle
 * / pip. */
export type GoInvokerResult =
  | { readonly kind: "ok" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "unavailable" };

/** The go subprocess seam. Production wires this to `buildLiveGoInvoker`;
 * tests inject a canned fake. Optional — when omitted, the go.mod shallow
 * sniff runs. */
export type GoInvoker = (input: GoInvokerInput) => Promise<GoInvokerResult>;

/** Input to the cargo invoker. The Cargo.toml is at `cwd`. */
export interface CargoInvokerInput {
  readonly cwd: string;
  readonly cargoTomlPath: string;
}

/** Outcome of a `cargo fetch` invocation. Same three-arm union as bundle /
 * pip / go. */
export type CargoInvokerResult =
  | { readonly kind: "ok" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "unavailable" };

/** The cargo subprocess seam. Production wires this to `buildLiveCargoInvoker`;
 * tests inject a canned fake. Optional — when omitted, the Cargo.toml shallow
 * sniff runs. */
export type CargoInvoker = (input: CargoInvokerInput) => Promise<CargoInvokerResult>;

/** Deps the runtime-validity smoke is built with — one invoker seam per runtime
 * so the production wiring can hand in real subprocess spawners while tests
 * hand in canned fakes. Only `pnpmInvoker` is required (the historical Node-only
 * v0 gate); the four others are optional — when omitted OR `unavailable`, the
 * shallow manifest-sniff fallback runs for that runtime. */
export interface RuntimeValiditySmokeDeps {
  readonly pnpmInvoker: PnpmInvoker;
  readonly bundleInvoker?: BundleInvoker;
  readonly pipInvoker?: PipInvoker;
  readonly goInvoker?: GoInvoker;
  readonly cargoInvoker?: CargoInvoker;
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Run the runtime-validity smoke against an authored fragment. Returns
 * `{ kind: "ok" }` when the fragment's declared dependencies + manifest are
 * resolvable (or the runtime is unrecognized and the check is skipped); returns
 * `{ kind: "failed", reason }` with an ACTIONABLE reason naming the specific
 * broken dep when the runtime's resolver rejects the composed scaffold.
 *
 * The composed VFS is materialized into an OS temp dir the caller never sees —
 * the dir is removed in a `finally` regardless of outcome. */
export async function runRuntimeValiditySmoke(args: {
  readonly spec: FragmentSpec;
  readonly fragment: Fragment;
  readonly derivedDependsOn: readonly string[];
  readonly deps: RuntimeValiditySmokeDeps;
}): Promise<SmokeResult> {
  const { spec, fragment, derivedDependsOn, deps } = args;

  // COMPOSE — use the full-library config (the fuller of the two smokes) so
  // the runtime resolver sees the SAME set of deps the operator's real project
  // would compose against.
  const library = buildLibraryWithAuthored(fragment);
  const config = configForFullLibrarySmoke(spec, fragment);

  const runtime = classifyRuntime(config.runtime);
  if (runtime === null) {
    log.info("runtime-validity smoke skipped — unrecognized runtime language", {
      fragmentId: fragment.id,
      specId: spec.id,
      runtimeLabel: config.runtime,
    });
    return { kind: "ok", dependsOn: derivedDependsOn };
  }

  let vfs: VirtualFileSystem;
  try {
    vfs = await composeTemplate(config, library);
  } catch (err) {
    return {
      kind: "failed",
      reason: `runtime-validity smoke compose failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const dir = await mkdtemp(join(tmpdir(), `tanren-runtime-validity-${sanitizeSpecId(spec.id)}-`));
  try {
    await materializeVfsToDir(vfs, dir);
    switch (runtime) {
      case "ts":
        return await checkNodePnpm(deps, dir, derivedDependsOn);
      case "ruby":
        return await checkRubyBundler(deps, dir, derivedDependsOn);
      case "go":
        return await checkGo(deps, dir, derivedDependsOn);
      case "python":
        return await checkPython(deps, dir, derivedDependsOn);
      case "rust":
        return await checkRust(deps, dir, derivedDependsOn);
      /* c8 ignore next 2 -- exhaustive check on the union */
      default:
        return { kind: "ok", dependsOn: derivedDependsOn };
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch((err: unknown) => {
      log.warn("failed to remove runtime-validity smoke temp dir", { dir }, err);
    });
  }
}

// ── Runtime checks ──────────────────────────────────────────────────────────

async function checkNodePnpm(
  deps: RuntimeValiditySmokeDeps,
  cwd: string,
  derivedDependsOn: readonly string[],
): Promise<SmokeResult> {
  const result = await deps.pnpmInvoker({ cwd });
  if (result.kind === "ok") return { kind: "ok", dependsOn: derivedDependsOn };
  return {
    kind: "failed",
    reason: `runtime-validity smoke rejected: pnpm install rejected: ${result.message}`,
  };
}

async function checkRubyBundler(
  deps: RuntimeValiditySmokeDeps,
  cwd: string,
  derivedDependsOn: readonly string[],
): Promise<SmokeResult> {
  const gemfilePath = join(cwd, "Gemfile");
  if (deps.bundleInvoker !== undefined) {
    const result = await deps.bundleInvoker({ cwd, gemfilePath });
    if (result.kind === "ok") return { kind: "ok", dependsOn: derivedDependsOn };
    if (result.kind === "failed") {
      return {
        kind: "failed",
        reason: `runtime-validity smoke rejected: bundle check rejected: ${result.message}`,
      };
    }
    // unavailable → fall through to the lighter syntax check.
    log.info("bundle unavailable on host — falling back to Gemfile syntax sanity check", { cwd });
  }
  return checkGemfileSyntax(cwd, derivedDependsOn);
}

async function checkGo(
  deps: RuntimeValiditySmokeDeps,
  cwd: string,
  derivedDependsOn: readonly string[],
): Promise<SmokeResult> {
  const gomodPath = join(cwd, "go.mod");
  if (deps.goInvoker !== undefined) {
    const result = await deps.goInvoker({ cwd, gomodPath });
    if (result.kind === "ok") return { kind: "ok", dependsOn: derivedDependsOn };
    if (result.kind === "failed") {
      return {
        kind: "failed",
        reason: `runtime-validity smoke rejected: go mod download rejected: ${result.message}`,
      };
    }
    // unavailable → fall through to the shallow manifest sniff.
    log.info("go unavailable on host — falling back to go.mod shallow sniff", { cwd });
  }
  return checkGoModManifest(cwd, derivedDependsOn);
}

async function checkPython(
  deps: RuntimeValiditySmokeDeps,
  cwd: string,
  derivedDependsOn: readonly string[],
): Promise<SmokeResult> {
  const pyprojectPath = join(cwd, "pyproject.toml");
  if (deps.pipInvoker !== undefined) {
    const result = await deps.pipInvoker({ cwd, pyprojectPath });
    if (result.kind === "ok") return { kind: "ok", dependsOn: derivedDependsOn };
    if (result.kind === "failed") {
      return {
        kind: "failed",
        reason: `runtime-validity smoke rejected: pip install rejected: ${result.message}`,
      };
    }
    // unavailable → fall through to the shallow manifest sniff.
    log.info("pip/uv unavailable on host — falling back to pyproject.toml shallow sniff", { cwd });
  }
  return checkPythonManifest(cwd, derivedDependsOn);
}

async function checkRust(
  deps: RuntimeValiditySmokeDeps,
  cwd: string,
  derivedDependsOn: readonly string[],
): Promise<SmokeResult> {
  const cargoTomlPath = join(cwd, "Cargo.toml");
  if (deps.cargoInvoker !== undefined) {
    const result = await deps.cargoInvoker({ cwd, cargoTomlPath });
    if (result.kind === "ok") return { kind: "ok", dependsOn: derivedDependsOn };
    if (result.kind === "failed") {
      return {
        kind: "failed",
        reason: `runtime-validity smoke rejected: cargo fetch rejected: ${result.message}`,
      };
    }
    // unavailable → fall through to the shallow manifest sniff.
    log.info("cargo unavailable on host — falling back to Cargo.toml shallow sniff", { cwd });
  }
  return checkCargoManifest(cwd, derivedDependsOn);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function buildLibraryWithAuthored(fragment: Fragment): FragmentLibrary {
  const library = loadFragmentLibrary();
  if (library.has(fragment.id)) {
    library.replaceForTests(fragment);
  } else {
    library.register(fragment);
  }
  return library;
}

/** Map the composed config's runtime LABEL to the recognized language head.
 * Returns null when unrecognized (⇒ the caller skips with a log). */
function classifyRuntime(runtimeLabel: string): SupportedRuntimeLanguage | null {
  return deriveRuntimeLanguage(runtimeLabel);
}

function sanitizeSpecId(id: string): string {
  return id.replaceAll(/[^A-Za-z0-9_.-]/gu, "-");
}

/** Materialize a VFS's flat-map into the target directory. Creates intermediate
 * directories as needed. Async, per-file writes (small VFS, single-digit ms). */
async function materializeVfsToDir(vfs: VirtualFileSystem, dir: string): Promise<void> {
  const flat = vfs.toFlatMap();
  for (const path of Object.keys(flat)) {
    const absPath = join(dir, path);
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, flat[path] ?? "");
  }
}
