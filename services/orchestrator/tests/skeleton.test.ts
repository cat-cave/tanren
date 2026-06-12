// The canonical stack-agnostic project skeleton — the single source of the project
// CONTRACT shape (engine/forge/scaffold/skeleton.ts). These tests pin the two
// load-bearing invariants: (1) the skeleton `.tanren/ci.yml` round-trips through the
// REAL CiConfigV1 resolver as the justfile-convention 3-tier map, and (2) every
// justfile target is a LOUD stub (an unfilled target fails the gate, never a silent
// pass). The skeleton names NO tech stack — only `just <target>` defers.
import { describe, expect, it } from "vitest";
import { JUNIT_REPORT_PATH, resolveCiConfig } from "../src/engine/ci/index.js";
import {
  SKELETON_CI_CONFIG,
  SKELETON_CI_CONFIG_PATH,
  SKELETON_FILES,
  SKELETON_JUSTFILE,
  SKELETON_JUSTFILE_PATH,
  SKELETON_README,
} from "../src/engine/forge/scaffold/index.js";

describe("skeleton .tanren/ci.yml — round-trips through resolveCiConfig", () => {
  it("resolves as a valid CiConfigV1 with the justfile-convention 3-tier lifecycle map", () => {
    const config = resolveCiConfig(SKELETON_CI_CONFIG);
    expect(config.version).toBe(1);
    // bootstrap + the upgrade verb + every tier step defer to `just <target>` — Tanren names NO stack.
    expect(config.bootstrap?.run).toBe("just bootstrap");
    // The `upgrade` verb (environment-management.md §4.5) defers to `just upgrade`.
    expect(config.upgrade?.run).toBe("just upgrade");
    expect((config.tiers.fast ?? []).map((s) => s.run)).toEqual(["just tier-1"]);
    expect((config.tiers.slow ?? []).map((s) => s.run)).toEqual(["just tier-2"]);
    expect((config.tiers.merge ?? []).map((s) => s.run)).toEqual(["just tier-3"]);
    // The three tiers map 1:1 to the three lifecycle points.
    expect(config.when.fast).toEqual(["per_iteration"]);
    expect(config.when.slow).toEqual(["pre_audit"]);
    expect(config.when.merge).toEqual(["pre_merge"]);
  });

  it("the run COMMANDS name NO tech stack — every step defers to `just`", () => {
    // Assert on the executable `run:` lines (comments may list example stacks as guidance).
    const runs = SKELETON_CI_CONFIG.split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("run:"));
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) {
      expect(run).toMatch(/run: just /u);
      expect(run).not.toMatch(/pnpm|npm|corepack|cargo/u);
    }
  });
});

describe("skeleton justfile — every conventional target is a LOUD stub", () => {
  it("declares the conventional lifecycle targets", () => {
    for (const target of ["bootstrap:", "tier-1:", "tier-2:", "tier-3:", "build:", "deploy:", "upgrade:"]) {
      expect(SKELETON_JUSTFILE).toContain(target);
    }
  });

  it("each stub fails LOUDLY (exit 1) so an unfilled target never silently passes a gate", () => {
    // One `exit 1` per conventional target (7, incl. the §4.5 `upgrade` verb).
    const exits = SKELETON_JUSTFILE.match(/exit 1/gu) ?? [];
    expect(exits).toHaveLength(7);
    // The stub echoes a "define this target" instruction, naming the target.
    expect(SKELETON_JUSTFILE).toContain("tanren: define 'bootstrap'");
    expect(SKELETON_JUSTFILE).toContain("tanren: define 'tier-1'");
    expect(SKELETON_JUSTFILE).toContain("tanren: define 'upgrade'");
  });

  it("recipe bodies are TAB-indented (just requires a tab, not spaces)", () => {
    // The line right after `bootstrap:` must start with a literal tab.
    const lines = SKELETON_JUSTFILE.split("\n");
    const bootstrapIdx = lines.findIndex((l) => l === "bootstrap:");
    expect(bootstrapIdx).toBeGreaterThanOrEqual(0);
    expect(lines[bootstrapIdx + 1]?.startsWith("\t")).toBe(true);
  });

  it("the recipe BODIES name NO tech stack — the project fills the stubs for its own stack", () => {
    // The recipe bodies are the tab-indented `@echo … exit 1` stub lines (a leading
    // comment may list example stacks as guidance — that is not an executed command).
    const recipeBodies = SKELETON_JUSTFILE.split("\n").filter((l) => l.startsWith("\t"));
    expect(recipeBodies.length).toBeGreaterThan(0);
    for (const body of recipeBodies) {
      expect(body).not.toMatch(/\bpnpm\b|\bnpm\b|\bcargo\b|\buv\b/u);
    }
  });
});

describe("SKELETON_FILES — the writable file set Wave B's scaffold writer consumes", () => {
  it("is the ci.yml + justfile + README at their conventional paths", () => {
    const byPath = new Map(SKELETON_FILES.map((f) => [f.path, f.content]));
    expect(byPath.get(SKELETON_CI_CONFIG_PATH)).toBe(SKELETON_CI_CONFIG);
    expect(byPath.get(SKELETON_JUSTFILE_PATH)).toBe(SKELETON_JUSTFILE);
    expect(byPath.get("README.md")).toBe(SKELETON_README);
    expect(SKELETON_FILES).toHaveLength(3);
  });

  it("the README explains the contract + the fixed JUnit report-path convention", () => {
    expect(SKELETON_README).toContain("justfile");
    expect(SKELETON_README).toContain(".tanren/ci.yml");
    expect(SKELETON_README).toContain(JUNIT_REPORT_PATH);
  });
});
