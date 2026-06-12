import { describe, expect, it } from "vitest";
import {
  GOLDEN_BASELINE_TOOLCHAIN,
  toolchainCoveredByGoldenBaseline,
} from "../src/engine/environments/baselineCoverage.js";
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
    expect(toolchainCoveredByGoldenBaseline(tc({ node: "24", pnpm: "11", python: "3.14", go: "1.26" }))).toBe(true);
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
