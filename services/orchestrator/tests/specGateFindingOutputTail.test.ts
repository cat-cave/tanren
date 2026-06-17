// apex-v36 NON-CONVERGENCE FIX: a generic (non-config, non-bootstrap) SPEC GATE failure
// — e.g. tier-2 `format-check` reporting unformatted files — must reach the writer rework
// carrying the failing step's CAPTURED OUTPUT (the ACTUAL error), not a blind "the tree
// does not build/test". In apex v36 the spec gate's format-check named 3 unformatted files
// and said "Run Prettier with --write to fix", but `gateFindings` discarded the output tail,
// so the writer reworked BLIND and re-produced the SAME unformatted output for ~80 min.
//
// These tests assert the fix at TWO levels:
//   (1) `gateFindings` (the spec-tier P0 finding constructor) carries the failed step's
//       outputTail + the run-the-declared-format-step steering;
//   (2) `failedStepOutputTail` (the shared extractor `gateReason`/`gateFindings` use) picks
//       the FAILED step's output (stack-agnostic — it surfaces whatever the project's
//       declared gate step emitted, never a baked-in tool name).
import { describe, expect, it } from "vitest";
import type { CiWhen } from "../src/engine/ci/index.js";
import type { GateOutcome } from "../src/engine/workflow/gate/index.js";
import { gateFindings } from "../src/engine/workflow/loopFindings.js";
import { failedStepOutputTail, gateReason } from "../src/engine/workflow/subtaskInnerLoop.js";

// The exact apex-v36 spec-gate (tier-2 / pre_audit) format-check failure: prettier names
// the unformatted files and tells you how to fix them. This is the load-bearing detail.
const FORMAT_OUTPUT_TAIL = [
  "Checking formatting...",
  "[warn] features/fixtures/conforming-repo.manifest.json",
  "[warn] scripts/upgrade-policy.mjs",
  "[warn] scripts/upgrade-toolchain.mjs",
  "[warn] Code style issues found in 3 files. Run Prettier with --write to fix.",
  "error: recipe `format-check` failed on line 22 with exit code 1",
].join("\n");

function failedFormatGate(when: CiWhen): Extract<GateOutcome, { passed: false }> {
  const failure = {
    passed: false as const,
    tier: "tier-2",
    when,
    failedStep: "format-check",
    exitCode: 1,
    steps: [
      {
        name: "format-check",
        run: "just format-check",
        exitCode: 1,
        passed: false,
        timedOut: false,
        outputTail: FORMAT_OUTPUT_TAIL,
      },
    ],
  };
  return { passed: false, results: [failure], failure };
}

describe("spec gate finding — carries the failing step's output (apex-v36 blind-rework fix)", () => {
  it("gateFindings embeds the failed step's outputTail (the named files + the remedy)", () => {
    const finding = gateFindings(failedFormatGate("pre_audit"));
    expect(finding.severity).toBe("P0");
    expect(finding.title).toContain('tier "tier-2"');
    expect(finding.title).toContain('step "format-check"');
    // The ACTUAL error — the named files + the remedy — is the writer's rework context,
    // so it fixes the right thing instead of re-emitting identical unformatted output.
    expect(finding.body).toContain("scripts/upgrade-policy.mjs");
    expect(finding.body).toContain("scripts/upgrade-toolchain.mjs");
    expect(finding.body).toContain("conforming-repo.manifest.json");
    expect(finding.body).toContain("Run Prettier with --write to fix");
  });

  it("gateFindings steers a deterministic format failure at the project's DECLARED format step (stack-agnostic)", () => {
    const finding = gateFindings(failedFormatGate("pre_audit"));
    // Tells the writer to run the project's OWN declared format/fix step — never a baked-in
    // tool name (no hardcoded prettier/pnpm); the project declares it in its lifecycle/justfile.
    expect(finding.body).toContain("format/fix step");
    expect(finding.body).toContain("lifecycle/justfile");
    expect(finding.body).toContain("do NOT re-emit the same output unchanged");
    expect(finding.body).not.toContain("prettier .");
  });

  it("gateFindings stays terse when the failed step captured no output (honest absence, no fabrication)", () => {
    const failure = {
      passed: false as const,
      tier: "tier-2",
      when: "pre_audit" as CiWhen,
      failedStep: "test",
      exitCode: 1,
      steps: [{ name: "test", run: "just test", exitCode: 1, passed: false, timedOut: false, outputTail: "" }],
    };
    const finding = gateFindings({ passed: false, results: [failure], failure });
    expect(finding.body).not.toContain("Gate output (last lines):");
    expect(finding.body).toContain('step "test"');
  });

  it("the spec-gate finding and the fast-gate writer steering surface the SAME captured output", () => {
    // Both the per_iteration fast-gate steering (`gateReason`) and the spec-tier P0 finding
    // (`gateFindings`) feed the writer the same load-bearing error — the apex-v36 gap was the
    // spec-tier path silently dropping it while the fast-tier path already carried it.
    const gate = failedFormatGate("per_iteration");
    expect(gateReason(gate)).toContain("Run Prettier with --write to fix");
    expect(gateFindings(failedFormatGate("pre_audit")).body).toContain("Run Prettier with --write to fix");
  });
});

describe("failedStepOutputTail — picks the FAILED step's captured output", () => {
  it("returns the failed step's tail, trimmed", () => {
    const { failure } = failedFormatGate("pre_audit");
    expect(failedStepOutputTail(failure)).toContain("Run Prettier with --write to fix");
  });

  it("selects the step matching failedStep (not just the first/last) across a multi-step tier", () => {
    const failure = {
      passed: false as const,
      tier: "tier-2",
      when: "pre_audit" as CiWhen,
      failedStep: "format-check",
      exitCode: 1,
      steps: [
        { name: "typecheck", run: "just typecheck", exitCode: 0, passed: true, timedOut: false, outputTail: "ok" },
        {
          name: "format-check",
          run: "just format-check",
          exitCode: 1,
          passed: false,
          timedOut: false,
          outputTail: FORMAT_OUTPUT_TAIL,
        },
      ],
    };
    expect(failedStepOutputTail(failure)).toContain("Run Prettier with --write to fix");
    expect(failedStepOutputTail(failure)).not.toContain("ok");
  });

  it("returns empty when no step captured output (honest absence)", () => {
    const failure = {
      passed: false as const,
      tier: "tier-2",
      when: "pre_audit" as CiWhen,
      failedStep: "test",
      exitCode: 1,
      steps: [],
    };
    expect(failedStepOutputTail(failure)).toBe("");
  });
});
