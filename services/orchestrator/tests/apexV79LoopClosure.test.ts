// apex v79/v80 loop closure — subtask-loop-level tests that pin the routing +
// coverage-guard behavior end-to-end (kept out of plannerLoop.test.ts to hold that
// file's 500-line cap). The workflow-level seam (`materializeTriageNewSpecs`) lives
// in `triageNewSpecsMaterialize.test.ts`.
import { describe, expect, it } from "vitest";
import type { TriageWorkItem, AuditAnswer, TriageAnswer } from "../src/engine/answerers/schemas/index.js";
import type { Finding } from "../src/engine/contracts/findings.js";
import { ensureFindingCoverage } from "../src/engine/workflow/loopFindings.js";
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

// ---------------------------------------------------------------------------
// Codex critic RA1 (pre-apex-v80) — the coverage guard must also gate PARTIAL
// coverage, not just empty workItems. If triage returns any workItems whose union
// of `findingIds` is a STRICT SUBSET of the input findings, the uncovered findings
// would otherwise be silently dropped downstream (`summarizeTriageRouting` +
// materialization only see what triage returned). The tests below pin the guard's
// three shapes as pure-function contracts on `ensureFindingCoverage`.
const makeFinding = (id: string): Finding => ({
  id,
  severity: "P1",
  title: `title-${id}`,
  body: `body-${id}`,
});
const makeWorkItem = (id: string, findingIds: readonly string[]): TriageWorkItem => ({
  id,
  kind: "task",
  severity: "P1",
  title: `wi-${id}`,
  body: `body-${id}`,
  findingIds: [...findingIds],
});

describe("apex v80 loop closure — ensureFindingCoverage (Codex critic RA1: partial coverage)", () => {
  it("partial coverage synthesizes a P0 for the UNCOVERED findings only (does NOT silently drop them)", () => {
    // 3 findings; triage's workItems cover findings [0] and [2] but omit [1] from
    // every `findingIds` trail. The guard must append a coverage-gap P0 subsuming
    // ONLY finding [1] (the strict-subset silent-drop path the initial v79 fix missed).
    const findings = [makeFinding("f0"), makeFinding("f1"), makeFinding("f2")];
    const workItems = [makeWorkItem("wi-a", ["f0"]), makeWorkItem("wi-b", ["f2"])];
    const result = ensureFindingCoverage(workItems, findings, "triage_task_1");
    // The kept workItems pass through unchanged (order + trail preserved).
    expect(result).toHaveLength(3);
    expect(result[0]).toBe(workItems[0]);
    expect(result[1]).toBe(workItems[1]);
    // The appended gap-item subsumes ONLY the uncovered finding f1 — NOT the whole set.
    const gap = result[2]!;
    expect(gap.id).toBe("triage-coverage-gap-triage_task_1");
    expect(gap.kind).toBe("task");
    expect(gap.severity).toBe("P0");
    expect(gap.findingIds).toEqual(["f1"]);
    expect(gap.title).toMatch(/partial coverage/iu);
    expect(gap.body).toContain("f1");
    // Sanity: the covered findings must NOT reappear in the gap trail.
    expect(gap.findingIds).not.toContain("f0");
    expect(gap.findingIds).not.toContain("f2");
  });

  it("full coverage passes workItems through unchanged (no synthetic gap-item appended)", () => {
    // Every finding id appears in some workItem's `findingIds` (possibly across items,
    // possibly with overlap) — the guard is a no-op.
    const findings = [makeFinding("f0"), makeFinding("f1"), makeFinding("f2")];
    const workItems = [makeWorkItem("wi-a", ["f0", "f1"]), makeWorkItem("wi-b", ["f2", "f0"])];
    const result = ensureFindingCoverage(workItems, findings, "triage_task_1");
    expect(result).toBe(workItems);
  });

  it("empty workItems on non-empty findings still fires the pre-existing empty-workItems P0 synthesis", () => {
    // Regression guard: the partial-coverage extension must not weaken the original
    // empty-workItems fail-closed path (a single P0 subsuming EVERY finding).
    const findings = [makeFinding("f0"), makeFinding("f1")];
    const result = ensureFindingCoverage([], findings, "triage_task_1");
    expect(result).toHaveLength(1);
    const gap = result[0]!;
    expect(gap.id).toBe("triage-coverage-gap-triage_task_1");
    expect(gap.kind).toBe("task");
    expect(gap.severity).toBe("P0");
    // Every input finding is subsumed (not just uncovered — there were no covered ones).
    expect(gap.findingIds).toEqual(["f0", "f1"]);
    expect(gap.title).toMatch(/no work items/iu);
  });

  it("empty findings passes workItems through unchanged (no synthesis on a clean pass)", () => {
    // A clean pass — empty findings ⇒ empty (or non-empty) workItems is legal; nothing to cover.
    const empty = ensureFindingCoverage([], [], "triage_task_1");
    expect(empty).toEqual([]);
    const workItems = [makeWorkItem("wi-a", [])];
    const kept = ensureFindingCoverage(workItems, [], "triage_task_1");
    expect(kept).toBe(workItems);
  });
});
