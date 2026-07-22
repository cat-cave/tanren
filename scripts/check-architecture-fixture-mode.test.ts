import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkNoFixtureModeBranching } from "./check-architecture-fixture-mode.mjs";
import { runArchitectureChecks } from "./check-architecture.mjs";

// The no-fixture-mode-branching eradication lint (project-config-is-the-source-of-truth,
// PR feat(config): eradicate TANREN_FIXTURE_MODE). Sibling spec in the mold of
// check-architecture-timeouts.test.ts: asserts each flagged token + the bless mechanism,
// then proves the lint is folded into `runArchitectureChecks` (the exit-1 set).
describe("no-fixture-mode-branching (fixture-mode eradication lint)", () => {
  const srcFile = "services/orchestrator/src/engine/sample.ts";

  it("flags the `TANREN_FIXTURE_MODE` env var", () => {
    const text = 'const flag = process.env["TANREN_FIXTURE_MODE"];\n';
    const flagged = checkNoFixtureModeBranching([{ file: srcFile, text }]);
    expect(flagged.map((d) => d.rule)).toEqual(["no-fixture-mode-branching"]);
    expect(flagged[0]?.message).toContain("eradicated");
  });

  it("flags `isFixtureMode` (the deleted helper)", () => {
    const text = "if (isFixtureMode()) escalate();\n";
    const flagged = checkNoFixtureModeBranching([{ file: srcFile, text }]);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.message).toContain("isFixtureMode");
  });

  it("flags `FIXTURE_THRESHOLDS` (a fixture-only overrides constant)", () => {
    const text = "const t = FIXTURE_THRESHOLDS;\n";
    const flagged = checkNoFixtureModeBranching([{ file: srcFile, text }]);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.message).toContain("FIXTURE_THRESHOLDS");
  });

  it("flags `resolveDefaultAuditPosture` (a fixture-aware resolver)", () => {
    const text = "const p = resolveDefaultAuditPosture();\n";
    const flagged = checkNoFixtureModeBranching([{ file: srcFile, text }]);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.message).toContain("resolveDefaultAuditPosture");
  });

  it("flags `resolveInsightThresholds` (a fixture-aware resolver)", () => {
    const text = "const t = resolveInsightThresholds();\n";
    const flagged = checkNoFixtureModeBranching([{ file: srcFile, text }]);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.message).toContain("resolveInsightThresholds");
  });

  it("flags an fixture-mode-shaped synonym identifier (the reintroduction-by-rename guard)", () => {
    const text = "const isInFixtureMode = true;\n";
    const flagged = checkNoFixtureModeBranching([{ file: srcFile, text }]);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.message).toContain("fixture-mode-shaped");
  });

  it("ignores tests/ and a banned word in prose / JSDoc", () => {
    const testFile = "services/orchestrator/tests/foo.test.ts";
    const code = 'const flag = process.env["TANREN_FIXTURE_MODE"];\n';
    expect(checkNoFixtureModeBranching([{ file: testFile, text: code }])).toEqual([]);
    const prose = "// `TANREN_FIXTURE_MODE` was eradicated in this PR.\nexport const x = 1;\n";
    expect(checkNoFixtureModeBranching([{ file: srcFile, text: prose }])).toEqual([]);
  });

  it("honors the per-line // arch-allow: fixture-mode annotation", () => {
    const text =
      'const x = "TANREN_FIXTURE_MODE"; // arch-allow: fixture-mode — lint script literal naming the banned token\n';
    expect(checkNoFixtureModeBranching([{ file: srcFile, text }])).toEqual([]);
  });
});

// ENFORCEMENT wiring: the lint is folded into `runArchitectureChecks` (the exit-1
// aggregator), so a synthetic fixture-mode-branching violation surfaces as a diagnostic AND
// makes the CLI exit NON-ZERO.
describe("no-fixture-mode-branching is CI-GATING (folded into the exit-1 set)", () => {
  const scriptPath = resolve(import.meta.dirname, "check-architecture.mjs");

  it("runArchitectureChecks SURFACES a synthetic fixture-mode violation", async () => {
    const root = mkdtempSync(join(tmpdir(), "arch-fixture-enforce-"));
    try {
      mkdirSync(join(root, "services/orchestrator/src/engine"), { recursive: true });
      writeFileSync(
        join(root, "services/orchestrator/src/engine/violating.ts"),
        'export const FLAG = process.env["TANREN_FIXTURE_MODE"];\n',
      );
      const diagnostics = await runArchitectureChecks({ root });
      expect(diagnostics.some((d) => d.rule === "no-fixture-mode-branching")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the CLI EXITS NON-ZERO on a synthetic fixture-mode violation", () => {
    const root = mkdtempSync(join(tmpdir(), "arch-fixture-cli-"));
    try {
      mkdirSync(join(root, "services/orchestrator/src/engine"), { recursive: true });
      writeFileSync(
        join(root, "services/orchestrator/src/engine/violating.ts"),
        'export const FLAG = process.env["TANREN_FIXTURE_MODE"];\n',
      );
      const run = spawnSync(process.execPath, [scriptPath], { cwd: root, encoding: "utf8" });
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain("no-fixture-mode-branching");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
