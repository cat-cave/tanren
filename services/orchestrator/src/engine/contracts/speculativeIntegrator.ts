// The `SpeculativeIntegrator` seam (autonomy-engine.md §2c): when the DagWalker
// decides a dependent is ready to start SPECULATIVELY (its unmerged ancestors all
// crossed the threshold), it asks this seam to BUILD THE INTEGRATION BRANCH the
// dependent's PR will base on — `main + each unmerged ancestor's branch` merged in
// DAG order. The seam owns resolving each ancestor's PR/run branch, the repo +
// VCS credentials, and driving `VcsProvider.buildIntegrationBranch`; it returns
// the integration branch ref (the dynamic base) OR a structured ANCESTOR-VS-
// ANCESTOR conflict so the walker can route that pair to the conflict resolver (the
// conflict surfaces HERE, early, on the integration branch — not against the
// innocent dependent). The walker stays a pure scheduler; the VCS work lives
// behind this seam (the pg/VcsProvider impl is in `engine/dag/speculativeIntegrator.ts`).
//
// Change-percolation (re-integrating an upstream change down a live chain) is
// OUT of scope here — that is change-percolation. This seam only builds the branch a dependent
// STARTS on; re-gating against reality at real merge time reuses the up-to-date path.

import type { AncestorStack } from "../dag/ancestorStack.js";

/**
 * The result of building a dependent's speculative integration branch. On
 * `integrated`, `integrationBranch` is the dynamic base the dependent's run is
 * created against. On `conflict`, two of the dependent's ancestors conflict WITH
 * EACH OTHER — `conflictBetween` names the pair so the walker routes it to the
 * resolver and the dependent is HELD this tick (it cannot base on a broken
 * integration); the walker retries once the pair is reconciled/merged.
 */
export interface IntegrationOutcome {
  outcome: "integrated" | "conflict";
  integrationBranch: string;
  /**
   * change-percolation: the head SHA each merged ancestor was integrated
   * AT, keyed by ancestor spec id. The walker records this on the dependent's
   * speculative run as the divergence key; a later ancestor advance past the
   * recorded SHA is what the change-percolation detect keys off.
   */
  ancestorHeadShas: Record<string, string>;
  /**
   * walker-jj-local-integration-design.md §2.3 / WS-A PR-1: the ORDERED ancestor
   * stack this integration assembled — `[{ specId, runId, branch, headSha }]` in DAG
   * order (the same content as `ancestorHeadShas`, but as the load-bearing ordered
   * structure the dependent run dual-writes to `runs.ancestor_stack`). Empty on
   * `conflict`. ADDITIVE: written but not yet read by the run path.
   */
  ancestorStack: AncestorStack;
  /** On `conflict`: the two ancestor specs that conflict with each other. */
  conflictBetween?: { specId: string; otherSpecId: string };
  message: string;
}

export interface BuildSpeculativeIntegrationInput {
  projectId: string;
  /** The dependent spec the integration branch is FOR (names the ephemeral ref). */
  dependentSpecId: string;
  /** The unmerged ancestor spec ids, in DAG order (ancestors before dependents). */
  unmergedAncestorSpecIds: ReadonlyArray<string>;
}

/**
 * Builds (or rebuilds) the speculative integration branch for a dependent. The
 * production impl resolves the repo + credentials + each ancestor's branch under
 * the project's org scope, then drives `VcsProvider.buildIntegrationBranch`. It is
 * idempotent: re-building resets the ephemeral ref to `default_branch` first, so a
 * stale integration is never additive.
 */
export interface SpeculativeIntegrator {
  buildIntegration(input: BuildSpeculativeIntegrationInput): Promise<IntegrationOutcome>;
}
