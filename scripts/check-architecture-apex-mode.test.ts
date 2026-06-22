import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkNoApexModeBranching } from "./check-architecture-apex-mode.mjs";
import { runArchitectureChecks } from "./check-architecture.mjs";

// The no-apex-mode-branching eradication lint (project-config-is-the-source-of-truth,
// PR feat(config): eradicate TANREN_APEX_MODE). Sibling spec in the mold of
// check-architecture-timeouts.test.ts: asserts each flagged token + the bless mechanism,
// then proves the lint is folded into `runArchitectureChecks` (the exit-1 set).
describe("no-apex-mode-branching (apex-mode eradication lint)", () => {
  const srcFile = "services/orchestrator/src/engine/sample.ts";

  it("flags the `TANREN_APEX_MODE` env var", () => {
    const text = 'const flag = process.env["TANREN_APEX_MODE"];\n';
    const flagged = checkNoApexModeBranching([{ file: srcFile, text }]);
    expect(flagged.map((d) => d.rule)).toEqual(["no-apex-mode-branching"]);
    expect(flagged[0]?.message).toContain("eradicated");
  });

  it("flags `isApexMode` (the deleted helper)", () => {
    const text = "if (isApexMode()) escalate();\n";
    const flagged = checkNoApexModeBranching([{ file: srcFile, text }]);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.message).toContain("isApexMode");
  });

  it("flags `APEX_THRESHOLDS` (the deleted apex-overrides constant)", () => {
    const text = "const t = APEX_THRESHOLDS;\n";
    const flagged = checkNoApexModeBranching([{ file: srcFile, text }]);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.message).toContain("APEX_THRESHOLDS");
  });

  it("flags `resolveDefaultAuditPosture` (the deleted apex-aware resolver)", () => {
    const text = "const p = resolveDefaultAuditPosture();\n";
    const flagged = checkNoApexModeBranching([{ file: srcFile, text }]);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.message).toContain("resolveDefaultAuditPosture");
  });

  it("flags `resolveInsightThresholds` (the deleted apex-aware resolver)", () => {
    const text = "const t = resolveInsightThresholds();\n";
    const flagged = checkNoApexModeBranching([{ file: srcFile, text }]);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.message).toContain("resolveInsightThresholds");
  });

  it("flags an apex-mode-shaped synonym identifier (the reintroduction-by-rename guard)", () => {
    const text = "const isInApexMode = true;\n";
    const flagged = checkNoApexModeBranching([{ file: srcFile, text }]);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.message).toContain("apex-mode-shaped");
  });

  it("ignores tests/ and a banned word in prose / JSDoc", () => {
    const testFile = "services/orchestrator/tests/foo.test.ts";
    const code = 'const flag = process.env["TANREN_APEX_MODE"];\n';
    expect(checkNoApexModeBranching([{ file: testFile, text: code }])).toEqual([]);
    const prose = "// `TANREN_APEX_MODE` was eradicated in this PR.\nexport const x = 1;\n";
    expect(checkNoApexModeBranching([{ file: srcFile, text: prose }])).toEqual([]);
  });

  it("honors the per-line // arch-allow: apex-mode annotation", () => {
    const text =
      'const x = "TANREN_APEX_MODE"; // arch-allow: apex-mode — lint script literal naming the banned token\n';
    expect(checkNoApexModeBranching([{ file: srcFile, text }])).toEqual([]);
  });
});

// ENFORCEMENT wiring: the lint is folded into `runArchitectureChecks` (the exit-1
// aggregator), so a synthetic apex-mode-branching violation surfaces as a diagnostic AND
// makes the CLI exit NON-ZERO.
describe("no-apex-mode-branching is CI-GATING (folded into the exit-1 set)", () => {
  const scriptPath = resolve(import.meta.dirname, "check-architecture.mjs");

  it("runArchitectureChecks SURFACES a synthetic apex-mode violation", async () => {
    const root = mkdtempSync(join(tmpdir(), "arch-apex-enforce-"));
    try {
      mkdirSync(join(root, "services/orchestrator/src/engine"), { recursive: true });
      writeFileSync(
        join(root, "services/orchestrator/src/engine/violating.ts"),
        'export const FLAG = process.env["TANREN_APEX_MODE"];\n',
      );
      const diagnostics = await runArchitectureChecks({ root });
      expect(diagnostics.some((d) => d.rule === "no-apex-mode-branching")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the CLI EXITS NON-ZERO on a synthetic apex-mode violation", () => {
    const root = mkdtempSync(join(tmpdir(), "arch-apex-cli-"));
    try {
      mkdirSync(join(root, "services/orchestrator/src/engine"), { recursive: true });
      writeFileSync(
        join(root, "services/orchestrator/src/engine/violating.ts"),
        'export const FLAG = process.env["TANREN_APEX_MODE"];\n',
      );
      const run = spawnSync(process.execPath, [scriptPath], { cwd: root, encoding: "utf8" });
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain("no-apex-mode-branching");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
