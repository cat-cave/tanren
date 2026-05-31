import type { AuditAnswer, CheckAnswer, PlanAnswer } from "./answererSchemas.js";
import type { AnswererAdapter } from "./types.js";

// Fake answerers used by the synthetic hello connectivity fixture are attributed
// as self-hosted billing. PROJECT_BRIEF §4.2 treats fixed-fee local compute as a
// self-hosted endpoint with no per-call dollar basis, so the recorder writes
// cost_usd = NULL / cost_basis = 'unknown'. Token accounting still lands.
//
// NOTE: there is intentionally NO fake WRITER adapter here. The fake writer is a
// TEST FIXTURE ONLY (tests/fixtures/fakeWriter.ts) so production code can never
// construct it; the real run path's writer is selected by role-routing config.
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
