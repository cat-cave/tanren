// (autonomy-engine.md §2c): the pure lifecycle projection. Proves each
// lifecycle state + open-finding max severity is DERIVED correctly from the spec
// status + the latest run's lifecycle-event signals — the input the speculation
// threshold reasons over.

import { describe, expect, it } from "vitest";
import {
  isBlockingForModerate,
  lifecycleRank,
  projectSpecLifecycle,
  severityRank,
  type SpecLifecycleSignals,
} from "../src/engine/contracts/dagLifecycle.js";

function signals(overrides: Partial<SpecLifecycleSignals>): SpecLifecycleSignals {
  return {
    specId: "spec_x",
    specStatus: "in_flight",
    hasRun: true,
    prOpened: false,
    ciPassed: false,
    ...overrides,
  };
}

describe("projectSpecLifecycle — state derivation", () => {
  it("a spec with no run is pending (unaudited)", () => {
    const life = projectSpecLifecycle(signals({ specStatus: "pending", hasRun: false }));
    expect(life.state).toBe("pending");
    expect(life.openFindingMaxSeverity).toBe("unaudited");
  });

  it("a started run with no PR yet is building", () => {
    expect(projectSpecLifecycle(signals({ runStatus: "running" })).state).toBe("building");
  });

  it("a PR open but no CI is pr_open", () => {
    expect(projectSpecLifecycle(signals({ prOpened: true })).state).toBe("pr_open");
  });

  it("CI passed but no audit is ci_green", () => {
    expect(projectSpecLifecycle(signals({ prOpened: true, ciPassed: true })).state).toBe("ci_green");
  });

  it("an audit verdict is audited", () => {
    const life = projectSpecLifecycle(
      signals({
        prOpened: true,
        ciPassed: true,
        auditVerdict: { passed: true, recommendedAction: "pass", outstandingCount: 0 },
      }),
    );
    expect(life.state).toBe("audited");
    expect(life.openFindingMaxSeverity).toBe("none");
  });

  it("a review verdict is review (auto/human channel preserved)", () => {
    const auto = projectSpecLifecycle(
      signals({ prOpened: true, ciPassed: true, review: { channel: "auto", verdict: "approved" } }),
    );
    expect(auto.state).toBe("review");
    expect(auto.review).toEqual({ channel: "auto", verdict: "approved" });
  });

  it("the merged spec status is merged (the terminal authority)", () => {
    expect(projectSpecLifecycle(signals({ specStatus: "merged" })).state).toBe("merged");
  });

  it("a halted/cancelled spec is blocked (never a satisfied ancestor)", () => {
    expect(projectSpecLifecycle(signals({ specStatus: "halted" })).state).toBe("blocked");
    expect(projectSpecLifecycle(signals({ specStatus: "cancelled" })).state).toBe("blocked");
  });

  it("a terminally-failed run (no merge) is blocked", () => {
    expect(projectSpecLifecycle(signals({ runStatus: "failed" })).state).toBe("blocked");
  });
});

describe("projectSpecLifecycle — open-finding max severity (the moderate gate input)", () => {
  it("recommendedAction halt → P0", () => {
    const life = projectSpecLifecycle(
      signals({ auditVerdict: { passed: false, recommendedAction: "halt", outstandingCount: 1 } }),
    );
    expect(life.openFindingMaxSeverity).toBe("P0");
  });

  it("loop_to_planner (or passed:false) → P1", () => {
    expect(
      projectSpecLifecycle(
        signals({ auditVerdict: { passed: false, recommendedAction: "loop_to_planner", outstandingCount: 1 } }),
      ).openFindingMaxSeverity,
    ).toBe("P1");
  });

  it("passed with outstanding behaviors → P2 (non-blocking polish)", () => {
    expect(
      projectSpecLifecycle(signals({ auditVerdict: { passed: true, recommendedAction: "pass", outstandingCount: 3 } }))
        .openFindingMaxSeverity,
    ).toBe("P2");
  });

  it("passed clean → none", () => {
    expect(
      projectSpecLifecycle(signals({ auditVerdict: { passed: true, recommendedAction: "pass", outstandingCount: 0 } }))
        .openFindingMaxSeverity,
    ).toBe("none");
  });

  it("an un-audited run is unaudited (the moderate gate treats this as not-ready)", () => {
    expect(projectSpecLifecycle(signals({ prOpened: true, ciPassed: true })).openFindingMaxSeverity).toBe("unaudited");
  });
});

describe("projectSpecLifecycle — EXPLICIT findings win (WAVE-2: kill inferred severity)", () => {
  it("reads the max severity DIRECTLY off explicit findings, not from passed/recommendedAction", () => {
    // passed=true + recommendedAction=pass would INFER `none`; the explicit P1
    // finding overrides — the severity is read off the findings, never inferred.
    const life = projectSpecLifecycle(
      signals({
        prOpened: true,
        ciPassed: true,
        auditVerdict: {
          passed: true,
          recommendedAction: "pass",
          outstandingCount: 0,
          findings: [
            { id: "f-p2", severity: "P2", title: "polish", body: "b" },
            { id: "f-p1", severity: "P1", title: "blocker", body: "b" },
          ],
        },
      }),
    );
    expect(life.openFindingMaxSeverity).toBe("P1");
  });

  it("an EMPTY explicit findings list is audited-clean (none), even with passed=false legacy fields", () => {
    const life = projectSpecLifecycle(
      signals({
        prOpened: true,
        ciPassed: true,
        // Legacy inference would yield P1 (passed=false); explicit empty findings win.
        auditVerdict: { passed: false, recommendedAction: "loop_to_planner", outstandingCount: 2, findings: [] },
      }),
    );
    expect(life.openFindingMaxSeverity).toBe("none");
  });

  it("falls back to legacy inference ONLY when findings are absent (dual-emit transition)", () => {
    const life = projectSpecLifecycle(
      signals({ auditVerdict: { passed: false, recommendedAction: "halt", outstandingCount: 1 } }),
    );
    expect(life.openFindingMaxSeverity).toBe("P0");
  });
});

describe("rank helpers", () => {
  it("lifecycle rank is monotonic along the ladder", () => {
    expect(lifecycleRank("building")).toBeLessThan(lifecycleRank("pr_open"));
    expect(lifecycleRank("ci_green")).toBeLessThan(lifecycleRank("audited"));
    expect(lifecycleRank("audited")).toBeLessThan(lifecycleRank("merged"));
    // blocked is off the ladder (below everything reachable).
    expect(lifecycleRank("blocked")).toBeLessThan(lifecycleRank("pending"));
  });

  it("isBlockingForModerate: P0/P1/unaudited block; P2/P3/none do not", () => {
    expect(isBlockingForModerate("P0")).toBe(true);
    expect(isBlockingForModerate("P1")).toBe(true);
    expect(isBlockingForModerate("unaudited")).toBe(true);
    expect(isBlockingForModerate("P2")).toBe(false);
    expect(isBlockingForModerate("P3")).toBe(false);
    expect(isBlockingForModerate("none")).toBe(false);
  });

  it("severity rank orders none < P2 < unaudited < P1 < P0", () => {
    expect(severityRank("none")).toBeLessThan(severityRank("P2"));
    expect(severityRank("P2")).toBeLessThan(severityRank("unaudited"));
    expect(severityRank("unaudited")).toBeLessThan(severityRank("P1"));
    expect(severityRank("P1")).toBeLessThan(severityRank("P0"));
  });
});
