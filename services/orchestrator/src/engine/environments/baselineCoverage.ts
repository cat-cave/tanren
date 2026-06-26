// Environment management (environment-management.md §3 Layer 3 + §7 P4) — the
// GOLDEN-BASE COVERAGE check that short-circuits JIT env-image creation.
//
// P2's golden base ships a WARM BASELINE (runner/mise.baseline.toml — node 24 /
// pnpm 11 / python 3.14 / go 1.26 / ruby 3.4). If a project's declared toolchain is a
// SUBSET of that baseline (every tool present AND its declared version-spec already
// served by the baseline), the golden base ALREADY IS a valid, validated environment
// for it — there is NOTHING off-baseline to bake, so a JIT build would be pure waste
// (it would FROM the golden base and `mise install` an already-warm toolchain).
//
// THE SHORT-CIRCUIT (the do-NOT-over-build rule): a no-registry-match project whose
// toolchain ⊆ baseline resolves straight to the golden base; the JIT env-image BUILD
// fires ONLY when the toolchain is NOT covered (an off-baseline VERSION — node 18 vs
// the baseline 24 — or an off-baseline TOOL — rust/bun the baseline never warmed).
// This keeps apex-style baseline projects (node + pnpm, a subset of the baseline)
// from ever triggering a build.
//
// VERSION-SPEC SEMANTICS — the baseline declares LOOSE MAJORS (`node = "24"`,
// resolving to the latest 24.x at build time). A project that declares the SAME
// loose major is covered (a warm hit on the identical pre-warmed install). A project
// that declares a DIFFERENT version-spec for a baseline tool (`node = "18"`,
// `node = "24.2.0"`, `node = "lts"`) is NOT covered: a different spec is a different
// install the golden base did not warm, so it must be baked + validated. We compare
// the spec STRING (the same normalized form the env_key hashes), never parse
// semver — Tanren names no version semantics; the project's declared spec either
// byte-matches a baseline spec or it does not. STACK-AGNOSTIC: the baseline is data
// (the tool→spec map), never a hardcoded stack assumption in this check.

import type { ProjectToolchain } from "../config/projectConfig.js";

// The golden base's warm-baseline toolchain (tool-name → loose-major version-spec).
// This MIRRORS runner/mise.baseline.toml — the single source of WHAT the golden
// base pre-warms. It is the env-layer's TS-visible projection of that baked spec:
// the coverage check reads it to decide "does the golden base already serve this?".
// Kept as a frozen literal (not a runtime read of the toml on the runner) because
// the check runs at resolve time, BEFORE any runner is allocated — it is a pure,
// synchronous decision over the project's declared toolchain. A golden-image refresh
// that changes the baked baseline MUST update both this map and the toml in lockstep
// (a baselineCoverage test asserts the two never silently drift — see the P4 tests).
export const GOLDEN_BASELINE_TOOLCHAIN: Readonly<Record<string, string>> = Object.freeze({
  node: "24",
  pnpm: "11",
  python: "3.14",
  go: "1.26",
  ruby: "3.4",
});

/**
 * Is the project's declared toolchain a SUBSET of the golden baseline — i.e. does
 * the warm golden base ALREADY serve every tool at its declared version-spec, so no
 * JIT build is needed?
 *
 * `true` (covered) iff EVERY declared `(tool, spec)` pair is present in the baseline
 * with the SAME spec string. A project that declares fewer tools than the baseline is
 * still covered (the extra baseline tools are harmless). An EMPTY toolchain is
 * trivially covered (it asks for nothing off-baseline). A SINGLE off-baseline pair —
 * a tool the baseline never warmed, OR a baseline tool at a different version-spec —
 * makes the whole toolchain NOT covered: the env must be JIT-built + validated.
 *
 * The version-spec comparison is byte-exact over the trimmed spec (the determinism
 * anchor the env_key already uses); Tanren parses no semver here.
 */
export function toolchainCoveredByGoldenBaseline(toolchain: ProjectToolchain): boolean {
  for (const { name, version } of toolchain) {
    const baselineSpec = GOLDEN_BASELINE_TOOLCHAIN[name];
    // The baseline never warmed this tool at all (an off-baseline TOOL — rust, bun,
    // …) ⇒ not covered.
    if (baselineSpec === undefined) {
      return false;
    }
    // The baseline warmed this tool but at a DIFFERENT version-spec (an off-baseline
    // VERSION — node 18 vs the baseline 24) ⇒ not covered. Compare the trimmed spec
    // string (the env_key's normalization), never parse semver.
    if (baselineSpec.trim() !== version.trim()) {
      return false;
    }
  }
  // Every declared pair is served by the baseline (or the toolchain is empty).
  return true;
}
