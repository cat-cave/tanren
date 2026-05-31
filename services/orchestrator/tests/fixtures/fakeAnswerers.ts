// TEST FIXTURE ONLY. Fake planner/checker/auditor answerer adapters — synthetic
// stand-ins that return fixed structured answers. They MUST NOT exist in any
// production/runtime path: production code resolves real answerer adapters from
// the project's role-routing config. These live under tests/ so they are
// unreachable from src/.
//
// Self-hosted billing attribution: PROJECT_BRIEF §4.2 treats fixed-fee local
// compute as a self-hosted endpoint with no per-call dollar basis, so cost
// recording writes cost_usd = NULL / cost_basis = 'unknown'. Token accounting
// still lands.
import type { AuditAnswer, CheckAnswer, PlanAnswer } from "../../src/engine/providers/answererSchemas.js";
import type { AnswererAdapter } from "../../src/engine/providers/types.js";

export const fakeSelfHostedAuthRef = "credential/self-hosted/tanren-fake";

export const fakePlanner: AnswererAdapter<PlanAnswer> = {
  kind: "answerer",
  cli: "fake",
  authRef: fakeSelfHostedAuthRef,
  async runAnswerer() {
    return {
      subtasks: [
        {
          title: "Return hello-world status",
          acceptanceCriteria: ["The orchestrator persists a completed synthetic run"],
        },
      ],
    };
  },
};

export const fakeChecker: AnswererAdapter<CheckAnswer> = {
  kind: "answerer",
  cli: "fake",
  authRef: fakeSelfHostedAuthRef,
  async runAnswerer() {
    return {
      done: true,
      reason: "Synthetic writer output satisfies the hello-world criteria.",
      suggested_fixes: null,
    };
  },
};

export const fakeAuditor: AnswererAdapter<AuditAnswer> = {
  kind: "answerer",
  cli: "fake",
  authRef: fakeSelfHostedAuthRef,
  async runAnswerer() {
    return {
      verified: true,
      criteria_status: {
        criteria: [
          {
            criterion: "The orchestrator persists a completed synthetic run",
            satisfied: true,
            reason: "The structured checker accepted the writer output.",
          },
        ],
      },
      reason: "All hello-world checks completed.",
    };
  },
};
