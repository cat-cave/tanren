// The base-shift PERSISTENCE / NODE-READ / EVENT ports (tanren-owns-the-engine.md §3
// never-discard) — split from `baseShiftCoordinator.ts` to keep that file under the
// architecture line cap. These are the keep-run-row write surface + the S0 node read + the
// `integration.rebase` emitter the `BaseShiftCoordinator` drives; the coordinator re-exports
// them so existing import sites (`baseShiftCoordinatorPg`, the held/live seams, the tests)
// keep importing from `./baseShiftCoordinator.js` unchanged.

import type { SpeculativeDependent } from "../contracts/changePercolation.js";
import type { GateReworkRouteResult } from "../contracts/conflictResolution.js";
import type { IntegrationNode } from "../contracts/integrationNodes.js";
import type { AncestorStack } from "./ancestorStack.js";

/**
 * The instrumentation an `integration.rebase` event records (`rebase_vs_rebuild`, §3).
 * `writer_rework` / `parked` are first-class — never laundered as `replanned`.
 */
export type RebaseDecision = "rebased_clean" | "rebased_resolved" | "replanned" | "writer_rework" | "parked" | "held";

/**
 * A fail-closed HOLD: the rebase/resolver/gate could not settle. The work SURVIVES (the run
 * row + branch are untouched) and is retried on the next notification — NEVER a silent merge,
 * NEVER a silent discard.
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

/** The re-gate verdict over the rebased/resolved branch (the dependent's OWN deterministic gate). */
export type ReGateVerdict = "passed" | "failed" | "pending";

/**
 * The re-gate result: the verdict plus — on `failed` — the failing tier/step/output, so a
 * CLEAN-rebase gate failure can route to WRITER REWORK carrying the real gate error as
 * steering (no_silent_fallback — never rework blind). A bare verdict string is still accepted
 * by the coordinator (back-mapped to `{ verdict, gateError: undefined }`) for the conformance fakes.
 */
export interface ReGateResult {
  verdict: ReGateVerdict;
  /** The failing tier/step/output, present only when `verdict === "failed"`. */
  gateError?: string;
}

/**
 * Routes the dependent spec to WRITER REWORK when a CLEAN rebase's re-gate fails a GATE TIER
 * (lint/test/build) on the shifted base — the rebase recorded NO conflict, the code simply
 * fails a gate, which the writer can fix on the new base. The SAME never-discard re-author
 * the conflict-resolver's gate-rework path uses (re-open + steering + a fresh run). DISTINCT
 * from `recordReplan` (a genuine conflict / does-not-fit): a clean-rebase gate-fail is NOT a
 * conflict and must NOT route to replan/escalate. Escalation is owned by the convergence
 * detector (a fixed point, no count).
 */
export interface BaseShiftGateReworkRouter {
  routeGateFailToRework(input: {
    projectId: string;
    specId: string;
    runId: string;
    /** The re-gate's failing tier/step/output — the steering the writer re-authors against. */
    gateError: string;
  }): Promise<GateReworkRouteResult>;
}

/**
 * The KEEP-RUN-ROW persistence (never-discard). A base shift NEVER creates a run: it
 * re-points the EXISTING run's dynamic base, stamps the in-flight marker pointing at
 * THAT SAME run (so the existing settle pass advances `verified_ancestor_shas` once the
 * re-gate passes), and — only on an irreconcilable shift — records the replan context.
 * The dependent's run row + git branch survive every path.
 */
export interface BaseShiftPersistence {
  /** Re-point the EXISTING run's dynamic base to the re-resolved ancestor stack. Keeps the row. */
  repointBase(input: {
    projectId: string;
    runId: string;
    /**
     * The re-resolved ordered ancestor stack persisted to `runs.ancestor_stack`
     * (walker-jj-local-integration-design.md §2.2/§2.3) — the SOURCE OF TRUTH (a run is
     * "speculative" iff non-empty). Empty when non-speculative (every ancestor merged). The
     * legacy `speculative_base` column was dropped (WS-B PR-12; jj-local has no host ref).
     */
    ancestorStack: AncestorStack;
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
