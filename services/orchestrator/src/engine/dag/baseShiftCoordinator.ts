// The ONE base-shift handler (tanren-owns-the-engine.md §3 never-discard + §7 "the two
// divergent base-shift handlers → one"). A base shift is NEW CONTEXT, never a reason to
// throw work away: an ancestor lands, OR an unrelated spec lands and moves a shared base.
// Both the percolation kick-off (an ancestor changed under an in-flight dependent) and
// the merge-path `behind` mergeability (the PR branch fell behind its base) route HERE.
//
// THE KEYSTONE — never-discard rebase replaces supersede+regenerate. The deleted
// `PgPercolationReexecutor` SUPERSEDED the dependent's run (cancelled it, dequeued it,
// force-pushed a fresh clone) and RE-PLANNED from scratch via `createQueuedRunFromSpec`
// — discarding every planner/writer/code token. This coordinator instead:
//   (a) loads the affected `integration_nodes` (S0 read model);
//   (b) rebases the dependent's EXISTING branch onto the shifted base via
//       `WorkspaceVcsCore.rebaseOnto` (the jj impl) — KEEPING the same run/branch row
//       (never cancel+recreate; the run id is returned UNCHANGED as the re-exec id, so
//       the existing settle pass advances `verified_ancestor_shas` after the re-gate);
//   (c) re-gates the rebased branch;
//   (d) re-plans ONLY when the rebase CONFLICTED and the resolver + re-gate say the old
//       work no longer fits. A clean rebase + passing gate NEVER re-plans.
//
// FAIL-CLOSED (§0): a rebase/gate/resolver failure HOLDS (the work survives, retried on
// the next notification) — it NEVER silently merges and NEVER silently discards. jj's
// first-class conflicts make "a conflict must never brick" true by construction: a
// conflicting rebase SUCCEEDS and records the conflict IN the commit (`rebaseOnto` never
// throws), so even an irreconcilable shift keeps the work — it routes back to the planner
// WITH the shift as context, alive.

import type { PercolationDecision, SpeculativeDependent } from "../contracts/changePercolation.js";
import type { IntegrationNode } from "../contracts/integrationNodes.js";
import { ancestorStackFromShaMap, type AncestorStack } from "./ancestorStack.js";
import type { RebaseResult, WorkspaceVcsCore } from "../contracts/workspaceVcsCore.js";
import type { PercolationReexecutor } from "./percolationOperation.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("base-shift");

/** The instrumentation an `integration.rebase` event records (`rebase_vs_rebuild`, §3). */
export type RebaseDecision = "rebased_clean" | "rebased_resolved" | "replanned" | "held";

/**
 * Opens the dependent's runner-local workspace for a base-shift rebase. The production
 * impl allocates a runner, clones the repo via the jj `WorkspaceVcsCore`, and resolves
 * the dependent's branch; a test injects an in-memory opener. Returns the workspace
 * handle + the branch to rebase + the resolved new-base sha the rebase lands on.
 */
export interface BaseShiftWorkspaceOpener {
  open(input: {
    projectId: string;
    dependent: SpeculativeDependent;
    /** The shifted base ref (the rebuilt integration branch, or plain `default_branch`). */
    newBaseRef: string;
    /** True when EVERY ancestor merged (the rebase is onto plain `default_branch`). */
    nonSpeculative: boolean;
  }): Promise<{ workspaceId: string; path: string; branch: string; newBaseSha: string }>;
}

/** The outcome of re-gating the rebased branch (the dependent's OWN gate+checker+auditor). */
export type ReGateVerdict = "passed" | "failed" | "pending";

/**
 * Re-gates the rebased branch — the dependent's OWN gate + checker + auditor over the
 * rebased tree. `passed` ⇒ the existing work FITS the shifted base (no re-plan).
 * `failed` ⇒ the work no longer fits (route back to the planner WITH the shift).
 * `pending` ⇒ inconclusive ⇒ HOLD (fail-closed; never merge on an unverified rebase).
 */
export interface BaseShiftReGate {
  reGate(input: { projectId: string; dependent: SpeculativeDependent; rebasedHeadSha: string }): Promise<ReGateVerdict>;
}

/** The intent-preserving resolution of a recorded rebase conflict, or `irreconcilable`. */
export type ConflictResolution = { resolved: true; headSha: string } | { resolved: false; reason: string };

/**
 * Resolves a recorded rebase conflict (intent + vision preserving), writing the
 * resolution INTO the conflicted branch commit via `WorkspaceVcsCore.resolveConflict`
 * (the work is NEVER recreated). `irreconcilable` means the shift genuinely broke the
 * old work — the coordinator then re-plans (kept alive), never discards.
 */
export interface BaseShiftConflictResolver {
  resolve(input: {
    projectId: string;
    dependent: SpeculativeDependent;
    workspace: { workspaceId: string; path: string };
    rebase: RebaseResult & { outcome: "conflicted" };
    /**
     * The SHIFTED base the conflict must be resolved + re-gated AGAINST — the SAME base the
     * initial `rebaseOnto` used (the rebuilt speculative integration ref, or plain
     * `default_branch` when non-speculative), NOT the project default. The resolver MUST
     * gather/replay the conflict against THIS base, else it would resolve against the wrong
     * base and mark work `rebased_resolved` that was never proven against the base it lands
     * on (a fail-OPEN). `newBaseRef` is the branch the resolver re-clones + the conflict is
     * gathered onto; `nonSpeculative` is true when EVERY ancestor merged (rebase onto plain
     * `default_branch`).
     */
    newBaseRef: string;
    nonSpeculative: boolean;
  }): Promise<ConflictResolution>;
}

/**
 * The KEEP-RUN-ROW persistence (never-discard). A base shift NEVER creates a run: it
 * re-points the EXISTING run's dynamic base, stamps the in-flight marker pointing at
 * THAT SAME run (so the existing settle pass advances `verified_ancestor_shas` once the
 * re-gate passes), and — only on an irreconcilable shift — records the replan context.
 * The dependent's run row + git branch survive every path.
 */
export interface BaseShiftPersistence {
  /** Re-point the EXISTING run's dynamic base (NULL when non-speculative). Keeps the row. */
  repointBase(input: {
    projectId: string;
    runId: string;
    speculativeBase: string | null;
    /**
     * WS-A PR-1 (walker-jj-local-integration-design.md §2.3): the re-resolved ordered
     * ancestor stack, DUAL-WRITTEN to `runs.ancestor_stack` alongside the legacy base.
     * Empty when non-speculative. ADDITIVE (written, not yet read).
     */
    ancestorStack?: AncestorStack;
  }): Promise<void>;
  /** Stamp the in-flight percolation marker on the EXISTING run (the settle handle). */
  markInFlight(input: {
    projectId: string;
    runId: string;
    pending: { ancestorSpecId: string; toSha: string; reviewVerdict?: "changes_requested" };
  }): Promise<void>;
  /** Record the replan context (intent stays ALIVE) when the old work no longer fits. */
  recordReplan(input: {
    projectId: string;
    specId: string;
    runId: string;
    ancestorSpecId: string;
    ancestorSha: string;
    reason: string;
  }): Promise<void>;
}

/** Reads the affected `integration_nodes` for a base shift (S0 observe model). */
export interface BaseShiftNodeReader {
  nodesForDependent(input: { projectId: string; dependent: SpeculativeDependent }): Promise<IntegrationNode[]>;
}

/**
 * Emits the `integration.rebase` event — the categorical `decision` + kept `runId`
 * the `rebase_vs_rebuild` read-side (engine/insights/integration) consumes, joining
 * token/wall-clock cost at read time.
 */
export interface BaseShiftEventEmitter {
  emitRebase(input: {
    projectId: string;
    specId: string;
    runId: string;
    branch: string;
    newBaseSha: string;
    headSha: string;
    rebaseConflicted: boolean;
    decision: RebaseDecision;
  }): Promise<void>;
}

export interface BaseShiftCoordinatorDeps {
  workspace: WorkspaceVcsCore;
  opener: BaseShiftWorkspaceOpener;
  reGate: BaseShiftReGate;
  resolver: BaseShiftConflictResolver;
  persistence: BaseShiftPersistence;
  nodes: BaseShiftNodeReader;
  events: BaseShiftEventEmitter;
}

/**
 * A fail-closed HOLD: the rebase/resolver/gate could not settle. The work SURVIVES (the
 * run row + branch are untouched) and is retried on the next notification — NEVER a
 * silent merge, NEVER a silent discard.
 */
export class BaseShiftHeldError extends Error {
  constructor(
    readonly stage: "rebase" | "regate" | "resolve",
    reason: string,
  ) {
    super(`base shift held at ${stage}: ${reason}`);
    this.name = "BaseShiftHeldError";
  }
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
    integrationBranch: string;
    ancestorHeadShas: Record<string, string>;
    nonSpeculative: boolean;
  }): Promise<{ reexecRunId: string }> {
    await this.rebaseOnto({
      projectId: input.projectId,
      dependent: input.dependent,
      newBaseRef: input.integrationBranch,
      nonSpeculative: input.nonSpeculative,
      ancestorSpecId: input.decision.ancestorSpecId,
      toSha: input.decision.toSha,
      ...(input.decision.immediateSeverity === "changes_requested" && {
        reviewVerdict: "changes_requested" as const,
      }),
    });
    // NEVER-DISCARD: the re-exec run id IS the dependent's existing run id. The branch
    // was rebased in place; the run row was KEPT. The settle pass resolves THIS run.
    return { reexecRunId: input.dependent.runId };
  }

  /**
   * The unified base-shift rebase (the SINGLE point both the percolation kick-off AND the
   * merge-path `behind` handler flow through). Loads the affected integration node,
   * rebases the dependent's existing branch onto the shifted base via the jj core,
   * emits `integration.rebase`, and:
   *   - clean rebase + passing re-gate  ⇒ KEEP the run (re-point base + stamp the
   *     in-flight marker on the SAME run) — NO re-plan (tokens reused). `rebased_clean`.
   *   - conflicted rebase, resolver fits + re-gate passes ⇒ KEEP the run, same as clean.
   *     `rebased_resolved` (the work survived the conflict + fit after resolve).
   *   - conflicted + (irreconcilable resolver OR a failed re-gate) ⇒ re-plan (kept
   *     ALIVE, routed back WITH the shift) on the SAME run. `replanned`.
   *   - any rebase/gate/resolver failure ⇒ HOLD (fail-closed; the work survives).
   * Returns the `rebase_vs_rebuild` decision for the caller.
   */
  async rebaseOnto(input: {
    projectId: string;
    dependent: SpeculativeDependent;
    newBaseRef: string;
    nonSpeculative: boolean;
    ancestorSpecId: string;
    toSha: string;
    reviewVerdict?: "changes_requested";
  }): Promise<{ decision: RebaseDecision; headSha: string }> {
    const { projectId, dependent } = input;
    // (a) Load the affected integration_nodes (S0). Observe-only today — it does NOT
    //     branch control flow; it makes the shift's node context inspectable + is the
    //     substrate Wave 3 keys proof reuse on. A read failure is non-fatal (logged).
    await this.deps.nodes.nodesForDependent({ projectId, dependent }).catch((error: unknown) => {
      log.warn("integration-node read failed (non-fatal)", { specId: dependent.specId }, error);
      return [];
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
      return this.settleClean({ ...input, branch: opened.branch, newBaseSha: opened.newBaseSha, rebase });
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
    });
  }

  /** Open the workspace; a clone/alloc failure is a fail-closed HOLD (the work survives). */
  private async openOrHold(input: {
    projectId: string;
    dependent: SpeculativeDependent;
    newBaseRef: string;
    nonSpeculative: boolean;
  }): Promise<{ workspaceId: string; path: string; branch: string; newBaseSha: string }> {
    try {
      return await this.deps.opener.open({
        projectId: input.projectId,
        dependent: input.dependent,
        newBaseRef: input.newBaseRef,
        nonSpeculative: input.nonSpeculative,
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
    newBaseRef: string;
    ancestorSpecId: string;
    toSha: string;
    reviewVerdict?: "changes_requested";
    rebase: RebaseResult;
  }): Promise<{ decision: RebaseDecision; headSha: string }> {
    const verdict = await this.reGateOrHold(input.projectId, input.dependent, input.rebase.headSha);
    if (verdict === "passed") {
      await this.keepRun(input);
      await this.emit(input, false, "rebased_clean");
      return { decision: "rebased_clean", headSha: input.rebase.headSha };
    }
    // A clean rebase whose re-gate FAILED: the work no longer fits the shifted base.
    // Route back to the planner WITH the shift (kept ALIVE) — NEVER discard, NEVER merge.
    await this.replan(input, "the rebased branch failed its re-gate on the shifted base");
    await this.emit(input, false, "replanned");
    return { decision: "replanned", headSha: input.rebase.headSha };
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
    newBaseRef: string;
    ancestorSpecId: string;
    toSha: string;
    reviewVerdict?: "changes_requested";
    rebase: RebaseResult & { outcome: "conflicted" };
  }): Promise<{ decision: RebaseDecision; headSha: string }> {
    let resolution: ConflictResolution;
    try {
      resolution = await this.deps.resolver.resolve({
        projectId: input.projectId,
        dependent: input.dependent,
        workspace: input.ws,
        rebase: input.rebase,
        // Resolve + re-gate against the SAME shifted base the initial rebase used (the
        // speculative integration ref, or plain default_branch) — NEVER the project default.
        newBaseRef: input.newBaseRef,
        nonSpeculative: input.nonSpeculative,
      });
    } catch (error) {
      // A resolver INFRA failure is fail-closed HOLD — the recorded conflict (and the
      // work) survives, retried next notification. Never a silent discard.
      throw new BaseShiftHeldError("resolve", error instanceof Error ? error.message : String(error));
    }

    if (!resolution.resolved) {
      // IRRECONCILABLE: the shift genuinely broke the old work. Route back to the planner
      // WITH the shift as context (kept ALIVE on the SAME run) — NEVER discard, NEVER merge.
      await this.replan(input, `the rebase conflict could not be resolved: ${resolution.reason}`);
      await this.emit(input, true, "replanned");
      return { decision: "replanned", headSha: input.rebase.headSha };
    }

    // Resolved IN the commit — re-gate the resolved tree. A fit ⇒ keep the run (NO
    // re-plan: the existing work fit after the intent-preserving resolve); a failed
    // re-gate ⇒ re-plan (kept alive); pending ⇒ HOLD (fail-closed).
    const verdict = await this.reGateOrHold(input.projectId, input.dependent, resolution.headSha);
    if (verdict === "passed") {
      // The resolved tree FIT (re-gate passed) — keep the run (NO re-plan). The emitted
      // head is the RESOLVED head (the conflict was reconciled IN the commit).
      const resolved: RebaseResult = { outcome: "clean", headSha: resolution.headSha };
      await this.keepRun(input);
      await this.emit({ ...input, rebase: resolved }, true, "rebased_resolved");
      return { decision: "rebased_resolved", headSha: resolution.headSha };
    }
    await this.replan(input, "the resolved branch failed its re-gate on the shifted base");
    await this.emit(input, true, "replanned");
    return { decision: "replanned", headSha: input.rebase.headSha };
  }

  /** Re-gate the rebased/resolved branch; a `pending` verdict is a fail-closed HOLD. */
  private async reGateOrHold(
    projectId: string,
    dependent: SpeculativeDependent,
    rebasedHeadSha: string,
  ): Promise<"passed" | "failed"> {
    let verdict: ReGateVerdict;
    try {
      verdict = await this.deps.reGate.reGate({ projectId, dependent, rebasedHeadSha });
    } catch (error) {
      throw new BaseShiftHeldError("regate", error instanceof Error ? error.message : String(error));
    }
    if (verdict === "pending") {
      // Inconclusive: NEVER merge on an unverified rebase. Hold (the work survives).
      throw new BaseShiftHeldError("regate", "the re-gate did not converge (held, not merged)");
    }
    return verdict;
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
    newBaseRef: string;
    ancestorSpecId: string;
    toSha: string;
    reviewVerdict?: "changes_requested";
  }): Promise<void> {
    // Non-speculative (every ancestor merged) re-points the base to NULL (a real run
    // against main); else the rebuilt integration branch.
    const speculativeBase = input.nonSpeculative ? null : input.newBaseRef;
    // WS-A PR-1 dual-write: re-point `runs.ancestor_stack` alongside the legacy base.
    // Non-speculative ⇒ empty stack; else the re-resolved stack reconstructed from the
    // dependent's current per-ancestor SHA map (the same content the legacy
    // `integrated_ancestor_shas` carries). ADDITIVE — written, not yet read.
    const ancestorStack: AncestorStack = input.nonSpeculative
      ? []
      : ancestorStackFromShaMap(input.dependent.integratedAncestorShas);
    await this.deps.persistence.repointBase({
      projectId: input.projectId,
      runId: input.dependent.runId,
      speculativeBase,
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
  ): Promise<void> {
    await this.deps.persistence.recordReplan({
      projectId: input.projectId,
      specId: input.dependent.specId,
      runId: input.dependent.runId,
      ancestorSpecId: input.ancestorSpecId,
      ancestorSha: input.toSha,
      reason,
    });
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
    },
    rebaseConflicted: boolean,
    decision: RebaseDecision,
  ): Promise<void> {
    await this.deps.events.emitRebase({
      projectId: input.projectId,
      specId: input.dependent.specId,
      runId: input.dependent.runId,
      branch: input.branch,
      newBaseSha: input.newBaseSha,
      headSha: input.rebase.headSha,
      rebaseConflicted,
      decision,
    });
  }
}
