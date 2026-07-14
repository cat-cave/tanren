// Seam conformance suite for the `MergeAuthorityV2` contract
// (`engine/contracts/mergeAuthority.ts`, SP-4). This is the FAIL-CLOSED TRUTH TABLE —
// the guaranteed core's acceptance criteria. The reusable behavior spec EVERY impl must
// satisfy:
//   - authorizeLand takes the frozen input + the binding envelope SEPARATELY and
//     re-validates the binding (subject deep-equal) before authorizing; the authorized
//     envelope is carried onto the authorization (no hidden host/CAS state);
//   - authorizeLand returns blocked/needs_attention for EACH uncertainty:
//       · unknown/blocked mergeability       (closes §5 P0 ensureUpToDate fail-open)
//       · unresolvable budget scope          (closes §5 P1 unlimited-on-unresolvable)
//       · unread / changes_requested review  (closes §5 P0 absorb-without-verdict)
//       · unresolved conflict
//       · findings exceeding the posture
//       · gate verdict not 'passed' (incl. unknown — never read no-verdict as passing)
//       · HITL `pending` (and `not_required`/`approved` are the ONLY clears)
//       · a raced binding (envelope.subject != input.subject) — fail closed;
//   - authorized ONLY on the explicit all-clear (every input in its pass state);
//   - land() refuses a non-authorized authorization (cannot bypass the decision);
//   - land RECONCILES (merge_state_unknown, never a silent inconsistency) when the
//     durable receipt fails AFTER the external land fired (closes §5 P0).
//
// Parameterized by an impl factory: the factory is handed a fully-clear input + a
// "fail the durable receipt" toggle, so a Wave-1 impl drives the SAME table.

import { describe, expect, it } from "vitest";
import type { AuditPosture } from "../../src/engine/contracts/auditPosture.js";
import type { Finding } from "../../src/engine/contracts/findings.js";
import { nonNegativeFinite } from "../../src/engine/contracts/money.js";
import { parseDigest } from "../../src/engine/contracts/cas.js";
import type {
  AuthorizeLandInput,
  HitlSignoff,
  LandBindingEnvelope,
  LandSubject,
  MergeAuthorityV2,
} from "../../src/engine/contracts/mergeAuthority.js";

const CONF_REPO = { owner: "owner", name: "repo" };

/** The subject every case authorizes against (a single resolved integration node). */
export const CONF_SUBJECT: LandSubject = { kind: "integration_node", id: "node_conf" };

const CONF_ARTIFACT = parseDigest(`sha256:${"a".repeat(64)}`);
const CONF_PROOF_ROOT = parseDigest(`sha256:${"b".repeat(64)}`);

/** The binding envelope every case authorizes against (single-member, admit). */
export const CONF_ENVELOPE: LandBindingEnvelope = {
  subject: CONF_SUBJECT,
  members: [{ specId: "spec_a", runId: "run_a", branch: "feat-a", headSha: "sha-node-built", disposition: "admit" }],
  headSha: "sha-node-built",
  expectedMainSha: "sha-main-0",
  artifactDigest: CONF_ARTIFACT,
  proofRoot: CONF_PROOF_ROOT,
  memberSetHash: "mk-conf",
  policyVersion: "pv",
  target: { repo: CONF_REPO, intoMain: "main" },
};

const VELOCITY_POSTURE: AuditPosture = { blockReviewAt: "P1", p2p3Handling: "route-to-dag" };

/** The fully-clear frozen input (EVERY input in its pass state). */
export function confAllClearInput(): AuthorizeLandInput {
  return {
    subject: CONF_SUBJECT,
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
  make(): MergeAuthorityV2;
  /**
   * A fresh impl whose durable receipt FAILS after the external land — to exercise the
   * merge_state_unknown reconcile path. The impl must still execute the external land
   * first (persist decision → execute land → record receipt).
   */
  makeWithFailingFinalize(): MergeAuthorityV2;
}

export function describeMergeAuthorityConformance(label: string, harness: MergeAuthorityConformanceHarness): void {
  describe(`MergeAuthorityV2 conformance (fail-closed truth table): ${label}`, () => {
    it("authorizeLand binds the authorization to the envelope's commit + CAS target", async () => {
      const ma = harness.make();
      const auth = await ma.authorizeLand(confAllClearInput(), CONF_ENVELOPE);
      expect(auth.decision).toBe("authorized");
      // The authorized envelope carries the concrete commit + CAS base — no hidden state.
      expect(auth.envelope.headSha).toBe(CONF_ENVELOPE.headSha);
      expect(auth.envelope.expectedMainSha).toBe(CONF_ENVELOPE.expectedMainSha);
      expect(auth.envelope.target.intoMain).toBe("main");
      expect(auth.reasons).toEqual([]);
    });

    it("does NOT authorize a raced binding (envelope.subject != input.subject)", async () => {
      const ma = harness.make();
      const raced: LandBindingEnvelope = { ...CONF_ENVELOPE, subject: { kind: "integration_node", id: "other" } };
      const auth = await ma.authorizeLand(confAllClearInput(), raced);
      expect(auth.decision).toBe("blocked");
      expect(auth.reasons.some((r) => r.input === "binding")).toBe(true);
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
        const input = confAllClearInput();
        u.mutate(input);
        const auth = await ma.authorizeLand(input, CONF_ENVELOPE);
        expect(auth.decision).toBe(u.decision);
        expect(auth.decision).not.toBe("authorized");
        expect(auth.reasons.length).toBeGreaterThan(0);
      });
    }

    // ---- HITL: ONLY not_required / approved clear; nothing defaults to allow ----
    const hitlClears: HitlSignoff[] = ["not_required", "approved"];
    for (const signoff of hitlClears) {
      it(`HITL '${signoff}' PROCEEDS (an explicit clear, never an omitted default)`, async () => {
        const ma = harness.make();
        const input = confAllClearInput();
        input.hitlSignoff = signoff;
        const auth = await ma.authorizeLand(input, CONF_ENVELOPE);
        expect(auth.decision).toBe("authorized");
      });
    }

    it("land() REFUSES a non-authorized authorization (cannot bypass the decision)", async () => {
      const ma = harness.make();
      const blocked = await ma.authorizeLand({ ...confAllClearInput(), gateVerdict: "failed" }, CONF_ENVELOPE);
      await expect(ma.land(blocked)).rejects.toThrow(/not 'authorized'|refused|authorization/iu);
    });

    it("land SUCCEEDS transactionally on an authorized authorization", async () => {
      const ma = harness.make();
      const auth = await ma.authorizeLand(confAllClearInput(), CONF_ENVELOPE);
      const outcome = await ma.land(auth);
      // A landed outcome lands the envelope's commit + carries the recorded audit id.
      const landed = outcome.kind === "landed" ? outcome : undefined;
      expect(landed?.mainSha).toBe(CONF_ENVELOPE.headSha);
      expect(landed?.auditId).not.toBe("");
    });

    it("land RECONCILES (merge_state_unknown) when the durable receipt fails AFTER the external land", async () => {
      const ma = harness.makeWithFailingFinalize();
      const auth = await ma.authorizeLand(confAllClearInput(), CONF_ENVELOPE);
      const outcome = await ma.land(auth);
      // NEVER a plain failure / silent inconsistency — an explicit reconcile state.
      const unknown = outcome.kind === "merge_state_unknown" ? outcome : undefined;
      expect(outcome.kind).toBe("merge_state_unknown");
      expect(unknown?.reconcileToken).not.toBe("");
    });
  });
}
