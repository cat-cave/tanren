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
import { maxSeverity } from "../src/engine/contracts/findings.js";
import { findingsFromPayload } from "../src/engine/dag/lifecycle.js";

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

  it("an audit verdict (empty findings = clean) is audited", () => {
    const life = projectSpecLifecycle(
      signals({
        prOpened: true,
        ciPassed: true,
        auditVerdict: { findings: [] },
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

describe("projectSpecLifecycle — open-finding max severity (S3: findings-only)", () => {
  it("an un-audited run is unaudited (the moderate gate treats this as not-ready)", () => {
    expect(projectSpecLifecycle(signals({ prOpened: true, ciPassed: true })).openFindingMaxSeverity).toBe("unaudited");
  });
});

describe("projectSpecLifecycle — EXPLICIT findings are the SOLE severity (S3: inferred severity deleted)", () => {
  it("reads the max severity DIRECTLY off the explicit findings list", () => {
    const life = projectSpecLifecycle(
      signals({
        prOpened: true,
        ciPassed: true,
        auditVerdict: {
          findings: [
            { id: "f-p2", severity: "P2", title: "polish", body: "b" },
            { id: "f-p1", severity: "P1", title: "blocker", body: "b" },
          ],
        },
      }),
    );
    expect(life.openFindingMaxSeverity).toBe("P1");
  });

  it("a single P0 finding → P0", () => {
    const life = projectSpecLifecycle(
      signals({ auditVerdict: { findings: [{ id: "f-p0", severity: "P0", title: "blocker", body: "b" }] } }),
    );
    expect(life.openFindingMaxSeverity).toBe("P0");
  });

  it("an EMPTY explicit findings list is audited-clean (none)", () => {
    const life = projectSpecLifecycle(signals({ prOpened: true, ciPassed: true, auditVerdict: { findings: [] } }));
    expect(life.openFindingMaxSeverity).toBe("none");
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

describe("findingsFromPayload — S3a fail-closed: unreadable ⇒ P0, clean ONLY from explicit []", () => {
  it("a well-formed (possibly-empty) array stays as is — an EXPLICIT [] is audited-clean", () => {
    expect(findingsFromPayload([])).toEqual([]);
    const one = findingsFromPayload([{ id: "f", severity: "P2", title: "t", body: "b" }]);
    expect(one.map((f) => f.severity)).toEqual(["P2"]);
  });

  it("null findings on a PRESENT verdict ⇒ a synthetic P0 (un-audited), NEVER clean []", () => {
    const findings = findingsFromPayload(null);
    expect(maxSeverity(findings)).toBe("P0");
    expect(findings).not.toEqual([]);
  });

  it("a non-array (malformed) findings column ⇒ a synthetic P0, NEVER clean []", () => {
    expect(maxSeverity(findingsFromPayload("oops"))).toBe("P0");
    expect(maxSeverity(findingsFromPayload({ not: "an array" }))).toBe("P0");
    expect(maxSeverity(findingsFromPayload(42))).toBe("P0");
  });

  it("a malformed ENTRY inside the array throws LOUDLY (never silently degrades to clean)", () => {
    // A present array whose element is not a valid AuditFinding must throw, not coalesce.
    expect(() => findingsFromPayload([{ id: "f", severity: "NOPE", title: "t", body: "b" }])).toThrow(
      /severity|enum|Invalid/iu,
    );
  });
});
