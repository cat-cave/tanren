// Unit tests for the `auditPosture` policy (tanren-owns-the-engine.md §4) — the
// DORA knob. These pin the PURE `decideFromFindings` semantics: blocks when max
// severity is at-or-above `blockReviewAt`; routes/fixes the residual P2/P3 per
// `p2p3Handling`; and the SAME findings block under strict (`blockReviewAt:'P3'`)
// and route under velocity (`blockReviewAt:'P1', route-to-dag`).

import { describe, expect, it } from "vitest";
import {
  decideFromFindings,
  postureReentersFindings,
  type AuditPosture,
} from "../src/engine/contracts/auditPosture.js";
import { maxSeverity, severityRank, type Finding } from "../src/engine/contracts/findings.js";

const STRICT: AuditPosture = { blockReviewAt: "P3", p2p3Handling: "fix-if-idle" };
const VELOCITY: AuditPosture = { blockReviewAt: "P1", p2p3Handling: "route-to-dag" };
const MODERATE_FIX: AuditPosture = { blockReviewAt: "P1", p2p3Handling: "fix-if-idle" };
const AUTONOMOUS: AuditPosture = { blockReviewAt: "P1", p2p3Handling: "route-to-dag", autonomousRemediation: true };

function finding(severity: Finding["severity"], id = `f-${severity}`): Finding {
  return { id, severity, title: `t-${severity}`, body: `b-${severity}` };
}

describe("findings severity helpers", () => {
  it("ranks P0 most severe (lowest rank) through P3", () => {
    expect(severityRank("P0")).toBeLessThan(severityRank("P1"));
    expect(severityRank("P1")).toBeLessThan(severityRank("P2"));
    expect(severityRank("P2")).toBeLessThan(severityRank("P3"));
  });

  it("maxSeverity returns the most-severe present, undefined when empty", () => {
    expect(maxSeverity([])).toBeUndefined();
    expect(maxSeverity([finding("P3"), finding("P1"), finding("P2")])).toBe("P1");
    expect(maxSeverity([finding("P2"), finding("P0")])).toBe("P0");
  });
});

describe("decideFromFindings — blocks when maxSeverity >= blockReviewAt", () => {
  it("blocks under velocity (block at P1) when a P0 is present", () => {
    const d = decideFromFindings([finding("P0"), finding("P3")], VELOCITY);
    expect(d.block).toBe(true);
  });

  it("blocks under velocity when a P1 is present (exactly at threshold)", () => {
    expect(decideFromFindings([finding("P1")], VELOCITY).block).toBe(true);
  });

  it("does NOT block under velocity when only P2/P3 are present (below threshold)", () => {
    expect(decideFromFindings([finding("P2"), finding("P3")], VELOCITY).block).toBe(false);
  });

  it("does NOT block on an empty findings list under any posture", () => {
    expect(decideFromFindings([], STRICT).block).toBe(false);
    expect(decideFromFindings([], VELOCITY).block).toBe(false);
  });
});

describe("decideFromFindings — routes/fixes P2/P3 per p2p3Handling", () => {
  it("routes the residual P2/P3 to the DAG under route-to-dag (nothing fixed in place)", () => {
    const d = decideFromFindings([finding("P2"), finding("P3")], VELOCITY);
    expect(d.route.map((f) => f.severity).sort()).toEqual(["P2", "P3"]);
    expect(d.fixInPlace).toEqual([]);
  });

  it("fixes the residual P2/P3 in place under fix-if-idle (nothing routed)", () => {
    const d = decideFromFindings([finding("P2"), finding("P3")], MODERATE_FIX);
    expect(d.fixInPlace.map((f) => f.severity).sort()).toEqual(["P2", "P3"]);
    expect(d.route).toEqual([]);
  });

  it("never routes/fixes a BLOCKING finding — only the below-threshold residual", () => {
    // P0 blocks under velocity; only the P3 is residual and routed.
    const d = decideFromFindings([finding("P0"), finding("P3")], VELOCITY);
    expect(d.block).toBe(true);
    expect(d.route.map((f) => f.severity)).toEqual(["P3"]);
  });
});

describe("decideFromFindings — autonomousRemediation routes blocking findings as remediation specs", () => {
  it("under autonomousRemediation, a BLOCKING P0/P1 becomes a remediation spec (still blocks) AND P2/P3 route", () => {
    const d = decideFromFindings([finding("P0"), finding("P2"), finding("P3")], AUTONOMOUS);
    // The current spec still fails closed.
    expect(d.block).toBe(true);
    // The blocking P0 ALSO becomes fix-it work (re-enters the DAG), not just parked.
    expect(d.remediate.map((f) => f.severity)).toEqual(["P0"]);
    // The residual P2/P3 route as before.
    expect(d.route.map((f) => f.severity).sort()).toEqual(["P2", "P3"]);
  });

  it("WITHOUT autonomousRemediation a blocking finding parks (remediate is empty) — the human-stop default", () => {
    const d = decideFromFindings([finding("P0")], VELOCITY);
    expect(d.block).toBe(true);
    expect(d.remediate).toEqual([]);
  });
});

describe("postureReentersFindings — the preflight predicate", () => {
  it("an autonomous run REQUIRES remediation: a parking posture strands, the autonomous posture re-enters", () => {
    // requireRemediation=true (autonomous): the balanced default strands a blocking finding.
    expect(postureReentersFindings(MODERATE_FIX, true)).toBe(false);
    // VELOCITY routes the residual but still PARKS a blocking finding ⇒ strands under autonomy.
    expect(postureReentersFindings(VELOCITY, true)).toBe(false);
    expect(postureReentersFindings(AUTONOMOUS, true)).toBe(true);
  });

  it("a non-autonomous run does NOT require remediation: any residual-handling posture re-enters", () => {
    expect(postureReentersFindings(MODERATE_FIX, false)).toBe(true);
    expect(postureReentersFindings(VELOCITY, false)).toBe(true);
    expect(postureReentersFindings(STRICT, false)).toBe(true);
  });
});

describe("decideFromFindings — DORA knob: same findings, different posture", () => {
  it("SAME findings block under strict (P3) and route under velocity (P1, route-to-dag)", () => {
    const findings = [finding("P2"), finding("P3")];

    // Strict blocks on even P3, so nothing is routed (the findings blocked).
    const strict = decideFromFindings(findings, STRICT);
    expect(strict.block).toBe(true);
    expect(strict.route).toEqual([]);

    // Velocity blocks on nothing below P1, so the SAME findings route into the DAG.
    const velocity = decideFromFindings(findings, VELOCITY);
    expect(velocity.block).toBe(false);
    expect(velocity.route.map((f) => f.severity).sort()).toEqual(["P2", "P3"]);
  });
});
