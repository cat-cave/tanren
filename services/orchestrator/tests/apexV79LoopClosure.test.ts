// apex v79/v80 loop closure — subtask-loop-level tests that pin the routing +
// coverage-guard behavior end-to-end (kept out of plannerLoop.test.ts to hold that
// file's 500-line cap). The workflow-level seam (`materializeTriageNewSpecs`) lives
// in `triageNewSpecsMaterialize.test.ts`.
import { describe, expect, it } from "vitest";
import type { AuditAnswer, TriageAnswer } from "../src/engine/answerers/schemas/index.js";
import { runSubtaskLoop } from "../src/engine/workflow/subtaskLoop.js";
import {
  cleanAudit,
  convergenceProgress,
  defaultLoopInput,
  makeAuditor,
  makeConvergence,
  makeTriage,
  p0Audit,
} from "./helpers/plannerLoopHelpers.js";

describe("apex v79/v80 loop closure — coverage guard + kind:spec routing at the subtask loop", () => {
  it("triage returning EMPTY workItems on non-empty findings does NOT falsely pass (coverage guard)", async () => {
    // A triage agent that returns empty workItems on non-empty findings would otherwise
    // collapse to `outcome: "passed"` (both tasksHere AND newSpecs empty), dropping every
    // finding into a black hole. The fail-closed synthetic P0 keeps the loop iterating —
    // the spec never falsely passes on dropped findings.
    const emptyTriage: TriageAnswer = { workItems: [] };
    const { input, events } = defaultLoopInput({
      adapters: {
        ...defaultLoopInput().input.adapters,
        // Loop 1: P0 audit → empty triage → coverage guard synthesizes P0 → kept.
        //         convergence(progress) drives to loop 2.
        // Loop 2: clean audit → PASS (no findings, no triage).
        auditor: makeAuditor([p0Audit, cleanAudit]),
        triage: makeTriage([emptyTriage]),
        convergence: makeConvergence([convergenceProgress]),
      },
    });
    const outcome = await runSubtaskLoop(input);
    expect(outcome.kind).toBe("passed");
    if (outcome.kind !== "passed") return;
    // The first triage returned "kept" (synthetic P0), not "passed" — the coverage guard
    // prevented the false pass on non-empty findings + empty workItems.
    const firstTriage = events.events.find((e) => e.eventType === "triage.completed");
    expect(firstTriage).toBeDefined();
    expect((firstTriage!.payload as { outcome: string }).outcome).toBe("kept");
    // The synthetic P0 item names it explicitly ("triage-coverage-gap-...").
    const items = (firstTriage!.payload as { items: Array<{ id: string; title: string }> }).items;
    expect(items.some((i) => i.id.startsWith("triage-coverage-gap-"))).toBe(true);
  });

  it("an out-of-scope auditor finding routes as kind:spec and appears in outcome.newSpecs (end-to-end)", async () => {
    // The auditor emits an OUT-OF-SCOPE P0 finding; the triage agent reads it as
    // cross-scope + emits `kind: spec`; the routing policy honors the hint (even for
    // a P0) and produces `outcome.newSpecs` — the spec passes with the routed spec
    // ready for materialization by the run executor.
    const outOfScopeAudit: AuditAnswer = {
      findings: [
        {
          id: "deploy-missing",
          severity: "P0",
          title: "OUT-OF-SCOPE: deploy target not configured",
          body: "This is a scaffold spec; the deploy configuration belongs in a separate spec.",
        },
      ],
    };
    const outOfScopeTriage: TriageAnswer = {
      workItems: [
        {
          id: "wi-deploy",
          kind: "spec",
          severity: "P0",
          title: "Configure the deploy target",
          body: "Add the deploy manifest and credentials in a follow-up spec.",
          findingIds: ["deploy-missing"],
        },
      ],
    };
    const { input } = defaultLoopInput({
      adapters: {
        ...defaultLoopInput().input.adapters,
        auditor: makeAuditor([outOfScopeAudit]),
        triage: makeTriage([outOfScopeTriage]),
      },
    });
    const outcome = await runSubtaskLoop(input);
    expect(outcome.kind).toBe("passed");
    if (outcome.kind !== "passed") return;
    // The cross-scope P0 was routed OUT as a new DAG spec (not re-forced into this spec).
    expect(outcome.newSpecs).toHaveLength(1);
    expect(outcome.newSpecs[0]!.title).toBe("Configure the deploy target");
    expect(outcome.newSpecs[0]!.severity).toBe("P0");
  });
});
