import { describe, expect, it } from "vitest";
import {
  GOLDEN_BASELINE_TOOLCHAIN,
  toolchainCoveredByGoldenBaseline,
} from "../src/engine/environments/baselineCoverage.js";
import { buildInterviewPrompt } from "../src/engine/forge/interview/prompt.js";
import { emptyCapture } from "../src/engine/forge/interview/types.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Environment management (env-management.md §3 Layer 3 + §7 P4) — the golden-base
// SUBSET check that short-circuits JIT env-image creation. A baseline-subset toolchain
// (apex-style node+pnpm) must NEVER trigger a build; an off-baseline version/tool must.

// The toolchain is a LIST of {name, version}; this helper keeps the table terse.
function tc(map: Record<string, string>): { name: string; version: string }[] {
  return Object.entries(map).map(([name, version]) => ({ name, version }));
}

describe("toolchainCoveredByGoldenBaseline — the golden-base short-circuit", () => {
  it("an apex-style baseline-subset toolchain (node+pnpm) is COVERED → no build", () => {
    expect(toolchainCoveredByGoldenBaseline(tc({ node: "24", pnpm: "11" }))).toBe(true);
  });

  it("the FULL baseline is covered (every tool at its baseline spec)", () => {
    // Ruby is TEMPORARILY dropped from the baseline (upstream mise 403 on the
    // jdx/ruby endpoint, 2026-07-01) — restore `ruby: "3.4"` here in lockstep
    // when runner/mise.baseline.toml restores the line.
    expect(toolchainCoveredByGoldenBaseline(tc({ node: "24", pnpm: "11", python: "3.14", go: "1.26" }))).toBe(true);
  });

  it("a Ruby-only project is NOT covered while ruby is dropped from the baseline (2026-07-01 workaround)", () => {
    // FLIPPED from covered → not-covered while ruby is out of the baseline. A Ruby
    // project now takes the JIT-build path instead of the warm short-circuit; the
    // build itself would still trip the same upstream 403, so a Ruby project cannot
    // run end-to-end until the durable fix ships (see runner/mise.baseline.toml).
    // Flip this back to `.toBe(true)` when the baseline restores `ruby = "3.4"`.
    expect(toolchainCoveredByGoldenBaseline(tc({ ruby: "3.4" }))).toBe(false);
  });

  it("an EMPTY toolchain is trivially covered (asks for nothing off-baseline)", () => {
    expect(toolchainCoveredByGoldenBaseline([])).toBe(true);
  });

  it("an OFF-baseline VERSION of a baseline tool is NOT covered → build", () => {
    // node 18 is off the baseline node 24 → a different install the base never warmed.
    expect(toolchainCoveredByGoldenBaseline(tc({ node: "18" }))).toBe(false);
    expect(toolchainCoveredByGoldenBaseline(tc({ python: "3.11" }))).toBe(false);
    // An exact pin of a baseline major is still a DIFFERENT spec string → build.
    expect(toolchainCoveredByGoldenBaseline(tc({ node: "24.2.0" }))).toBe(false);
  });

  it("an OFF-baseline TOOL the baseline never warmed is NOT covered → build", () => {
    expect(toolchainCoveredByGoldenBaseline(tc({ rust: "nightly" }))).toBe(false);
    expect(toolchainCoveredByGoldenBaseline(tc({ bun: "1" }))).toBe(false);
  });

  it("a MIX of a covered tool + one off-baseline tool is NOT covered (a single delta forces a build)", () => {
    expect(toolchainCoveredByGoldenBaseline(tc({ node: "24", rust: "nightly" }))).toBe(false);
    expect(toolchainCoveredByGoldenBaseline(tc({ node: "18", pnpm: "11" }))).toBe(false);
  });

  it("the TS baseline map mirrors runner/mise.baseline.toml (the two must never drift)", () => {
    // The coverage check reads GOLDEN_BASELINE_TOOLCHAIN at resolve time, before any
    // runner — it MUST match what the golden image actually bakes (mise.baseline.toml),
    // or the short-circuit would skip a build for a toolchain the base does not serve.
    const tomlPath = resolve(import.meta.dirname, "../../../runner/mise.baseline.toml");
    const toml = readFileSync(tomlPath, "utf8");
    // Parse the `[tools]` table's `name = "spec"` lines (ignore comments/blank/header).
    const parsed: Record<string, string> = {};
    let inTools = false;
    for (const raw of toml.split("\n")) {
      const line = raw.trim();
      if (line.startsWith("#") || line === "") continue;
      if (line === "[tools]") {
        inTools = true;
        continue;
      }
      if (line.startsWith("[")) {
        inTools = false;
        continue;
      }
      if (!inTools) continue;
      const m = /^([a-z0-9._-]+)\s*=\s*"([^"]+)"/u.exec(line);
      if (m) parsed[m[1] as string] = m[2] as string;
    }
    expect(parsed).toEqual({ ...GOLDEN_BASELINE_TOOLCHAIN });
  });
});

describe("interview prompt toolchain example — derived from GOLDEN_BASELINE_TOOLCHAIN (drift guard)", () => {
  // The vision-interview prompt shows illustrative toolchain versions to the LLM
  // answerer. A hardcoded example (the prior `pnpm '10'` / `python '3.13'`) was a
  // THIRD copy of the baseline that silently rotted: an LLM copying the stale example
  // declares an off-baseline spec, which DEFEATS the golden-base coverage short-circuit
  // and forces a needless JIT env build on a standard fresh node+pnpm project (apex v80
  // greenfield derive `jit_build_required` halt). The example versions are now DERIVED
  // from GOLDEN_BASELINE_TOOLCHAIN so they can never drift again — this test pins that.
  it("the rendered example node/pnpm/python versions equal the golden baseline specs", () => {
    const prompt = buildInterviewPrompt({
      round: 1,
      totalRounds: 14,
      answer: "",
      capture: emptyCapture(),
    });
    // The example line spells out node/pnpm/python at their baseline specs, so a future
    // golden-image bump that changes the baseline can never leave the prompt stale.
    expect(prompt).toContain(`{ name: 'node', version: '${GOLDEN_BASELINE_TOOLCHAIN["node"] ?? ""}' }`);
    expect(prompt).toContain(`{ name: 'pnpm',`);
    expect(prompt).toContain(`version: '${GOLDEN_BASELINE_TOOLCHAIN["pnpm"] ?? ""}' }`);
    expect(prompt).toContain(`{ name: 'python', version: '${GOLDEN_BASELINE_TOOLCHAIN["python"] ?? ""}' }`);
    // And it must NOT carry the old stale numbers that mismatched the baseline.
    expect(prompt).not.toContain("version: '10' }");
    expect(prompt).not.toContain("{ name: 'python', version: '3.13' }");
  });

  it("the derived example toolchain is itself baseline-COVERED (no JIT build for a standard fresh project)", () => {
    // The whole point: a fresh node+pnpm project that follows the example stays on the
    // warm baseline. Assert the example versions the prompt advertises are covered.
    expect(
      toolchainCoveredByGoldenBaseline([
        { name: "node", version: GOLDEN_BASELINE_TOOLCHAIN["node"] ?? "" },
        { name: "pnpm", version: GOLDEN_BASELINE_TOOLCHAIN["pnpm"] ?? "" },
      ]),
    ).toBe(true);
  });

  it("the toolchain guidance tells the answerer a deploy CLI is NOT a toolchain tool (apex v83)", () => {
    // apex v83: the answerer put flyctl@latest in `toolchain` → off-baseline → a
    // spurious `jit_build_required` halt. Deployment is provider-driven platform-side
    // (deploy-fly writes only fly.toml/FLY_API_TOKEN; the Fly Machines REST API deploys
    // on merge), so a deploy/hosting CLI must NOT be a provisioned toolchain tool. Pin
    // that the prompt says so, naming the common CLIs and the platform-side rationale.
    const prompt = buildInterviewPrompt({
      round: 1,
      totalRounds: 14,
      answer: "",
      capture: emptyCapture(),
    });
    expect(prompt).toContain("A DEPLOY/HOSTING CLI");
    expect(prompt).toContain("does NOT belong");
    expect(prompt).toContain("in `toolchain`");
    // Names the concrete CLIs the answerer must not add.
    for (const cli of ["flyctl", "vercel", "wrangler", "netlify"]) {
      expect(prompt).toContain(cli);
    }
    // The `deploy` command may still name the human-facing convention.
    expect(prompt).toContain("'flyctl deploy'");
  });
});
