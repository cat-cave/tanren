// WAVE-2 / SLICE P-A behavior tests (tanren-owns-the-engine.md §4): the auditor
// emits explicit P0–P3 findings (no inferred verdict on the finding itself) and
// the per-project `auditPosture` DORA knob turns the SAME findings list into
// `block` / `route` / `fix-in-place`. These pin:
//   (a) a P0 defect parses to a Finding{ severity: 'P0' } with NO verdict field;
//   (b) the DORA knob — the SAME findings block under strict and route under velocity;
//   (c) P0/P1 block review; P2/P3 fix-in-place-if-idle else route-as-spec.

import { describe, expect, it } from "vitest";
import { AuditAnswer, AuditFinding } from "../src/engine/answerers/schemas/index.js";
import type { AuditPosture } from "../src/engine/contracts/auditPosture.js";
import type { Finding } from "../src/engine/contracts/findings.js";
import { evaluatePostureGate, findingToRoutableSpec } from "../src/engine/forge/audits/postureGate.js";

const STRICT: AuditPosture = { blockReviewAt: "P3", p2p3Handling: "fix-if-idle" };
const VELOCITY: AuditPosture = { blockReviewAt: "P1", p2p3Handling: "route-to-dag" };
const BALANCED_FIX: AuditPosture = { blockReviewAt: "P1", p2p3Handling: "fix-if-idle" };

function finding(severity: Finding["severity"], id = `f-${severity}`): Finding {
  return { id, severity, title: `t-${severity}`, body: `b-${severity}` };
}

describe("(a) the auditor emits explicit P0 findings — no verdict field on the finding", () => {
  it("a P0 defect parses to a Finding with severity 'P0' and no pass/recommendedAction key", () => {
    const parsed = AuditFinding.parse({
      id: "null-deref",
      severity: "P0",
      title: "Null deref crashes import",
      body: "x.y read when x is null.",
    });
    expect(parsed.severity).toBe("P0");
    // The finding carries NO verdict — severity is the explicit field, period.
    expect(parsed).not.toHaveProperty("passed");
    expect(parsed).not.toHaveProperty("recommendedAction");
    expect(parsed).not.toHaveProperty("verdict");
  });

  it("the auditor answer is findings-only (the findings ARE the verdict)", () => {
    const answer = AuditAnswer.parse({
      findings: [{ id: "p0", severity: "P0", title: "blocker", body: "b" }],
    });
    expect(answer.findings).toHaveLength(1);
    expect(answer.findings[0]?.severity).toBe("P0");
    expect(answer).not.toHaveProperty("passed");
    expect(answer).not.toHaveProperty("recommendedAction");
  });
});

describe("(b) DORA knob — the SAME findings block under strict and route under velocity", () => {
  it("[P2,P3] block under strict {blockReviewAt:'P3'} and route under velocity {blockReviewAt:'P1',route-to-dag}", () => {
    const findings = [finding("P2"), finding("P3")];

    const strict = evaluatePostureGate(findings, STRICT, { idleAwaitingReview: true });
    expect(strict.decision.block).toBe(true);
    expect(strict.routeSpecs).toEqual([]);

    const velocity = evaluatePostureGate(findings, VELOCITY, { idleAwaitingReview: true });
    expect(velocity.decision.block).toBe(false);
    expect(velocity.routeSpecs.map((s) => s.title).sort()).toEqual(["t-P2", "t-P3"]);
  });
});

describe("(c) P0/P1 block review; P2/P3 fix-in-place-if-idle else route-as-spec", () => {
  it("P0 blocks review under the balanced posture (P0/P1 block)", () => {
    const r = evaluatePostureGate([finding("P0")], BALANCED_FIX, { idleAwaitingReview: true });
    expect(r.decision.block).toBe(true);
  });

  it("P1 blocks review (exactly at the threshold)", () => {
    expect(evaluatePostureGate([finding("P1")], BALANCED_FIX, { idleAwaitingReview: false }).decision.block).toBe(true);
  });

  it("P2/P3 fix in place when the spec IDLES awaiting review (fix-if-idle)", () => {
    const r = evaluatePostureGate([finding("P2"), finding("P3")], BALANCED_FIX, { idleAwaitingReview: true });
    expect(r.decision.block).toBe(false);
    expect(r.fixInPlace.map((f) => f.severity).sort()).toEqual(["P2", "P3"]);
    expect(r.routeSpecs).toEqual([]);
  });

  it("P2/P3 are CARRIED FORWARD (not fixed) while the run is still live (not idle)", () => {
    const r = evaluatePostureGate([finding("P2")], BALANCED_FIX, { idleAwaitingReview: false });
    expect(r.fixInPlace).toEqual([]);
    expect(r.dispositions.map((d) => d.action)).toEqual(["carryForward"]);
  });

  it("P2/P3 route as DAG specs under route-to-dag, regardless of idle", () => {
    const r = evaluatePostureGate([finding("P2"), finding("P3")], VELOCITY, { idleAwaitingReview: false });
    expect(r.routeSpecs).toHaveLength(2);
    expect(r.fixInPlace).toEqual([]);
  });

  it("a blocking finding is NEVER routed/fixed — only the below-threshold residual", () => {
    // P0 blocks under velocity; only the P3 routes.
    const r = evaluatePostureGate([finding("P0"), finding("P3")], VELOCITY, { idleAwaitingReview: true });
    expect(r.decision.block).toBe(true);
    expect(r.routeSpecs.map((s) => s.title)).toEqual(["t-P3"]);
  });
});

describe("findingToRoutableSpec — the intake auto-route shape", () => {
  it("uses the fixHint as the acceptance criterion when present", () => {
    const spec = findingToRoutableSpec({
      id: "x",
      severity: "P2",
      title: "tidy",
      body: "body",
      fixHint: "do the thing",
    });
    expect(spec.acceptanceCriteria).toEqual(["do the thing"]);
    expect(spec.title).toBe("tidy");
    expect(spec.description).toBe("body");
    expect(spec.dependsOn).toEqual([]);
  });

  it("synthesizes a resolve-the-finding criterion when no fixHint is given", () => {
    const spec = findingToRoutableSpec(finding("P3"));
    expect(spec.acceptanceCriteria[0]).toContain("t-P3");
  });
});
