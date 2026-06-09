// THE ONE BASE-SHIFT HANDLER on the merge path (tanren-owns-the-engine.md §7 — "the two
// divergent base-shift handlers → one"). The merge dispatcher's `behind`-mergeability
// rebase routes through THIS hook → the SAME `BaseShiftCoordinator.rebaseOnto` the
// change-percolation kick-off uses: the PR branch fell behind its base, so re-derive the
// work by rebasing the EXISTING branch in place over jj (never a server-side regenerate),
// re-gate it, and resolve a recorded conflict — never-discard. It maps the coordinator's
// `RebaseDecision` onto the dispatcher's `BaseShiftRebaseHook` outcome:
//   - `rebased_clean` / `rebased_resolved` ⇒ `rebased` (the branch advanced onto base; the
//     dispatcher re-gates then the authority governs the merge).
//   - `replanned` ⇒ `held` — the coordinator ALREADY routed the work back to the planner
//     (kept ALIVE with the shift as context); the merge holds (recoverable) rather than
//     proceeding on work that no longer fits. NEVER a silent merge, NEVER a discard.
//   - a `BaseShiftHeldError` (any infra/alloc/clone/gate/resolver fail) ⇒ `held` (loud,
//     recoverable; the work survives, retried on the next drive).
//
// FAIL-CLOSED: the hook never returns `rebased` on anything but a clean/resolved + passing
// re-gate; everything else holds. When the live seams are not wired (flag OFF / no runner
// deps) the coordinator's seams are the `Held*` stubs, so this hook returns `held` loudly.

import { runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import type { SpeculativeDependent } from "../contracts/changePercolation.js";
import type { BaseShiftRebaseHook } from "../workflow/reviewMerge/mergeDispatchTypes.js";
import { type BaseShiftCoordinator, BaseShiftHeldError } from "./baseShiftCoordinator.js";

/**
 * Build the merge-path `behind` rebase hook over the live (or held) `BaseShiftCoordinator`.
 * Loads the run's spec id (the coordinator keys its persistence/replan on it), then drives
 * `rebaseOnto` onto the PR's plain base branch (`nonSpeculative` — the merge-time base is a
 * real branch, not a speculative integration ref) and maps the outcome. A held error is the
 * fail-closed `held`; a missing run is `held` (recoverable — never a silent proceed).
 */
export function buildBaseShiftRebaseHook(deps: {
  pool: pg.Pool;
  coordinator: BaseShiftCoordinator;
}): BaseShiftRebaseHook {
  return async (input) => {
    let loaded: { dependent: SpeculativeDependent; projectId: string };
    try {
      loaded = await loadMergeBehindDependent(deps.pool, input.runId);
    } catch (error) {
      return { outcome: "held", message: error instanceof Error ? error.message : String(error) };
    }
    const { dependent, projectId } = loaded;
    try {
      const { decision, headSha } = await deps.coordinator.rebaseOnto({
        projectId,
        dependent,
        newBaseRef: input.baseBranch,
        // The merge-time base is the PR's plain base branch (not a speculative integration
        // ref) — a non-speculative rebase straight onto it.
        nonSpeculative: true,
        // The behind path is a base-branch advance, not an ancestor percolation: there is
        // NO ancestor spec + NO ancestor merged-sha. `ancestorSpecId` keys the marker on the
        // base BRANCH (the shift's `from`); `toSha` is left EMPTY (§3.1 event-pollution
        // side-fix — the old `input.baseBranch` recorded a BRANCH NAME on the
        // `integration.rebase` event's `toSha` as if it were a sha; the honest value for a
        // non-percolation base advance is empty, not a fabricated sha).
        ancestorSpecId: input.baseBranch,
        toSha: "",
      });
      // `rebased_clean` / `rebased_resolved` ⇒ the branch advanced onto base (the dispatcher
      // re-gates then merges); `replanned` ⇒ the work was routed back (hold the merge).
      // COMMIT-BINDING (§5): surface the rebased head sha so the dispatcher's re-gate
      // anchors its verdict on the rebased PR head (never the stale workspace HEAD).
      if (decision === "rebased_clean" || decision === "rebased_resolved") {
        return { outcome: "rebased", ...(headSha !== "" && { rebasedHeadSha: headSha }) };
      }
      return { outcome: "held", message: "base shift re-planned the work (routed back to the planner; merge held)" };
    } catch (error) {
      if (error instanceof BaseShiftHeldError) {
        return { outcome: "held", message: error.message };
      }
      throw error;
    }
  };
}

/**
 * Load the minimal {@link SpeculativeDependent} the coordinator's `rebaseOnto` needs for a
 * merge-`behind` rebase: the run's spec id (keys the persistence/replan) + its branch. The
 * lifecycle/severity/ancestor fields are not read on the rebase path (they settle a
 * percolation marker, which the merge-behind path does not run), so they carry safe empties.
 */
async function loadMergeBehindDependent(
  pool: pg.Pool,
  runId: string,
): Promise<{ dependent: SpeculativeDependent; projectId: string }> {
  const row = await runWithSystemScope(pool, async (client) => {
    const result = await client.query<{ spec_id: string; project_id: string }>(
      "SELECT spec_id, project_id FROM runs WHERE run_id = $1",
      [runId],
    );
    return result.rows[0];
  });
  if (row === undefined) {
    throw new Error(`base-shift behind rebase: run ${runId} not found`);
  }
  return {
    projectId: row.project_id,
    dependent: {
      specId: row.spec_id,
      runId,
      speculativeBase: null,
      integratedAncestorShas: {},
      verifiedAncestorShas: {},
      lifecycleState: "review",
      openFindingMaxSeverity: "none",
    },
  };
}
