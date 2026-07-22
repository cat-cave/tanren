// The runtime-behavior e2e driver test (audit §6.8).
//
// REGRESSION-PIN for the runtime behavior run: the hermetic, in-process runtime behavior driver
// (runtimeBehaviorE2eDriver.drive.ts `driveRuntimeBehavior`) drives the FULL autonomy-loop proof surface against the
// e2e harness's existing fakes + the engine's REAL pure decision functions, with
// NO network / NO real creds / NO real Postgres. It therefore runs in
// `just fast-check` — so the runtime behavior proof surface is reproducible in CI, not just
// anecdotal in a credentialed live run. Each `it` asserts one autonomy-loop STAGE
// left its real artifact; the final `it` asserts they compose into one run.

import { describe, expect, it } from "vitest";
import { driveRuntimeBehavior } from "./runtimeBehaviorE2eDriver.drive.js";
import {
  RUNTIME_BEHAVIOR_OPERATOR_NOTES,
  RUNTIME_BEHAVIOR_TEMPLATE_SEED,
  type RuntimeBehaviorProof,
} from "./runtimeBehaviorE2eDriver.js";

describe("runtime behavior e2e driver — the full autonomy-loop proof surface (hermetic)", () => {
  // One healthy runtime behavior run drives every stage; the per-stage `it`s assert its proof.
  let proof: RuntimeBehaviorProof;

  it("drives a healthy runtime behavior run from rough operator notes (no creds, no network)", async () => {
    expect(RUNTIME_BEHAVIOR_OPERATOR_NOTES).toMatch(/url shortener/iu);
    proof = await driveRuntimeBehavior();
    expect(proof).toBeDefined();
  });

  it("STAGE 1 — derives from a FAKE TEMPLATE SEED (v32 runs templated), not from-scratch", () => {
    expect(proof.templateRef).toBe(RUNTIME_BEHAVIOR_TEMPLATE_SEED.templateRef);
    // The seed materializes the contract files on the greenfield base.
    expect(proof.seededFiles).toContain(".tanren/ci.yml");
    expect(proof.seededFiles).toContain("justfile");
    // The notes become a prioritized, dependency-aware DAG (API → web + slack).
    expect(proof.derivedSpecIds).toEqual(["spec_api", "spec_web", "spec_slack"]);
  });

  it("STAGE 2 — every derived spec lands as a MERGED PR with the implemented file on base", () => {
    expect(proof.mergedPrs.map((p) => p.specId)).toEqual(["spec_api", "spec_web", "spec_slack"]);
    for (const pr of proof.mergedPrs) {
      // A real merged PR url + a real merge commit sha (the CAS land advanced main).
      expect(pr.prUrl).toMatch(/^https:\/\/github\.com\/cat-cave\/runtime-behavior-url-shortener-v32\/pull\/\d+$/u);
      expect(pr.mergeCommitSha).toMatch(/^sha-merged-/u);
      expect(pr.targetFileOnBase).toMatch(/^src\//u);
    }
    // The API merged BEFORE its dependents (dependency order honored).
    const order = proof.mergedPrs.map((p) => p.specId);
    expect(order.indexOf("spec_api")).toBeLessThan(order.indexOf("spec_web"));
    expect(order.indexOf("spec_api")).toBeLessThan(order.indexOf("spec_slack"));
  });

  it("STAGE 3 — cost rows carry the RIGHT cost_basis + billing_mode (subscription run)", () => {
    // One row per role per spec (3 specs × write/check/audit).
    expect(proof.costRows).toHaveLength(9);
    for (const row of proof.costRows) {
      // A Codex subscription credential → an HONESTLY-unpriced NULL real-spend row
      // (cost_basis='unknown', billing_mode='subscription'), NEVER a fake $0.
      expect(row.costBasis).toBe("unknown");
      expect(row.billingMode).toBe("subscription");
      expect(row.realSpendUsd).toBeNull();
    }
    expect(proof.costRows.map((r) => r.role)).toContain("write");
    expect(proof.costRows.map((r) => r.role)).toContain("check");
    expect(proof.costRows.map((r) => r.role)).toContain("audit");
  });

  it("STAGE 4 — severity gating works: a P2 ROUTES under velocity, BLOCKS under strict", () => {
    // The DORA knob: under velocity (blockReviewAt P1, route-to-dag) the P2 routes
    // to the DAG as a follow-up spec; under strict the SAME P2 blocks the merge.
    expect(proof.severityGate.velocityRoutedSpecIds.length).toBeGreaterThan(0);
    expect(proof.severityGate.strictBlocks).toBe(true);
  });

  it("STAGE 5 — a healthy run sits UNDER the ceiling (no pause)", () => {
    expect(proof.budget.paused).toBe(false);
    expect(proof.budget.spentUsd).toBeLessThan(proof.budget.ceilingUsd);
  });

  it("DEPLOY — targets the MERGED commit + the (faked) deploy URL returns 200", () => {
    // The final merge sha is the LAST derived spec's merge commit.
    const lastMerge = proof.mergedPrs.at(-1)?.mergeCommitSha;
    expect(proof.deploy.deployedRef).toBe(lastMerge);
    expect(proof.deploy.expectedMergeSha).toBe(lastMerge);
    expect(proof.deploy.probeStatus).toBe(200);
    expect(proof.deploy.probedUrl).toMatch(/^https:\/\//u);
  });

  it("STAGE 6 — an injected ISSUE → triage → fix → merge re-enters the merge machinery", () => {
    expect(proof.issueLoop.ingestedExternalId).toBe("gh-cat-cave/runtime-behavior-url-shortener-v32#7");
    expect(proof.issueLoop.routedSpecId).toBe("spec_issue_fix_7");
    expect(proof.issueLoop.mergedPrUrl).toMatch(/\/pull\/\d+$/u);
  });

  it("STAGE 7 — a FEATURE REQUEST becomes a derived spec in the DAG", () => {
    expect(proof.featureRequest.derivedSpecId).toMatch(/^spec_feature_/u);
  });

  it("STAGE 8 — a SCHEDULED AUDIT's residual finding RE-ENTERS the DAG as a spec", () => {
    expect(proof.scheduledAudit.reEnteredSpecId).toMatch(/^spec_audit_/u);
  });

  it("DORA — accumulates a deployment per merged run across the whole runtime behavior run", () => {
    // 3 derived merges + the issue-fix merge.
    expect(proof.doraDeploymentCount).toBe(4);
  });
});

describe("runtime behavior e2e driver — the budget CEILING pause (dag.budget.paused)", () => {
  it("PAUSES the run the instant real spend reaches the configured ceiling", async () => {
    const proof = await driveRuntimeBehavior({ budgetCeilingUsd: 50, overspend: true });
    // shouldPauseOnBudget / isBudgetExhausted (the REAL walker predicate) trip.
    expect(proof.budget.paused).toBe(true);
    expect(proof.budget.spentUsd).toBeGreaterThanOrEqual(proof.budget.ceilingUsd);
  });

  it("does NOT pause a run that stays under the ceiling (no false pause)", async () => {
    const proof = await driveRuntimeBehavior({ budgetCeilingUsd: 50, overspend: false });
    expect(proof.budget.paused).toBe(false);
  });
});

describe("runtime behavior e2e driver — the DORA audit-posture knob", () => {
  it("under STRICT posture a residual finding BLOCKS rather than routes", async () => {
    const proof = await driveRuntimeBehavior({ auditPosture: { blockReviewAt: "P3", p2p3Handling: "fix-if-idle" } });
    // Strict: the merge-gate P2 blocks rather than routes.
    expect(proof.severityGate.strictBlocks).toBe(true);
    // The audit-as-findings loop still routes its residual back into the DAG (the
    // re-entry is route-to-dag, independent of the merge-gate posture).
    expect(proof.scheduledAudit.reEnteredSpecId).toMatch(/^spec_audit_/u);
  });
});
