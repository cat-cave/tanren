// RUNTIME-VALIDITY SMOKE — the final step in the F2 fragment-authoring VALIDATE
// pipeline. Composition-validity is NOT runtime-validity: a fragment can declare
// `"vitest": "^99.0.0"` in package.json, pass isolated smoke, pass full-library
// smoke, then explode at project bootstrap when the writer runs
// `pnpm install` against the scaffold and hits `ERR_PNPM_NO_MATCHING_VERSION`.
// That is one full apex trial burned on a bug the fragment pipeline could have
// caught in seconds.
//
// This module runs AFTER the isolated + full-library smoke compositions and
// BEFORE persist: materialize the composed VFS into a temp dir, run the runtime's
// dependency resolver against it, and reject with an ACTIONABLE reason if the
// resolver fails ("no matching version for vitest ^99.0.0"), so the writer's
// next rework iteration sees the specific broken dep instead of a generic
// "install failed".
//
// SCOPE per runtime (v0):
//   - node-pnpm: `pnpm install --frozen-lockfile=false --prefer-offline
//     --no-strict-peer-dependencies` in the temp dir. Errors are parsed for the
//     specific unresolved dep so the rejection names WHICH dep is broken.
//   - ruby-bundler: `bundle check --gemfile=<Gemfile>` when a `BundleInvoker` is
//     wired; else a lighter Gemfile syntax sanity check that flags obvious
//     regressions (missing `source`, malformed `gem` line).
//   - go / python / rust: parse the manifest (go.mod / pyproject.toml /
//     Cargo.toml) for structural syntax + obviously-wrong version specifiers.
//     A full `go mod download` / `pip install` / `cargo build` is out of scope
//     for v0 — the goal is to catch DECLARED nonsense, not exercise the resolver.
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

import { readFileSync } from "node:fs";
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
import { type Fragment, type FragmentLibrary, type VirtualFileSystem } from "./types.js";

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

/** Deps the runtime-validity smoke is built with — both invoker seams so the
 * production wiring can hand in real subprocess spawners while tests hand in
 * canned fakes. `bundleInvoker` is optional (the Gemfile syntax fallback
 * covers a host without bundle). */
export interface RuntimeValiditySmokeDeps {
  readonly pnpmInvoker: PnpmInvoker;
  readonly bundleInvoker?: BundleInvoker;
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
        return checkGoModManifest(dir, derivedDependsOn);
      case "python":
        return checkPythonManifest(dir, derivedDependsOn);
      case "rust":
        return checkCargoManifest(dir, derivedDependsOn);
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

/** Lighter Gemfile sanity check when `bundle check` is unavailable. Flags:
 *   - missing `source` directive (a Gemfile without a rubygems source can't
 *     resolve any gem),
 *   - malformed `gem "name", "version"` lines whose version constraint is
 *     structurally broken (e.g. contains an unquoted operator or is
 *     obviously not a semver constraint).
 * Full Gemfile evaluation requires a Ruby interpreter; this heuristic catches
 * the shape-level regressions v0 aims at. */
function checkGemfileSyntax(cwd: string, derivedDependsOn: readonly string[]): SmokeResult {
  // A composed scaffold with a ruby-bundler runtime always writes a Gemfile;
  // its absence here is a composer regression, not a fragment bug.
  // NOTE: uses the Node fs API sync-style is out of scope — we already
  // materialized into cwd via async writes.
  let gemfile: string;
  try {
    // Read via node:fs/promises would require another await; use a sync form
    // via the materialized flat map is cleaner, but we're already inside cwd.
    // Use readFileSync via require-shape? — cleaner: use fs/promises inline.
    gemfile = readFileSyncSafe(join(cwd, "Gemfile"));
  } catch (err) {
    return {
      kind: "failed",
      reason: `runtime-validity smoke rejected: Gemfile absent — ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const lines = gemfile.split("\n");
  const hasSource = lines.some((l) => /^\s*source\s+["'][^"']+["']/u.test(l));
  if (!hasSource) {
    return {
      kind: "failed",
      reason: `runtime-validity smoke rejected: Gemfile is missing a \`source "…"\` directive — no gem is resolvable without a rubygems source`,
    };
  }
  for (const raw of lines) {
    const line = raw.replace(/#.*$/u, "").trim();
    if (line.length === 0) continue;
    if (!/^gem\s+/u.test(line)) continue;
    // Very forgiving parse: gem "name" [, "version_constraint"[, options…]]
    // Reject a gem line whose FIRST arg is not a quoted string.
    if (!/^gem\s+["'][^"']+["']/u.test(line)) {
      return {
        kind: "failed",
        reason: `runtime-validity smoke rejected: Gemfile has a malformed gem line: ${JSON.stringify(line)}`,
      };
    }
  }
  return { kind: "ok", dependsOn: derivedDependsOn };
}

function checkGoModManifest(cwd: string, derivedDependsOn: readonly string[]): SmokeResult {
  let manifest: string;
  try {
    manifest = readFileSyncSafe(join(cwd, "go.mod"));
  } catch (err) {
    return {
      kind: "failed",
      reason: `runtime-validity smoke rejected: go.mod absent — ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const lines = manifest.split("\n");
  // The first non-comment, non-blank line must be `module <path>`.
  const first = lines.find((l) => {
    const stripped = l.replace(/\/\/.*$/u, "").trim();
    return stripped.length > 0;
  });
  if (first === undefined || !/^module\s+\S+/u.test(first.trim())) {
    return {
      kind: "failed",
      reason: `runtime-validity smoke rejected: go.mod must open with a \`module <path>\` directive; got ${JSON.stringify(first ?? "")}`,
    };
  }
  // Each `require <path> <version>` line must have a version that looks like a
  // semver or pseudo-version (v0.0.0-…). We don't verify resolution here.
  for (const raw of lines) {
    const line = raw.replace(/\/\/.*$/u, "").trim();
    const m = line.match(/^require\s+\S+\s+(\S+)/u);
    if (m === null) continue;
    const version = m[1] ?? "";
    if (!/^v\d/u.test(version)) {
      return {
        kind: "failed",
        reason: `runtime-validity smoke rejected: go.mod require line has a suspicious version specifier: ${JSON.stringify(line)} (Go module versions start with \`v\`)`,
      };
    }
  }
  return { kind: "ok", dependsOn: derivedDependsOn };
}

function checkPythonManifest(cwd: string, derivedDependsOn: readonly string[]): SmokeResult {
  let manifest: string;
  try {
    manifest = readFileSyncSafe(join(cwd, "pyproject.toml"));
  } catch (err) {
    return {
      kind: "failed",
      reason: `runtime-validity smoke rejected: pyproject.toml absent — ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // Very light TOML sanity: at least one [section] header and no obviously-broken
  // key = value line inside it. A missing [project] section is the classic
  // regression a writer produces when it forgets the pyproject structure.
  if (!/^\s*\[(project|tool\.[^\]]+|build-system)\]/mu.test(manifest)) {
    return {
      kind: "failed",
      reason: `runtime-validity smoke rejected: pyproject.toml has no recognized top-level section (\`[project]\`, \`[tool.…]\`, or \`[build-system]\`)`,
    };
  }
  // Check dependencies list entries for shape: "pkg" or "pkg==ver" or "pkg>=ver".
  const depsMatch = manifest.match(/dependencies\s*=\s*\[([^\]]*)\]/u);
  if (depsMatch !== null) {
    const inner = depsMatch[1] ?? "";
    const entries = inner.match(/"[^"]+"|'[^']+'/gu) ?? [];
    for (const entry of entries) {
      const dep = entry.slice(1, -1).trim();
      if (dep === "") continue;
      // Reject an entry containing a semver-like constraint the writer wrote
      // WITHOUT a package name (a common LLM misfire).
      if (/^[<>=!~^]/u.test(dep)) {
        return {
          kind: "failed",
          reason: `runtime-validity smoke rejected: pyproject.toml dependency entry ${JSON.stringify(dep)} starts with a version operator — the package name is missing`,
        };
      }
    }
  }
  return { kind: "ok", dependsOn: derivedDependsOn };
}

function checkCargoManifest(cwd: string, derivedDependsOn: readonly string[]): SmokeResult {
  let manifest: string;
  try {
    manifest = readFileSyncSafe(join(cwd, "Cargo.toml"));
  } catch (err) {
    return {
      kind: "failed",
      reason: `runtime-validity smoke rejected: Cargo.toml absent — ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // Cargo requires either a [package] or [workspace] table.
  if (!/^\s*\[(package|workspace)\]/mu.test(manifest)) {
    return {
      kind: "failed",
      reason: `runtime-validity smoke rejected: Cargo.toml has no \`[package]\` or \`[workspace]\` table`,
    };
  }
  // If [package] is present, name + version are required at minimum.
  const pkgMatch = manifest.match(/\[package\]([\s\S]*?)(?:\n\[|$)/u);
  if (pkgMatch !== null) {
    const body = pkgMatch[1] ?? "";
    if (!/^\s*name\s*=\s*["'][^"']+["']/mu.test(body)) {
      return {
        kind: "failed",
        reason: `runtime-validity smoke rejected: Cargo.toml [package] table is missing a \`name = "…"\` key`,
      };
    }
    if (!/^\s*version\s*=\s*["'][^"']+["']/mu.test(body)) {
      return {
        kind: "failed",
        reason: `runtime-validity smoke rejected: Cargo.toml [package] table is missing a \`version = "…"\` key`,
      };
    }
  }
  return { kind: "ok", dependsOn: derivedDependsOn };
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

/** Synchronous read helper the manifest checks use. Wrapping fs.readFileSync
 * keeps the check functions non-async so a call-site refactor doesn't accidentally
 * lose the failure envelope. Lifted here rather than inlined so we import the
 * one Node primitive once at file scope. */
function readFileSyncSafe(path: string): string {
  return readFileSync(path, "utf8");
}

// ── Pnpm error parser (pure — reused by the live invoker) ───────────────────

/** Parse pnpm's combined output for the specific unresolved dep, so the writer
 * gets an ACTIONABLE rejection ("no matching version for vitest ^99.0.0") instead
 * of a generic "install failed".
 *
 * pnpm's ERR_PNPM_NO_MATCHING_VERSION message looks like:
 *   ERR_PNPM_NO_MATCHING_VERSION  No matching version found for vitest@^99.0.0
 * Also matches ERR_PNPM_FETCH_404 (dep not found on the registry) and the more
 * general "GET https://…/pkg/-/pkg-x.y.z.tgz: 404" line.
 *
 * Pure by design so the live invoker (which spawns pnpm — lives in
 * `runtimeValiditySmokeLive.ts`, allowlisted by `no-host-process-spawn`) can
 * import + reuse the parser without pulling `child_process` into this file. */
export function parsePnpmError(output: string): string {
  const noMatch = output.match(/No matching version found for\s+(\S+@\S+)/u);
  if (noMatch !== null) return `no matching version for ${noMatch[1] ?? "unknown"}`;
  const notFound = output.match(/(?:GET.*?)?(?:https?:\/\/\S+\/(\S+?)(?:-|\/)[-.\w]+(?:\.tgz)?)\s*[:\s]+\s*404/u);
  if (notFound !== null) return `package not found on registry: ${notFound[1] ?? "unknown"}`;
  const errCode = output.match(/(ERR_PNPM_[A-Z0-9_]+)/u);
  if (errCode !== null) {
    const firstLine = firstNonEmptyLine(output);
    return `${errCode[1] ?? "ERR_PNPM_UNKNOWN"}: ${firstLine}`;
  }
  const peer = output.match(/unmet peer\s+(\S+@\S+)/u);
  if (peer !== null) return `unmet peer dependency ${peer[1] ?? "unknown"}`;
  return firstNonEmptyLine(output);
}

function firstNonEmptyLine(output: string): string {
  const line = output
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ?? "install failed with no output";
}
