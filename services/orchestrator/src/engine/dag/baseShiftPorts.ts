// The base-shift PERSISTENCE / NODE-READ / EVENT ports (tanren-owns-the-engine.md §3
// never-discard) — split from `baseShiftCoordinator.ts` to keep that file under the
// architecture line cap. These are the keep-run-row write surface + the S0 node read + the
// `integration.rebase` emitter the `BaseShiftCoordinator` drives; the coordinator re-exports
// them so existing import sites (`baseShiftCoordinatorPg`, the held/live seams, the tests)
// keep importing from `./baseShiftCoordinator.js` unchanged.

import type { SpeculativeDependent } from "../contracts/changePercolation.js";
import type { IntegrationNode } from "../contracts/integrationNodes.js";
import type { AncestorStack } from "./ancestorStack.js";

/** The instrumentation an `integration.rebase` event records (`rebase_vs_rebuild`, §3). */
export type RebaseDecision = "rebased_clean" | "rebased_resolved" | "replanned" | "held";

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
     * The re-resolved ordered ancestor stack persisted to `runs.ancestor_stack`
     * (walker-jj-local-integration-design.md §2.2/§2.3). With `WALKER_JJ_LOCAL_BASE` ON it
     * is the SOURCE OF TRUTH (a run is "speculative" iff non-empty); flag-off it is the
     * PR-1 dual-write alongside the legacy `speculative_base`. Empty when non-speculative.
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
