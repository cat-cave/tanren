// A TRIVIAL in-memory reference fake of `MergeAuthority`
// (`engine/contracts/mergeAuthority.ts`) — ONLY to make the
// `mergeAuthorityConformance` suite self-runnable in Wave 0 AND to encode the
// CANONICAL fail-closed truth table so the contract's intent is executable. The
// Wave-1 impl (extracted from the scattered gate/governance/review/mergeability)
// drives the SAME suite. Fixtures live HERE, never src/.
//
// This fake composes the REAL pure policy (`decideFromFindings`) for the
// findings-vs-posture input, so the audit gate is the production policy, not a
// re-implementation. `prepareIntegration` MATERIALIZES the concrete landable commit
// + carries the CAS target forward; `authorizeLand` binds the authorization to that
// concrete target (NO hidden constructor state); `land` reads the target off the
// authorization and reconciles via the supplied CodeHost + a durable-finalize hook
// the test can fail (to exercise merge_state_unknown).

import { decideFromFindings } from "../../../src/engine/contracts/auditPosture.js";
import type { CodeHost } from "../../../src/engine/contracts/codeHost.js";
import type {
  AuthorizeLandInput,
  LandAuthorization,
  LandBlockReason,
  LandOutcome,
  MergeAuthority,
  PrepareIntegrationInput,
  PrepareIntegrationResult,
} from "../../../src/engine/contracts/mergeAuthority.js";

/** A durable-finalize hook the test controls (to exercise the reconcile path). */
export interface DurableFinalize {
  finalize(input: { mainSha: string }): Promise<{ auditId: string }>;
}

export class InMemoryMergeAuthority implements MergeAuthority {
  constructor(
    private readonly host: CodeHost,
    private readonly finalize: DurableFinalize,
  ) {}

  async prepareIntegration(input: PrepareIntegrationInput): Promise<PrepareIntegrationResult> {
    // Materialize a NEW landable commit for the batch (a real prepare resolves the
    // members into one commit); carry the CAS target forward into the result.
    return {
      resolvedRef: input.node.ref,
      headSha: `sha-prepared-${input.node.memberKey}`,
      treeSha: input.node.treeHash ?? `tree-${input.node.memberKey}`,
      repo: input.repo,
      intoMain: input.intoMain,
      expectedMainSha: input.baseSha,
      conflicts: [],
    };
  }

  async authorizeLand(input: AuthorizeLandInput): Promise<LandAuthorization> {
    const reasons: LandBlockReason[] = [];
    let needsAttention = false;

    // ---- Fail-closed truth table (deny/hold on uncertainty) ----------------
    if (input.gateVerdict !== "passed") {
      reasons.push({
        input: "gateVerdict",
        detail: `gate verdict is ${input.gateVerdict} — fail closed (only 'passed' clears)`,
      });
    }
    if (input.mergeability !== "clean") {
      reasons.push({
        input: "mergeability",
        detail: `mergeability is ${input.mergeability} — fail closed (only 'clean' clears)`,
      });
    }
    if (input.reviewVerdict !== "approved") {
      // unread / changes_requested / pending all hold; changes_requested is a human signal.
      reasons.push({
        input: "reviewVerdict",
        detail: `review verdict is ${input.reviewVerdict} — fail closed (only 'approved' clears)`,
      });
      if (input.reviewVerdict === "changes_requested") needsAttention = true;
    }
    if (input.conflicts !== "resolved" || input.prepared.conflicts.length > 0) {
      reasons.push({ input: "conflicts", detail: "conflicts unresolved — fail closed (must be resolved before land)" });
    }
    if (input.budget.kind === "unresolvable") {
      reasons.push({
        input: "budget",
        detail: `budget scope unresolvable (${input.budget.reason}) — fail closed (NEVER unlimited)`,
      });
    } else if (input.budget.spentUsd >= input.budget.ceilingUsd) {
      reasons.push({
        input: "budget",
        detail: `budget exhausted (spent ${input.budget.spentUsd} >= ceiling ${input.budget.ceilingUsd})`,
      });
    }
    if (input.demo === "unverified") {
      reasons.push({ input: "demo", detail: "demo unverified — fail closed (a failed/absent demo never clears)" });
    }
    // HITL is REQUIRED + explicit: only `not_required` or `approved` clear; `pending`
    // holds for a human (there is no "omitted → allow" path — the type forbids it).
    if (input.hitlSignoff !== "not_required" && input.hitlSignoff !== "approved") {
      reasons.push({ input: "hitlSignoff", detail: "HITL signoff pending — needs a human decision" });
      needsAttention = true;
    }

    // Findings vs posture: the REAL pure policy decides the block.
    const postureDecision = decideFromFindings(input.findings, input.auditPosture);
    if (postureDecision.block) {
      reasons.push({ input: "findings", detail: "findings exceed auditPosture.blockReviewAt — blocked by policy" });
    }

    if (reasons.length === 0) {
      // The explicit all-clear: bind the authorization to the CONCRETE prepared target.
      return {
        decision: "authorized",
        node: input.node,
        target: {
          repo: input.prepared.repo,
          intoMain: input.prepared.intoMain,
          authorizedSha: input.prepared.headSha,
          expectedMainSha: input.prepared.expectedMainSha,
        },
        reasons: [],
      };
    }
    return { decision: needsAttention ? "needs_attention" : "blocked", node: input.node, reasons };
  }

  async land(auth: LandAuthorization): Promise<LandOutcome> {
    if (auth.decision !== "authorized" || auth.target === undefined) {
      throw new Error("land() refused: authorization is not 'authorized' (land cannot bypass the decision)");
    }
    // authorize → execute the EXTERNAL land (CAS target carried ON the authorization,
    // not hidden in a constructor) → reconcile the durable finalize.
    const landed = await this.host.landAuthorizedRef({
      repo: auth.target.repo,
      intoMain: auth.target.intoMain,
      authorizedSha: auth.target.authorizedSha,
      expectedMainSha: auth.target.expectedMainSha,
    });
    try {
      const { auditId } = await this.finalize.finalize({ mainSha: landed.mainSha });
      return { kind: "landed", mainSha: landed.mainSha, auditId };
    } catch (err) {
      // The external land FIRED but the durable write failed: NEVER a silent
      // inconsistency — enter the reconcile state.
      return {
        kind: "merge_state_unknown",
        reason: err instanceof Error ? err.message : String(err),
        reconcileToken: `reconcile-${landed.mainSha}`,
      };
    }
  }
}
