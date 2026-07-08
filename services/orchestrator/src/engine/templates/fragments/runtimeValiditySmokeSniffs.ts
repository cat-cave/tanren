// SHALLOW MANIFEST SNIFFS for the F2 runtime-validity smoke — the fallback path
// when the runtime's live invoker (`PipInvoker` / `GoInvoker` / `CargoInvoker`
// / `BundleInvoker`) is either UNWIRED or reports `unavailable` (no resolver
// binary on the host).
//
// Extracted from `runtimeValiditySmoke.ts` to keep both files under the
// 500-line architecture cap. These are HEURISTICS — they catch shape-level
// regressions (missing `[package]` in Cargo.toml, missing `source` in Gemfile,
// missing `module <path>` directive at the top of go.mod). Real dependency
// resolution happens in the live invokers upstream.
//
// The sniffs return the same `SmokeResult` union as the invoker path so the
// caller can compose either path uniformly.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { SmokeResult } from "./smokeComposition.js";

/** Lighter Gemfile sanity check when `bundle check` is unavailable. Flags:
 *   - missing `source` directive (a Gemfile without a rubygems source can't
 *     resolve any gem),
 *   - malformed `gem "name", "version"` lines whose version constraint is
 *     structurally broken (e.g. contains an unquoted operator or is
 *     obviously not a semver constraint).
 * Full Gemfile evaluation requires a Ruby interpreter; this heuristic catches
 * the shape-level regressions v0 aims at. */
export function checkGemfileSyntax(cwd: string, derivedDependsOn: readonly string[]): SmokeResult {
  let gemfile: string;
  try {
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
    if (!/^gem\s+["'][^"']+["']/u.test(line)) {
      return {
        kind: "failed",
        reason: `runtime-validity smoke rejected: Gemfile has a malformed gem line: ${JSON.stringify(line)}`,
      };
    }
  }
  return { kind: "ok", dependsOn: derivedDependsOn };
}

/** Structural go.mod sniff — first non-comment line must open `module <path>`;
 * every `require` line's version must start with `v<digit>` (semver or
 * pseudo-version shape). */
export function checkGoModManifest(cwd: string, derivedDependsOn: readonly string[]): SmokeResult {
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

/** Structural pyproject.toml sniff — a recognized top-level section
 * (`[project]`, `[tool.…]`, `[build-system]`) must appear, and any dep entry
 * in a `dependencies = [...]` list must lead with a package name (not a bare
 * version operator). */
export function checkPythonManifest(cwd: string, derivedDependsOn: readonly string[]): SmokeResult {
  let manifest: string;
  try {
    manifest = readFileSyncSafe(join(cwd, "pyproject.toml"));
  } catch (err) {
    return {
      kind: "failed",
      reason: `runtime-validity smoke rejected: pyproject.toml absent — ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!/^\s*\[(project|tool\.[^\]]+|build-system)\]/mu.test(manifest)) {
    return {
      kind: "failed",
      reason: `runtime-validity smoke rejected: pyproject.toml has no recognized top-level section (\`[project]\`, \`[tool.…]\`, or \`[build-system]\`)`,
    };
  }
  const depsMatch = manifest.match(/dependencies\s*=\s*\[([^\]]*)\]/u);
  if (depsMatch !== null) {
    const inner = depsMatch[1] ?? "";
    const entries = inner.match(/"[^"]+"|'[^']+'/gu) ?? [];
    for (const entry of entries) {
      const dep = entry.slice(1, -1).trim();
      if (dep === "") continue;
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

/** Structural Cargo.toml sniff — a `[package]` or `[workspace]` table must
 * appear; a `[package]` block must carry `name` + `version` keys. */
export function checkCargoManifest(cwd: string, derivedDependsOn: readonly string[]): SmokeResult {
  let manifest: string;
  try {
    manifest = readFileSyncSafe(join(cwd, "Cargo.toml"));
  } catch (err) {
    return {
      kind: "failed",
      reason: `runtime-validity smoke rejected: Cargo.toml absent — ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!/^\s*\[(package|workspace)\]/mu.test(manifest)) {
    return {
      kind: "failed",
      reason: `runtime-validity smoke rejected: Cargo.toml has no \`[package]\` or \`[workspace]\` table`,
    };
  }
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

/** Synchronous read helper shared by every manifest sniff. Wrapping
 * fs.readFileSync keeps the sniffs non-async so a call-site refactor doesn't
 * accidentally lose the failure envelope. */
function readFileSyncSafe(path: string): string {
  return readFileSync(path, "utf8");
}
