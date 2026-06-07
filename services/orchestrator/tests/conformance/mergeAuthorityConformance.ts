// Seam conformance suite for the `MergeAuthority` contract
// (`engine/contracts/mergeAuthority.ts`, tanren-owns-the-engine.md §0, §5). This is
// the FAIL-CLOSED TRUTH TABLE — the guaranteed core's acceptance criteria. The
// reusable behavior spec EVERY impl must satisfy:
//   - the prepare→authorize→land flow carries ONE concrete commit: prepareIntegration
//     materializes the landable headSha + CAS target, authorizeLand binds to it, land
//     pushes it (no hidden host/CAS state);
//   - authorizeLand returns blocked/needs_attention for EACH uncertainty:
//       · unknown/blocked mergeability       (closes §5 P0 ensureUpToDate fail-open)
//       · unresolvable budget scope          (closes §5 P1 unlimited-on-unresolvable)
//       · unread / changes_requested review  (closes §5 P0 absorb-without-verdict)
//       · unresolved conflict
//       · findings exceeding the posture
//       · gate verdict not 'passed' (incl. unknown — never read no-verdict as passing)
//       · HITL `pending` (and `not_required`/`approved` are the ONLY clears — there
//         is no omitted-default-allow, the type forbids it);
//   - authorized ONLY on the explicit all-clear (every input in its pass state);
//   - land() refuses a non-authorized authorization (cannot bypass the decision);
//   - land RECONCILES (merge_state_unknown, never a silent inconsistency) when the
//     durable write fails AFTER the external land fired (closes §5 P0).
//
// Parameterized by an impl factory: the factory is handed a fully-clear input + a
// "fail the durable finalize" toggle, so a Wave-1 impl drives the SAME table.

import { describe, expect, it } from "vitest";
import type { AuditPosture } from "../../src/engine/contracts/auditPosture.js";
import type { Finding } from "../../src/engine/contracts/findings.js";
import type { IntegrationNode } from "../../src/engine/contracts/integrationNodes.js";
import { nonNegativeFinite } from "../../src/engine/contracts/money.js";
import type {
  AuthorizeLandInput,
  HitlSignoff,
  MergeAuthority,
  PrepareIntegrationResult,
} from "../../src/engine/contracts/mergeAuthority.js";

const CONF_REPO = { owner: "owner", name: "repo" };

/** The node every case authorizes against (a single-member merge_batch). */
export const CONF_NODE: IntegrationNode = {
  nodeId: "node_conf",
  baseBranch: "main",
  baseSha: "sha-main-0",
  ref: "tanren/integ/conf",
  purpose: "merge_batch",
  members: [{ specId: "spec_a", runId: "run_a", branch: "feat-a", headSha: "sha-feat-a" }],
  memberKey: "mk-conf",
  gateConfigHash: "gc",
  policyVersion: "pv",
  affectedFingerprint: "af",
  headSha: "sha-node-built",
  treeHash: "tree-conf",
  status: "ready",
};

const VELOCITY_POSTURE: AuditPosture = { blockReviewAt: "P1", p2p3Handling: "route-to-dag" };

/** The fully-clear input around a given prepared result (EVERY input in its pass state). */
export function confAllClearInput(prepared: PrepareIntegrationResult): AuthorizeLandInput {
  return {
    node: CONF_NODE,
    prepared,
    gateVerdict: "passed",
    findings: [],
    auditPosture: VELOCITY_POSTURE,
    reviewVerdict: "approved",
    mergeability: "clean",
    budget: { kind: "resolved", ceilingUsd: nonNegativeFinite(50), spentUsd: nonNegativeFinite(10) },
    demo: "verified",
    hitlSignoff: "not_required",
    conflicts: "resolved",
  };
}

const BLOCKING_FINDING: Finding = { id: "f1", severity: "P0", title: "blocker", body: "must fix" };

export interface MergeAuthorityConformanceHarness {
  /** A fresh impl per call. The same impl drives both authorize + land cases. */
  make(): MergeAuthority;
  /**
   * A fresh impl whose durable finalize FAILS after the external land — to exercise
   * the merge_state_unknown reconcile path. The impl must still execute the external
   * land first (authorize → execute → reconcile).
   */
  makeWithFailingFinalize(): MergeAuthority;
}

/** Run the real prepare→build-input flow against an impl (materializes the commit). */
async function prepareClear(
  ma: MergeAuthority,
): Promise<{ input: AuthorizeLandInput; prepared: PrepareIntegrationResult }> {
  const prepared = await ma.prepareIntegration({
    node: CONF_NODE,
    repo: CONF_REPO,
    intoMain: CONF_NODE.baseBranch,
    baseSha: CONF_NODE.baseSha,
  });
  return { input: confAllClearInput(prepared), prepared };
}

export function describeMergeAuthorityConformance(label: string, harness: MergeAuthorityConformanceHarness): void {
  describe(`MergeAuthority conformance (fail-closed truth table): ${label}`, () => {
    it("prepare→authorize binds the authorization to the MATERIALIZED commit + CAS target", async () => {
      const ma = harness.make();
      const { input, prepared } = await prepareClear(ma);
      const auth = await ma.authorizeLand(input);
      expect(auth.decision).toBe("authorized");
      // The authorized target carries the concrete prepared commit + CAS base — no hidden state.
      expect(auth.target?.authorizedSha).toBe(prepared.headSha);
      expect(auth.target?.expectedMainSha).toBe(CONF_NODE.baseSha);
      expect(auth.target?.intoMain).toBe(CONF_NODE.baseBranch);
      expect(auth.reasons).toEqual([]);
    });

    // ---- Each uncertainty fails CLOSED -----------------------------------
    const uncertainties: Array<{
      name: string;
      mutate: (i: AuthorizeLandInput) => void;
      decision: "blocked" | "needs_attention";
    }> = [
      { name: "unknown mergeability", mutate: (i) => (i.mergeability = "unknown"), decision: "blocked" },
      { name: "blocked mergeability", mutate: (i) => (i.mergeability = "blocked"), decision: "blocked" },
      {
        name: "unresolvable budget scope",
        mutate: (i) => (i.budget = { kind: "unresolvable", reason: "no org scope" }),
        decision: "blocked",
      },
      { name: "unread review verdict", mutate: (i) => (i.reviewVerdict = "unread"), decision: "blocked" },
      {
        name: "changes_requested review verdict",
        mutate: (i) => (i.reviewVerdict = "changes_requested"),
        decision: "needs_attention",
      },
      { name: "unresolved conflict", mutate: (i) => (i.conflicts = "unresolved"), decision: "blocked" },
      {
        name: "gate verdict unknown (never read no-verdict as passing)",
        mutate: (i) => (i.gateVerdict = "unknown"),
        decision: "blocked",
      },
      { name: "gate verdict failed", mutate: (i) => (i.gateVerdict = "failed"), decision: "blocked" },
      { name: "findings exceeding posture", mutate: (i) => (i.findings = [BLOCKING_FINDING]), decision: "blocked" },
      { name: "demo unverified", mutate: (i) => (i.demo = "unverified"), decision: "blocked" },
      { name: "HITL signoff pending", mutate: (i) => (i.hitlSignoff = "pending"), decision: "needs_attention" },
    ];

    for (const u of uncertainties) {
      it(`does NOT authorize on: ${u.name} (→ ${u.decision})`, async () => {
        const ma = harness.make();
        const { input } = await prepareClear(ma);
        u.mutate(input);
        const auth = await ma.authorizeLand(input);
        expect(auth.decision).toBe(u.decision);
        expect(auth.decision).not.toBe("authorized");
        expect(auth.target).toBeUndefined();
        expect(auth.reasons.length).toBeGreaterThan(0);
      });
    }

    // ---- HITL: ONLY not_required / approved clear; nothing defaults to allow ----
    const hitlClears: HitlSignoff[] = ["not_required", "approved"];
    for (const signoff of hitlClears) {
      it(`HITL '${signoff}' PROCEEDS (an explicit clear, never an omitted default)`, async () => {
        const ma = harness.make();
        const { input } = await prepareClear(ma);
        input.hitlSignoff = signoff;
        const auth = await ma.authorizeLand(input);
        expect(auth.decision).toBe("authorized");
      });
    }

    it("land() REFUSES a non-authorized authorization (cannot bypass the decision)", async () => {
      const ma = harness.make();
      const { input } = await prepareClear(ma);
      const blocked = await ma.authorizeLand({ ...input, gateVerdict: "failed" });
      await expect(ma.land(blocked)).rejects.toThrow(/not 'authorized'|refused|authorization/iu);
    });

    it("land SUCCEEDS transactionally on an authorized authorization", async () => {
      const ma = harness.make();
      const { input, prepared } = await prepareClear(ma);
      const auth = await ma.authorizeLand(input);
      const outcome = await ma.land(auth);
      // A landed outcome lands the MATERIALIZED commit + carries the recorded audit id.
      const landed = outcome.kind === "landed" ? outcome : undefined;
      expect(landed?.mainSha).toBe(prepared.headSha);
      expect(landed?.auditId).not.toBe("");
    });

    it("land RECONCILES (merge_state_unknown) when the durable write fails AFTER the external land", async () => {
      const ma = harness.makeWithFailingFinalize();
      const { input } = await prepareClear(ma);
      const auth = await ma.authorizeLand(input);
      const outcome = await ma.land(auth);
      // NEVER a plain failure / silent inconsistency — an explicit reconcile state.
      const unknown = outcome.kind === "merge_state_unknown" ? outcome : undefined;
      expect(outcome.kind).toBe("merge_state_unknown");
      expect(unknown?.reconcileToken).not.toBe("");
    });
  });
}
