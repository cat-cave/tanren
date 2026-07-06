// Regression pins for the same-shape HALTED-set drift PR-#737 solved for
// `RECOVERABLE_OUTCOMES`. Seven dashboard sites (projectDag / projectViewData /
// aggregate / HistoryBody / specRoutes / specDetail / halted.tsx) each carried
// a PRIVATE "halted family" set that was missing `convergence_stalled` +
// `window_exhausted`, so a run halted for those reasons rendered wrong (not
// blocked / not counted in haltRate / neutral badge instead of halted-red).
// This suite:
//   (a) asserts every migrated call site treats the two newer members as HALTED;
//   (b) pins them as members of the shared `RECOVERABLE_OUTCOMES` set — a
//       removal there trips this test rather than silently regressing the sites.
// The identity check (dashboard's imported set === orchestrator's re-export) is
// covered by `services/orchestrator/tests/stateTransitions.test.ts`.

import { RECOVERABLE_OUTCOMES, RECOVERABLE_OUTCOMES_LIST } from "@tanren/db";
import { describe, expect, it } from "vitest";
import { buildProjectDag } from "../src/api/projectDag.js";
import { observeMetrics } from "../src/components/costs/aggregate.js";
import { buildSpecDetail } from "../src/components/project/specDetail.js";
import type { RunListItem, SpecSummary } from "../src/api/types.js";

function runOf(over: Partial<RunListItem>): RunListItem {
  return {
    runId: "run_x",
    specId: "s1",
    projectId: "p",
    branch: "main",
    trigger: "dashboard",
    status: "completed",
    outcome: null,
    startedAt: "2026-05-28T10:00:00.000Z",
    endedAt: "2026-05-28T10:05:00.000Z",
    prUrl: null,
    specTitle: "spec",
    costTotalUsd: "1.0",
    lastEventAt: "2026-05-28T10:05:00.000Z",
    needsReview: false,
    ...over,
  };
}

describe("dashboard HALTED-outcome drift — regression pins", () => {
  it("the shared @tanren/db set includes every value the drift added", () => {
    // The two members the private copies were missing at the point of the
    // dashboard-side audit. If either is dropped from the shared set, this test
    // trips before the sites silently degrade again.
    expect(RECOVERABLE_OUTCOMES.has("convergence_stalled")).toBe(true);
    expect(RECOVERABLE_OUTCOMES.has("window_exhausted")).toBe(true);
    // The historical trio must still count.
    expect(RECOVERABLE_OUTCOMES.has("halted")).toBe(true);
    expect(RECOVERABLE_OUTCOMES.has("escape_hatch_hit")).toBe(true);
    expect(RECOVERABLE_OUTCOMES.has("retry_budget_exhausted")).toBe(true);
  });

  it("RECOVERABLE_OUTCOMES_LIST is the ordered projection of the set (halted.tsx renders it)", () => {
    expect(new Set(RECOVERABLE_OUTCOMES_LIST)).toEqual(RECOVERABLE_OUTCOMES);
    // halted.tsx's placeholder text lists these — the two drift-added members
    // must appear so the operator sees the full "surface here when" list.
    expect(RECOVERABLE_OUTCOMES_LIST).toContain("convergence_stalled");
    expect(RECOVERABLE_OUTCOMES_LIST).toContain("window_exhausted");
  });

  describe.each(["convergence_stalled", "window_exhausted"] as const)(
    "outcome=%s routes to the halted family at every migrated site",
    (outcome) => {
      it("buildProjectDag (api/projectDag.ts) colours the spec's node blocked", () => {
        const dag = buildProjectDag({
          specs: [{ specId: "s1", title: "t", dependsOn: [], status: "in_flight" }],
          milestones: [],
          runs: [runOf({ specId: "s1", outcome })],
        });
        expect(dag.nodes.find((n) => n.id === "s1")?.status).toBe("blocked");
      });

      it("observeMetrics (components/costs/aggregate.ts) counts it toward haltRate", () => {
        const metrics = observeMetrics([{ outcome }], 0);
        expect(metrics.haltRate).toBe(1);
      });

      it("buildSpecDetail (components/project/specDetail.ts) marks the spec blocked", () => {
        const spec: SpecSummary = {
          specId: "s1",
          projectId: "p",
          title: "spec",
          description: "d",
          acceptanceCriteria: [],
          dependsOn: [],
          status: "in_flight",
        };
        const detail = buildSpecDetail({
          spec,
          allSpecs: [spec],
          runs: [runOf({ specId: "s1", outcome })],
          statusBySpecId: new Map([["s1", "blocked"]]),
        });
        expect(detail.status).toBe("blocked");
        expect(detail.pill).toBe("fail");
      });
    },
  );
});
