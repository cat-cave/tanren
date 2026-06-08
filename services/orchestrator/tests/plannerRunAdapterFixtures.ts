// Adapter-set fixtures for the planner-run tests (SPEC-LOOP REDESIGN). Extracted from
// plannerRun.fixtures.ts to keep that file under the 500-line cap. Builds the FULL
// SubtaskLoopAdapters set (planner/writer/checker/auditor + triage/convergence/demoRun)
// for tests that previously listed only the four core roles.
import type { AuditAnswer, CheckAnswer, PlanAnswer } from "../src/engine/answerers/schemas/index.js";
import type { AnswererAdapter } from "../src/engine/usage/index.js";
import {
  buildPlan,
  cleanAudit,
  convergenceProgress,
  makeAuditor,
  makeChecker,
  makeConvergence,
  makeDemoRun,
  makePlanner,
  makeTriage,
  makeWriter,
  triageAllTasks,
} from "./helpers/plannerLoopHelpers.js";

// The SPEC-LOOP REDESIGN stage adapters (triage/convergence/demoRun) defaulted to a
// clean pass, for inline adapter blocks that list only the four core roles.
export function loopStageAdapters() {
  return {
    triage: makeTriage([triageAllTasks]),
    convergence: makeConvergence([convergenceProgress]),
    demoRun: makeDemoRun([{ findings: [], summary: "ok" }]),
  };
}

export function twoSubtaskAdapters(checks: ReadonlyArray<CheckAnswer>) {
  return {
    planner: makePlanner([
      buildPlan([
        { title: "T1", intent: "add ok()", behaviorIds: [] },
        { title: "T2", intent: "add fail()", behaviorIds: [] },
      ]),
    ]) as AnswererAdapter<PlanAnswer>,
    writer: makeWriter(["diff ok\n", "diff fail\n"]),
    checker: makeChecker(checks) as AnswererAdapter<CheckAnswer>,
    auditor: makeAuditor([cleanAudit]) as AnswererAdapter<AuditAnswer>,
    // SPEC-LOOP REDESIGN stages — default to a clean pass (no findings ⇒ no triage runs).
    ...loopStageAdapters(),
  };
}
