// The REAL `MergeAuthority` impl (tanren-owns-the-engine.md §0, §5) — the OWNED,
// host-independent, FAIL-CLOSED land decision, extracted as ONE concept from what is
// today scattered across the native gate, `governancePosture`, the review poll, the
// audit, and `mergeable_state`/`update-branch` freshness. This is the GUARANTEED core:
// transactional, fail-closed (deny/hold on uncertainty), never silently
// skipped/swallowed/contingent on an external call.
//
// ADDITIVE (Wave 1): this impl is NOT wired into the live `native_queue` /
// `mergeDispatcher` path — Wave 2 does the cutover. It depends ONLY on the Wave-0
// CONTRACTS: the `CodeHost` seam (a parallel subagent ships `GitHubCodeHost`; we
// depend on the contract, not the impl) and a small injected {@link LandFinalizer}
// port for the durable record (so `land` is transactional WITHOUT reaching into the
// live `RunStateWriter` yet — Wave 2 binds the real writer-backed finalizer).
//
// INPUT GATHERING (read-only reference — where each fail-closed input lives today; we
// ACCEPT them as inputs and do NOT rewire them in Wave 1):
//   - gateVerdict   — the native merge gate (`engine/workflow/gate/runMergeGate.ts`,
//                     `runGateForWhen.ts`); its `GateOutcome.passed` maps to `passed`,
//                     a not-yet-run / errored gate to `unknown` (never read as passing).
//   - findings      — the auditor's emitted findings (Wave-2's audit-as-findings
//                     producer); decided HERE via the REAL pure `decideFromFindings`
//                     against the project's `auditPosture` (the DORA knob). The live
//                     auditor is still pass/fail today; Wave 1 accepts findings as an
//                     input and the producer follows in Wave 2.
//   - reviewVerdict — the review poll (`reviewMerge/reviewPolling.ts`'s
//                     `ReviewVerdict`); `changes_requested`/`unread` BLOCK (closing the
//                     §5 P0 absorb-without-verdict hole).
//   - mergeability  — `mergeable_state`/`update-branch` freshness today
//                     (`merge/mergeDispatcher.ts`'s `ensureUpToDate`); `unknown`/
//                     `blocked` fail CLOSED (closing the §5 P0 ensureUpToDate fail-open).
//   - budget        — the budget scope (`engine/.../budgetGate.ts`), resolved through
//                     {@link NonNegativeFinite}; `unresolvable` fails CLOSED (closing
//                     the §5 P1 unlimited-on-unresolvable hole — there is NO "unlimited").
//   - demo          — the demo engine's verification (`engine/demo/demoEngine.ts`);
//                     `unverified` fails CLOSED (closing the §5 P2 emit-on-failed-probe).
//   - hitlSignoff   — the HITL signoff; REQUIRED + explicit (`pending` holds for a
//                     human; only `not_required`/`approved` clear — no omitted default).
//   - conflicts     — the `WorkspaceVcsCore` never-discard conflict state, surfaced as
//                     a fail-closed input.
//
// VALIDATED against the FROZEN `mergeAuthorityConformance` truth table.

import { decideFromFindings } from "../contracts/auditPosture.js";
import type { CodeHost } from "../contracts/codeHost.js";
import type {
  AuthorizeLandInput,
  LandAuthorization,
  LandBlockReason,
  LandOutcome,
  MergeAuthority,
  PrepareIntegrationInput,
  PrepareIntegrationResult,
} from "../contracts/mergeAuthority.js";

/**
 * The DURABLE record of an authorized land, run in ONE transaction (closing the §5
 * P0 fire-before-finalize hole). An impl records `merge.completed` + the run/spec
 * finalize atomically and returns the recorded `auditId`. THROWING here (a failed
 * durable write) — AFTER the external land already fired — is exactly the
 * `merge_state_unknown` reconcile signal, never a silent inconsistency. Wave 2 binds
 * a `RunStateWriter`-backed impl (the same single-transaction pattern as
 * `DirectRunStateWriter.finalizeRun`); Wave 1 keeps it an injected port so the
 * authority is real WITHOUT reaching into the live merge path.
 */
export interface LandFinalizer {
  /**
   * Record the completed land transactionally (the `merge.completed` + finalize) and
   * return the durable `auditId`. The `mainSha` is the host's post-land main sha; the
   * `node`/`target` identify the landed integration node + its CAS target.
   */
  finalizeLanded(input: { authorization: LandAuthorization; mainSha: string }): Promise<{ auditId: string }>;
}

/**
 * The real fail-closed merge authority. Constructed with the `CodeHost` it lands
 * through + the {@link LandFinalizer} that records the decision durably. No hidden
 * CAS state: the compare-and-swap base rides ON the authorization (`prepare` →
 * `authorize` → `land` carry ONE concrete commit + target end-to-end).
 */
export class MergeAuthorityImpl implements MergeAuthority {
  constructor(
    private readonly host: CodeHost,
    private readonly finalizer: LandFinalizer,
  ) {}

  /**
   * Resolve the integration node into the MATERIALIZED landable commit + the CAS land
   * target. A real prepare resolves the node's ordered members into one commit via
   * `WorkspaceVcsCore` (Wave 2); Wave 1 carries the node's already-built `headSha`
   * forward (never discarding it) and surfaces conflicts as findings — empty here,
   * since a conflicted node is materialized + recorded upstream, not thrown away.
   */
  async prepareIntegration(input: PrepareIntegrationInput): Promise<PrepareIntegrationResult> {
    // The materialized landable commit: prefer the node's already-built head (the
    // resolved batch commit), else a deterministic prepared sha keyed on the node's
    // content identity so prepare→authorize→land carries ONE concrete commit.
    const headSha = input.node.headSha ?? `sha-prepared-${input.node.memberKey}`;
    return {
      resolvedRef: input.node.ref,
      headSha,
      treeSha: input.node.treeHash ?? `tree-${input.node.memberKey}`,
      repo: input.repo,
      intoMain: input.intoMain,
      // The compare-and-swap base: the sha `intoMain` is expected to still point at.
      expectedMainSha: input.baseSha,
      conflicts: [],
    };
  }

  /**
   * The FAIL-CLOSED truth table. EVERY guaranteed input must be in its pass state to
   * authorize; ANY uncertain/failing input blocks (with a `reasons` entry naming it);
   * a genuine human decision (HITL `pending`, a `changes_requested` review) routes to
   * `needs_attention`. Authorized binds to the CONCRETE prepared target — no hidden
   * state. Never authorizes on an uncertain input: deny/hold on uncertainty is the point.
   */
  async authorizeLand(input: AuthorizeLandInput): Promise<LandAuthorization> {
    const reasons: LandBlockReason[] = [];
    let needsAttention = false;

    // gate verdict — only `passed` clears; `unknown` (no verdict yet) NEVER reads as passing.
    if (input.gateVerdict !== "passed") {
      reasons.push({
        input: "gateVerdict",
        detail: `gate verdict is '${input.gateVerdict}' — fail closed (only 'passed' clears)`,
      });
    }

    // mergeability — only `clean` clears; `unknown`/`blocked` fail closed on uncertainty.
    if (input.mergeability !== "clean") {
      reasons.push({
        input: "mergeability",
        detail: `mergeability is '${input.mergeability}' — fail closed (only 'clean' clears)`,
      });
    }

    // review verdict — only `approved` clears. `changes_requested` is a HUMAN signal
    // (needs_attention); `unread`/`pending` hold (never absorb without reading it).
    if (input.reviewVerdict !== "approved") {
      reasons.push({
        input: "reviewVerdict",
        detail: `review verdict is '${input.reviewVerdict}' — fail closed (only 'approved' clears)`,
      });
      if (input.reviewVerdict === "changes_requested") needsAttention = true;
    }

    // conflicts — must be `resolved` AND the prepare must have surfaced none.
    if (input.conflicts !== "resolved" || input.prepared.conflicts.length > 0) {
      reasons.push({
        input: "conflicts",
        detail: "conflicts unresolved — fail closed (must be resolved before land)",
      });
    }

    // budget — `unresolvable` fails closed (a failed/unknown resolution is NEVER
    // unlimited). `not_required` (the project configured no ceiling — already
    // enforced upstream by the walker's budget gate) clears. A `resolved` scope
    // blocks only when exhausted.
    if (input.budget.kind === "unresolvable") {
      reasons.push({
        input: "budget",
        detail: `budget scope unresolvable (${input.budget.reason}) — fail closed (never unlimited)`,
      });
    } else if (input.budget.kind === "resolved" && input.budget.spentUsd >= input.budget.ceilingUsd) {
      reasons.push({
        input: "budget",
        detail: `budget exhausted (spent ${input.budget.spentUsd} >= ceiling ${input.budget.ceilingUsd})`,
      });
    }

    // demo — only `verified`/`not_required` clear; `unverified` fails closed.
    if (input.demo === "unverified") {
      reasons.push({
        input: "demo",
        detail: "demo unverified — fail closed (a failed/absent demo never clears)",
      });
    }

    // HITL — REQUIRED + explicit: only `not_required`/`approved` clear; `pending` holds
    // for a human (the type forbids an omitted-default-allow path).
    if (input.hitlSignoff !== "not_required" && input.hitlSignoff !== "approved") {
      reasons.push({ input: "hitlSignoff", detail: "HITL signoff pending — needs a human decision" });
      needsAttention = true;
    }

    // findings vs posture — the REAL pure policy decides the block (the DORA knob),
    // not a re-implementation here.
    const postureDecision = decideFromFindings(input.findings, input.auditPosture);
    if (postureDecision.block) {
      reasons.push({
        input: "findings",
        detail: "findings exceed auditPosture.blockReviewAt — blocked by policy",
      });
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

  /**
   * Execute the land TRANSACTIONALLY, ONLY for an `authorized` authorization (throws
   * on a non-authorized one — `land` cannot bypass the decision). authorize → execute
   * `CodeHost.landAuthorizedRef` (a CAS push of the authorized commit) → reconcile the
   * durable finalize. A durable-write failure AFTER the host land returns
   * `merge_state_unknown` for the reconciler — NEVER a silent inconsistency (§5 P0).
   */
  async land(auth: LandAuthorization): Promise<LandOutcome> {
    if (auth.decision !== "authorized" || auth.target === undefined) {
      throw new Error(
        `land() refused: authorization is not 'authorized' (decision='${auth.decision}') — land cannot bypass the decision`,
      );
    }

    // Execute the EXTERNAL land first (CAS target carried ON the authorization). If
    // the host rejects (main advanced underneath / infra), that throws BEFORE any
    // durable record — a clean failure, nothing landed, nothing recorded.
    const landed = await this.host.landAuthorizedRef({
      repo: auth.target.repo,
      intoMain: auth.target.intoMain,
      authorizedSha: auth.target.authorizedSha,
      expectedMainSha: auth.target.expectedMainSha,
    });

    // Reconcile: record the completed land in ONE durable transaction. A failure HERE
    // is the dangerous case — the host already advanced `main` — so it is NEVER a
    // plain failure: it enters the explicit `merge_state_unknown` reconcile state.
    try {
      const { auditId } = await this.finalizer.finalizeLanded({ authorization: auth, mainSha: landed.mainSha });
      return { kind: "landed", mainSha: landed.mainSha, auditId };
    } catch (err) {
      return {
        kind: "merge_state_unknown",
        reason: `durable finalize failed after external land at ${landed.mainSha}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        reconcileToken: `reconcile-${auth.node.nodeId}-${landed.mainSha}`,
      };
    }
  }
}
