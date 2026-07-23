// rebase the existing run/branch in place, re-gate, then preserve exact typed recovery.
// Conflicts remain recorded in jj; infra and unprovable recovery fail closed.

import type { PercolationDecision, SpeculativeDependent } from "../contracts/changePercolation.js";
import type {
  ConflictRecoveryDisposition,
  DurableConflictRecoverySettlement,
} from "../contracts/conflictResolution.js";
import type { AncestorStack } from "./ancestorStack.js";
import type { IntegrationNode } from "../contracts/integrationNodes.js";
import type { RebaseResult, WorkspaceVcsCore } from "../contracts/workspaceVcsCore.js";
import type { PercolationReexecutor } from "./percolationOperation.js";
import {
  BaseShiftHeldError,
  type BaseShiftEventEmitter,
  type BaseShiftGateReworkRouter,
  type BaseShiftNodeReader,
  type BaseShiftPersistence,
  type RebaseDecision,
  type ReGateResult,
  type ReGateVerdict,
} from "./baseShiftPorts.js";
import { createLogger } from "../observability/logger.js";
import { rebaseDecisionFromRecovery, settleBaseShiftRecovery } from "./baseShiftRecovery.js";
import { emitBaseShiftRebase } from "./baseShiftEmit.js";
import { reGateOrHold } from "./baseShiftRegate.js";

const log = createLogger("base-shift");

// Re-export ports from baseShiftPorts so existing import sites stay stable.
export {
  BaseShiftHeldError,
  type BaseShiftEventEmitter,
  type BaseShiftGateReworkRouter,
  type BaseShiftNodeReader,
  type BaseShiftPersistence,
  type RebaseDecision,
  type ReGateResult,
  type ReGateVerdict,
};

/** Opens the dependent's runner-local jj workspace and resolves its new base. */
export interface BaseShiftWorkspaceOpener {
  open(input: {
    projectId: string;
    dependent: SpeculativeDependent;
    /** True when EVERY ancestor merged (the rebase is onto plain `default_branch`). */
    nonSpeculative: boolean;
    /**
     * §2.2: the RE-RESOLVED ordered ancestor stack (merged ancestors dropped; the rest at their
     * new heads). A non-empty stack ⇒ the live opener ASSEMBLES it LOCALLY (`main + ordered
     * ancestors`) and the coordinator `rebaseOnto`s onto the assembled head — NO synthesized host
     * ref. Empty (a non-speculative shift) ⇒ a plain `default_branch` clone (a REAL ref).
     */
    ancestorStack?: AncestorStack;
  }): Promise<{ workspaceId: string; path: string; branch: string; newBaseSha: string }>;
}

/**
 * Re-gates the rebased branch — the dependent's OWN deterministic gate over the rebased tree.
 * `passed` ⇒ the work FITS the shifted base (no re-plan). `failed` ⇒ a GATE TIER failed (the
 * rebase was CLEAN — the code just fails lint/test/build on the new base) ⇒ route to WRITER
 * REWORK (not replan/escalate). `pending` ⇒ inconclusive ⇒ HOLD (fail-closed). The verdict may
 * be a bare string (conformance) or a `ReGateResult` carrying the gate error.
 */
export interface BaseShiftReGate {
  reGate(input: {
    projectId: string;
    dependent: SpeculativeDependent;
    rebasedHeadSha: string;
  }): Promise<ReGateVerdict | ReGateResult>;
}

/**
 * The intent-preserving resolution of a recorded rebase conflict, or `irreconcilable`.
 * An unresolved result may carry the resolver's exact typed recovery disposition;
 * the coordinator consumes it without double-routing or losing parking state.
 */
export type ConflictResolution =
  | { resolved: true; headSha: string }
  | { resolved: false; reason: string; recovery?: ConflictRecoveryDisposition };

export interface BaseShiftRebaseOutcome {
  decision: RebaseDecision;
  headSha: string;
  /** Present whenever routing, parking, or a concurrent terminal settled the shift. */
  recovery?: DurableConflictRecoverySettlement;
}

/**
 * Resolves a recorded rebase conflict (intent + vision preserving), writing the resolution INTO
 * the conflicted branch commit via `WorkspaceVcsCore.resolveConflict` (the work is NEVER
 * recreated). `irreconcilable` means the shift genuinely broke the old work — the coordinator
 * then re-plans (kept alive), never discards.
 */
export interface BaseShiftConflictResolver {
  resolve(input: {
    projectId: string;
    dependent: SpeculativeDependent;
    workspace: { workspaceId: string; path: string };
    rebase: RebaseResult & { outcome: "conflicted" };
    /**
     * True when EVERY ancestor merged (the rebase + resolve is onto plain `default_branch`).
     * A still-speculative shift (false) gathers/re-gates the conflict against the LOCALLY
     * assembled stack head (the SAME base the initial `rebaseOnto` used) — never the project
     * default — else it would mark work `rebased_resolved` that was never proven against the
     * base it lands on (a fail-OPEN).
     */
    nonSpeculative: boolean;
    /**
     * §2.2: the RE-RESOLVED ordered ancestor stack (the SAME one the OPENER assembled). A
     * non-empty stack ⇒ the live resolver ASSEMBLES `main + ordered ancestors` LOCALLY and
     * gathers + re-gates the recorded conflict against the assembled head — NO synthesized
     * host integration ref. Empty/absent (a non-speculative shift) ⇒ a plain `default_branch`
     * single-ref clone (a REAL ref).
     */
    ancestorStack?: AncestorStack;
  }): Promise<ConflictResolution>;
}

export interface BaseShiftCoordinatorDeps {
  workspace: WorkspaceVcsCore;
  opener: BaseShiftWorkspaceOpener;
  reGate: BaseShiftReGate;
  resolver: BaseShiftConflictResolver;
  persistence: BaseShiftPersistence;
  nodes: BaseShiftNodeReader;
  events: BaseShiftEventEmitter;
  /**
   * Routes a CLEAN-rebase GATE-tier re-gate failure to writer rework (not replan/escalate) —
   * the doctrine (PR #682 / merge re-gate design): a byte-clean rebase whose fresh gate fails
   * is the WRITER's to fix, NEVER an irreconcilable-conflict replan. REQUIRED (no silent
   * degrade): every construction site MUST wire the router. A missing router used to fall
   * back to `recordReplan` — the regression this fix (Codex critic #15) eradicates.
   */
  gateRework: BaseShiftGateReworkRouter;
}

/**
 * The ONE base-shift handler. It implements `PercolationReexecutor` so the existing
 * `PercolatingKickOff` drives it UNCHANGED — but `reexecute` now REBASES IN PLACE
 * (never-discard) instead of supersede+regenerate, and returns the SAME run id as the
 * `reexecRunId` (the never-discard proof the settle reads). The merge-path `behind`
 * handler calls the SAME `rebaseOnto` (the two divergent handlers collapse to one).
 */
export class BaseShiftCoordinator implements PercolationReexecutor {
  constructor(private readonly deps: BaseShiftCoordinatorDeps) {}

  /**
   * The `PercolationReexecutor` entry point the kick-off drives. NEVER-DISCARD: keep the
   * dependent's run/branch row, rebase it onto the shifted base, re-gate, and re-plan
   * ONLY when the resolver + re-gate say the old work no longer fits. The returned
   * `reexecRunId` is the dependent's OWN run id — the SAME row — so the existing settle
   * pass advances the termination key against it (no new `createQueuedRunFromSpec`).
   */
  async reexecute(input: {
    projectId: string;
    dependent: SpeculativeDependent;
    decision: PercolationDecision;
    ancestorStack: AncestorStack;
    nonSpeculative: boolean;
  }): Promise<{
    reexecRunId: string;
    decision: RebaseDecision;
    recovery?: DurableConflictRecoverySettlement;
  }> {
    // §2.2: the RE-RESOLVED ordered ancestor stack the kick-off resolved (the still-unmerged
    // ancestors at their new heads, with their real PR-head branches). The live opener
    // assembles `main + ordered ancestors` LOCALLY from it — NO synthesized integration ref.
    // Empty when non-speculative (every ancestor merged ⇒ a real run against `default_branch`).
    const result = await this.rebaseOnto({
      projectId: input.projectId,
      dependent: input.dependent,
      nonSpeculative: input.nonSpeculative,
      ancestorStack: input.ancestorStack,
      ancestorSpecId: input.decision.ancestorSpecId,
      toSha: input.decision.toSha,
      ...(input.decision.immediateSeverity === "changes_requested" && {
        reviewVerdict: "changes_requested" as const,
      }),
    });
    // NEVER-DISCARD: the re-exec run id IS the dependent's existing run id. The branch
    // was rebased in place; the run row was KEPT. The settle pass resolves THIS run.
    return { reexecRunId: input.dependent.runId, ...result };
  }

  /**
   * The unified base-shift rebase (the SINGLE point both the percolation kick-off AND the
   * merge-path `behind` handler flow through). Loads the node, rebases the dependent's existing
   * branch onto the shifted base via the jj core, emits `integration.rebase`, and:
   *   - clean rebase + passing re-gate ⇒ KEEP the run. `rebased_clean`.
   *   - conflicted, resolver fits + re-gate passes ⇒ KEEP the run. `rebased_resolved`.
   *   - clean/resolved tree + a GATE-tier re-gate FAILURE ⇒ WRITER REWORK (NOT replan). `replanned`.
   *   - genuinely irreconcilable resolver (or checker/auditor re-gate rejection) ⇒ re-plan (kept ALIVE).
   *   - any rebase/gate/resolver INFRA failure ⇒ HOLD (fail-closed; the work survives).
   * Returns the `rebase_vs_rebuild` decision for the caller.
   */
  async rebaseOnto(input: {
    projectId: string;
    dependent: SpeculativeDependent;
    nonSpeculative: boolean;
    /**
     * §2.2: the re-resolved ancestor stack the live-jj-local opener assembles + the keep-run
     * persists. Absent on the merge-`behind` path (a non-speculative base-branch advance —
     * empty stack); the kick-off path passes the unmerged set.
     */
    ancestorStack?: AncestorStack;
    ancestorSpecId: string;
    toSha: string;
    reviewVerdict?: "changes_requested";
  }): Promise<BaseShiftRebaseOutcome> {
    const { projectId, dependent } = input;
    // (a) Load the affected integration_nodes BEFORE the restack — the before-vector for
    //     gv-17 base_shift_operations history. A read failure is non-fatal (logged) and
    //     yields an empty before-vector rather than dropping the shift.
    const priorNodes = await this.deps.nodes.nodesForDependent({ projectId, dependent }).catch((error: unknown) => {
      log.warn("integration-node read failed (non-fatal)", { specId: dependent.specId }, error);
      return [] as IntegrationNode[];
    });

    // (b) Rebase the dependent's EXISTING branch onto the shifted base — the run/branch
    //     row is KEPT. jj's rebaseOnto NEVER throws on a conflict (it records it IN the
    //     commit), so the work survives even an irreconcilable shift.
    const opened = await this.openOrHold(input);
    const ws = { workspaceId: opened.workspaceId, path: opened.path };
    let rebase: RebaseResult;
    try {
      rebase = await this.deps.workspace.rebaseOnto(ws, opened.branch, opened.newBaseSha);
    } catch (error) {
      // A rebase INFRA failure (not a conflict — jj records those) is fail-closed HOLD.
      throw new BaseShiftHeldError("rebase", error instanceof Error ? error.message : String(error));
    }

    if (rebase.outcome === "clean") {
      return this.settleClean({
        ...input,
        branch: opened.branch,
        newBaseSha: opened.newBaseSha,
        rebase,
        priorNodes,
      });
    }
    // A conflicted rebase: jj recorded the conflict IN the commit (the work survived).
    // `RebaseResult` is a single interface (not a discriminated union), so re-narrow it
    // to the conflicted shape the resolver path consumes.
    const conflicted: RebaseResult & { outcome: "conflicted" } = { ...rebase, outcome: "conflicted" };
    return this.settleConflicted({
      ...input,
      ws,
      branch: opened.branch,
      newBaseSha: opened.newBaseSha,
      rebase: conflicted,
      priorNodes,
    });
  }

  /** Open the workspace; a clone/alloc failure is a fail-closed HOLD (the work survives). */
  private async openOrHold(input: {
    projectId: string;
    dependent: SpeculativeDependent;
    nonSpeculative: boolean;
    ancestorStack?: AncestorStack;
  }): Promise<{ workspaceId: string; path: string; branch: string; newBaseSha: string }> {
    try {
      return await this.deps.opener.open({
        projectId: input.projectId,
        dependent: input.dependent,
        nonSpeculative: input.nonSpeculative,
        // §2.2: the live opener assembles this stack LOCALLY (non-empty) — NO synthesized
        // host ref; an empty stack (a non-speculative shift) takes the `default_branch` clone.
        ...(input.ancestorStack !== undefined && { ancestorStack: input.ancestorStack }),
      });
    } catch (error) {
      throw new BaseShiftHeldError("rebase", error instanceof Error ? error.message : String(error));
    }
  }

  /** A CLEAN rebase: re-gate, then keep-the-run (NO re-plan) or re-plan on a failed gate. */
  private async settleClean(input: {
    projectId: string;
    dependent: SpeculativeDependent;
    branch: string;
    newBaseSha: string;
    nonSpeculative: boolean;
    ancestorStack?: AncestorStack;
    ancestorSpecId: string;
    toSha: string;
    reviewVerdict?: "changes_requested";
    rebase: RebaseResult;
    priorNodes: ReadonlyArray<IntegrationNode>;
  }): Promise<BaseShiftRebaseOutcome> {
    const result = await reGateOrHold(this.deps, input.projectId, input.dependent, input.rebase.headSha, {
      branch: input.branch,
      newBaseSha: input.newBaseSha,
      ...(input.ancestorStack !== undefined && { ancestorStack: input.ancestorStack }),
      ancestorSpecId: input.ancestorSpecId,
      priorNodes: input.priorNodes,
    });
    if (result.verdict === "passed") {
      await this.keepRun(input);
      await this.emit(input, false, "rebased_clean");
      return { decision: "rebased_clean", headSha: input.rebase.headSha };
    }
    // A CLEAN rebase whose re-gate FAILED a GATE TIER: the tree is byte-clean (no conflict), the
    // code just fails a deterministic gate on the shifted base — the WRITER's to fix. Route to
    // WRITER REWORK (kept ALIVE), NEVER replan-as-irreconcilable (the detector owns escalation).
    const routed = await this.routeGateFailToRework(input, result.gateError);
    await this.emit(input, false, routed.decision);
    return { ...routed, headSha: input.rebase.headSha };
  }

  /**
   * A CONFLICTED rebase (a SUCCESS that recorded the conflict IN the commit — the work
   * survived). Engage the resolver; on a fit + passing re-gate keep the run, else re-plan.
   */
  private async settleConflicted(input: {
    projectId: string;
    dependent: SpeculativeDependent;
    ws: { workspaceId: string; path: string };
    branch: string;
    newBaseSha: string;
    nonSpeculative: boolean;
    ancestorStack?: AncestorStack;
    ancestorSpecId: string;
    toSha: string;
    reviewVerdict?: "changes_requested";
    rebase: RebaseResult & { outcome: "conflicted" };
    priorNodes: ReadonlyArray<IntegrationNode>;
  }): Promise<BaseShiftRebaseOutcome> {
    let resolution: ConflictResolution;
    try {
      resolution = await this.deps.resolver.resolve({
        projectId: input.projectId,
        dependent: input.dependent,
        workspace: input.ws,
        rebase: input.rebase,
        nonSpeculative: input.nonSpeculative,
        // §2.2: thread the re-resolved stack the OPENER assembled so the live resolver
        // assembles the SAME `main + ordered ancestors` LOCALLY (non-empty) — NO synthesized
        // host ref. Absent/empty (a non-speculative shift) ⇒ the `default_branch` single-ref clone.
        ...(input.ancestorStack !== undefined && { ancestorStack: input.ancestorStack }),
      });
    } catch (error) {
      // A resolver INFRA failure is fail-closed HOLD — the recorded conflict (and the
      // work) survives, retried next notification. Never a silent discard.
      throw new BaseShiftHeldError("resolve", error instanceof Error ? error.message : String(error));
    }

    if (!resolution.resolved) {
      // rework. Consume that exact typed result; never collapse it to a boolean and
      // never double-route. A seam without a delegated route uses persistence's
      // canonical planner route, which returns the same typed disposition.
      const recovery =
        resolution.recovery === undefined
          ? await this.replan(input, `the rebase conflict could not be resolved: ${resolution.reason}`)
          : await settleBaseShiftRecovery(this.deps.persistence, input, resolution.recovery);
      const decision = rebaseDecisionFromRecovery(recovery);
      await this.emit(input, true, decision);
      return { decision, headSha: input.rebase.headSha, recovery };
    }

    // Resolved IN the commit — re-gate the resolved tree. A fit ⇒ keep the run (NO re-plan); a
    // failed GATE-tier re-gate ⇒ WRITER REWORK (the resolved tree is byte-clean, the code just
    // fails a gate); pending ⇒ HOLD (fail-closed).
    const result = await reGateOrHold(this.deps, input.projectId, input.dependent, resolution.headSha, {
      branch: input.branch,
      newBaseSha: input.newBaseSha,
      ...(input.ancestorStack !== undefined && { ancestorStack: input.ancestorStack }),
      ancestorSpecId: input.ancestorSpecId,
      priorNodes: input.priorNodes,
    });
    if (result.verdict === "passed") {
      const resolved: RebaseResult = { outcome: "clean", headSha: resolution.headSha };
      await this.keepRun(input);
      await this.emit({ ...input, rebase: resolved }, true, "rebased_resolved");
      return { decision: "rebased_resolved", headSha: resolution.headSha };
    }
    // A GATE-tier failure on the cleanly-RESOLVED tree → writer rework (not replan). The
    // rework router is REQUIRED — every construction site wires it (no silent fallback).
    const routed = await this.routeGateFailToRework(input, result.gateError);
    await this.emit(input, true, routed.decision);
    return { ...routed, headSha: input.rebase.headSha };
  }

  /**
   * Re-gate the rebased/resolved branch; a `pending` verdict is a fail-closed HOLD. Returns
   * `{ verdict, gateError? }` — the gate error (present on `failed`) is the writer-rework
   * steering. Accepts both a bare verdict string and a `ReGateResult` from the re-gate seam.
   */
  /**
   * A CLEAN-tree (rebased or resolved) GATE-tier re-gate failure → WRITER REWORK: the tree is
   * byte-clean (no conflict), the code just fails a deterministic gate on the shifted base, which
   * the writer can fix. Carries the gate error as steering (no_silent_fallback). The rework
   * router is REQUIRED on `BaseShiftCoordinatorDeps` — no degenerate replan fallback (Codex
   * critic #15): a clean-rebase gate-fail must NEVER route to replan-as-irreconcilable, which
   * would strand the spec at the wrong tier of the doctrine (writer rework, not replan).
   * Escalation is owned by the convergence detector inside the router (a fixed point, no count) —
   * this path NEVER directly escalates to persistent_failure.
   */
  private async routeGateFailToRework(
    input: { projectId: string; dependent: SpeculativeDependent; ancestorSpecId: string; toSha: string },
    gateError: string | undefined,
  ): Promise<{ decision: RebaseDecision; recovery: DurableConflictRecoverySettlement }> {
    const recovery = await this.deps.gateRework.routeGateFailToRework({
      projectId: input.projectId,
      specId: input.dependent.specId,
      runId: input.dependent.runId,
      // no_silent_fallback: carry the REAL gate error; a missing detail is a loud generic note.
      gateError: gateError ?? "the rebased branch failed its re-gate (gate tier) on the shifted base",
    });
    const settled = await settleBaseShiftRecovery(this.deps.persistence, input, recovery);
    return { decision: rebaseDecisionFromRecovery(settled), recovery: settled };
  }

  /**
   * KEEP-THE-RUN (never-discard): re-point the EXISTING run's dynamic base onto the
   * shifted base + stamp the in-flight marker pointing at the SAME run, so the existing
   * settle pass advances `verified_ancestor_shas` against THIS run (no new run created).
   */
  private async keepRun(input: {
    projectId: string;
    dependent: SpeculativeDependent;
    nonSpeculative: boolean;
    ancestorStack?: AncestorStack;
    ancestorSpecId: string;
    toSha: string;
    reviewVerdict?: "changes_requested";
  }): Promise<void> {
    // §2.2 jj-local: the keep-run re-points the EXISTING run onto the RE-RESOLVED ancestor stack
    // (the one the live opener just assembled `main + ordered ancestors` from) — empty when every
    // ancestor merged (non-speculative). NO synthesized integration ref: a run is "speculative" iff
    // the stack is non-empty (§2.3); `ancestor_stack` is the sole base truth (WS-B PR-12 dropped `speculative_base`).
    const ancestorStack: AncestorStack = input.ancestorStack ?? [];
    await this.deps.persistence.repointBase({
      projectId: input.projectId,
      runId: input.dependent.runId,
      ancestorStack,
    });
    await this.deps.persistence.markInFlight({
      projectId: input.projectId,
      runId: input.dependent.runId,
      pending: {
        ancestorSpecId: input.ancestorSpecId,
        toSha: input.toSha,
        ...(input.reviewVerdict !== undefined && { reviewVerdict: input.reviewVerdict }),
      },
    });
  }

  /** Route the dependent back to the planner WITH the shift as context (kept ALIVE). */
  private async replan(
    input: { projectId: string; dependent: SpeculativeDependent; ancestorSpecId: string; toSha: string },
    reason: string,
  ): Promise<DurableConflictRecoverySettlement> {
    const recovery = await this.deps.persistence.recordReplan({
      projectId: input.projectId,
      specId: input.dependent.specId,
      runId: input.dependent.runId,
      ancestorSpecId: input.ancestorSpecId,
      ancestorSha: input.toSha,
      reason,
    });
    return settleBaseShiftRecovery(this.deps.persistence, input, recovery);
  }

  /**
   * Emit the `integration.rebase` event: the categorical `decision` + kept `runId`.
   * It carries NO token/wall-clock figure — the `rebase_vs_rebuild` read-side joins
   * that cost at read time (engine/insights/integration).
   */
  private async emit(
    input: {
      projectId: string;
      dependent: SpeculativeDependent;
      branch: string;
      newBaseSha: string;
      rebase: RebaseResult;
      ancestorStack?: AncestorStack;
      ancestorSpecId?: string;
      priorNodes?: ReadonlyArray<IntegrationNode>;
    },
    rebaseConflicted: boolean,
    decision: RebaseDecision,
  ): Promise<void> {
    await emitBaseShiftRebase(this.deps.events, input, rebaseConflicted, decision);
  }
}
