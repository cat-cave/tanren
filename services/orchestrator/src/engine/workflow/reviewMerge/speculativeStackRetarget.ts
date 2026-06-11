// The speculative-merge state + the WS-A PR-5 STACKED-PR retarget walk, extracted from
// `mergeDispatch.ts` (file-size cap). `resolveSpeculativeState` reads the run's
// speculative state (the legacy `speculative_base` + the ordered `ancestor_stack`, DUAL-
// READ); `retargetStackWalk` walks the PR base ONE step down the stack on each ancestor
// merge under `WALKER_JJ_LOCAL_BASE` (default-OFF). See
// walker-jj-local-integration-design.md §3.2/§3.3. The merge HOLD gating stays in
// `mergeDispatch.ts` and is UNCHANGED.

import { type AncestorStack, resolveAncestorStack } from "../../dag/ancestorStack.js";
import { walkerJjLocalBase } from "../../dag/walkerJjLocalBaseFlag.js";
import type { EventStore } from "../../eventStore.js";
import type { ReviewMergeRunContext, RunStateClient } from "./context.js";
import type { DispatchedIntegration, MergeProbe } from "./mergeDispatchTypes.js";

/** The resolved speculative state of a run at merge time (see {@link resolveSpeculativeState}). */
export interface SpeculativeState {
  speculativeBase: string;
  unmergedAncestors: string[];
  /**
   * WS-A PR-5: the ordered ancestor stack (DUAL-READ). Empty when the run is speculative
   * via the legacy single-ref path with no stack written. Used ONLY when
   * `WALKER_JJ_LOCAL_BASE` is ON, to retarget the PR base ONE step down the stack on each
   * ancestor merge + drop merged heads from `runs.ancestor_stack`.
   */
  ancestorStack: AncestorStack;
  /** The genuinely-merged ancestor spec ids — the set the stack-walk drops from the stack. */
  mergedSpecIds: ReadonlySet<string>;
}

/**
 * §2c: the speculative state of a run at merge time. `undefined` for a
 * NORMAL run (no `speculative_base`) — it merges against `default_branch` as
 * always. For a SPECULATIVE run, `speculativeBase` is the integration ref the PR
 * is based on and `unmergedAncestors` is the (possibly empty) set of deps not yet
 * genuinely merged. The merge stage uses this to:
 *   - HOLD the merge while `unmergedAncestors` is non-empty (no unreviewed ancestor
 *     code reaches `main` early — the dependent's WORK ran on the integration
 *     branch, but its MERGE waits), and
 *   - once it clears (all deps `done`/`merged`), RE-TARGET the PR base from the
 *     integration ref to `default_branch` so the dependent lands on real `main`,
 *     then clean up the integration ref.
 * A `done`/`merged` ancestor is satisfied; anything else is unmerged.
 */
export async function resolveSpeculativeState(
  pool: RunStateClient,
  runId: string,
): Promise<SpeculativeState | undefined> {
  const runResult = await pool.query<{
    speculative_base: string | null;
    ancestor_stack: unknown;
    integrated_ancestor_shas: unknown;
    spec_id: string;
    project_id: string;
  }>(
    "SELECT speculative_base, ancestor_stack, integrated_ancestor_shas, spec_id, project_id FROM runs WHERE run_id = $1",
    [runId],
  );
  const run = runResult.rows[0];
  if (run === undefined || run.speculative_base === null) {
    return undefined;
  }
  // WS-A PR-5: resolve the ordered ancestor stack (DUAL-READ) so the retarget can walk
  // ONE step down the stack on each ancestor merge (flag-on); flag-off ignores it.
  const ancestorStack = resolveAncestorStack({
    ancestorStack: run.ancestor_stack,
    speculativeBase: run.speculative_base,
    integratedAncestorShas: run.integrated_ancestor_shas,
  });
  const specResult = await pool.query<{ depends_on: string[] | null }>(
    "SELECT depends_on FROM specs WHERE spec_id = $1",
    [run.spec_id],
  );
  const dependsOn = (specResult.rows[0]?.depends_on ?? []).filter((id): id is string => typeof id === "string");
  if (dependsOn.length === 0) {
    // A speculative run with no deps is degenerate, but still bases on the
    // integration ref — surface it with an empty unmerged set so the stage
    // re-targets to default_branch before merging (it must not merge into integ).
    return { speculativeBase: run.speculative_base, unmergedAncestors: [], ancestorStack, mergedSpecIds: new Set() };
  }
  // The ancestors that are genuinely merged; an unresolved speculative merge hold
  // disqualifies the row even if the spec status was advanced incorrectly.
  const mergedResult = await pool.query<{ spec_id: string }>(
    `SELECT s.spec_id
       FROM specs s
      WHERE s.project_id = $1
        AND s.spec_id = ANY($2::text[])
        AND s.status = 'merged'
        AND NOT EXISTS (
          SELECT 1
            FROM events held
           WHERE held.project_id = s.project_id
             AND held.org_id = s.org_id
             AND held.spec_id = s.spec_id
             AND held.event_type = 'merge.speculative_held'
             AND NOT EXISTS (
               SELECT 1
                 FROM events done
                WHERE done.project_id = held.project_id
                  AND done.org_id = held.org_id
                  AND done.spec_id = held.spec_id
                  AND done.event_type = 'merge.completed'
                  AND (done.ts > held.ts OR (done.ts = held.ts AND done.id > held.id))
             )
        )`,
    [run.project_id, dependsOn],
  );
  const merged = new Set(mergedResult.rows.map((row) => row.spec_id));
  const unmergedAncestors = dependsOn.filter((id) => !merged.has(id));
  return { speculativeBase: run.speculative_base, unmergedAncestors, ancestorStack, mergedSpecIds: merged };
}

/**
 * WS-A PR-5 (walker-jj-local-integration-design.md §3.2/§3.3): the next retarget target
 * for the stacked-PR base. Drops the genuinely-merged heads from the ordered stack; the
 * new base is the IMMEDIATE (last) STILL-UNMERGED ancestor's PR-head branch, or
 * `defaultBranch` once the stack empties (all ancestors landed). On a diamond/N-ancestor
 * run this walks ONE step per merge (always the single immediate ancestor). Returns the
 * remaining stack so the caller persists the drop.
 */
export function resolveStackRetarget(
  ancestorStack: AncestorStack,
  mergedSpecIds: ReadonlySet<string>,
  defaultBranch: string,
): { toBase: string; remainingStack: AncestorStack } {
  const remainingStack = ancestorStack.filter((member) => !mergedSpecIds.has(member.specId));
  const immediate = remainingStack.at(-1);
  // A reconstructed member with a blank branch (legacy sha-map, ancestorStack.ts) cannot
  // be a PR base — fall to default_branch rather than retarget onto "".
  const toBase = immediate !== undefined && immediate.branch !== "" ? immediate.branch : defaultBranch;
  return { toBase, remainingStack };
}

/**
 * WS-A PR-5 (walker-jj-local-integration-design.md §3.2/§3.3): the STACKED-PR retarget
 * WALK (flag-on path). On each entry: drop the genuinely-merged heads from the ordered
 * `ancestor_stack`, re-point the PR base to the IMMEDIATE still-unmerged ancestor's
 * PR-head branch (or `default_branch` once the stack empties), and persist the dropped
 * stack. Idempotent — when the live base already equals the walk target, only the
 * (idempotent) stack-drop persists; no `retargetBase` / `merge.retargeted` is emitted.
 * The merge HOLD is the caller's concern and is UNCHANGED; this only walks the BASE.
 */
async function retargetStackWalk(args: {
  pool: RunStateClient;
  eventStore: EventStore;
  context: ReviewMergeRunContext;
  taskId: string;
  integration: DispatchedIntegration;
  prNumber: number;
  probe: MergeProbe;
  speculative: SpeculativeState;
  defaultBranch: string;
}): Promise<void> {
  const { toBase, remainingStack } = resolveStackRetarget(
    args.speculative.ancestorStack,
    args.speculative.mergedSpecIds,
    args.defaultBranch,
  );
  const mergeability = await args.probe.readMergeability();
  if (mergeability.baseBranch !== toBase) {
    await args.probe.retargetBase(toBase);
    await args.eventStore.append({
      runId: args.context.runId,
      specId: args.context.specId,
      projectId: args.context.projectId,
      taskId: args.taskId,
      eventType: "merge.retargeted",
      payload: {
        prUrl: args.context.prUrl,
        prNumber: args.prNumber,
        integration: args.integration,
        fromBase: mergeability.baseBranch,
        toBase,
      },
    });
  }
  // Drop the merged heads from `runs.ancestor_stack` (additive PR-1 dual-write column).
  // Only when the stack actually shrank, so a steady-state re-entry issues no write.
  if (remainingStack.length !== args.speculative.ancestorStack.length) {
    await args.pool.query("UPDATE runs SET ancestor_stack = $2::jsonb WHERE run_id = $1", [
      args.context.runId,
      JSON.stringify(remainingStack),
    ]);
  }
}

/** The shared arg surface the speculative retarget paths read off the merge stage. */
export interface SpeculativeRetargetArgs {
  pool: RunStateClient;
  eventStore: EventStore;
  context: ReviewMergeRunContext;
  taskId: string;
  integration: DispatchedIntegration;
  prNumber: number;
  probe: MergeProbe;
  speculative: SpeculativeState;
  /** Whether any ancestor is still unmerged (the MERGE is held; the BASE may still walk). */
  speculativeHold: boolean;
}

/**
 * §2c + WS-A PR-5: re-point a speculative dependent's PR base BEFORE any merge. Dispatches
 * on `WALKER_JJ_LOCAL_BASE`:
 *   - flag ON + a non-empty ancestor stack → the STACKED-PR WALK (walks one step down the
 *     stack on each ancestor merge, drops merged heads; held OR cleared), and
 *   - flag OFF → the legacy single-step integ→`default_branch` retarget, fired ONLY once
 *     the hold clears (byte-identical to main).
 * The merge HOLD itself stays in the caller and is UNCHANGED.
 */
export async function applySpeculativeRetarget(args: SpeculativeRetargetArgs): Promise<void> {
  if (walkerJjLocalBase() && args.speculative.ancestorStack.length > 0) {
    await retargetStackWalk({ ...args, defaultBranch: args.context.baseBranch });
    return;
  }
  if (walkerJjLocalBase()) {
    // flag ON but no stack written (legacy single-ref speculative row): nothing to walk;
    // the legacy retarget below is suppressed by the flag, so this run keeps its base.
    return;
  }
  // Flag OFF: the legacy HOLD-CLEARED retarget — integ ref → `default_branch` so the
  // dependent lands on REAL main, never the integration ref. Skipped while still held.
  const defaultBranch = args.context.baseBranch;
  if (args.speculativeHold || args.speculative.speculativeBase === defaultBranch) {
    return;
  }
  const mergeability = await args.probe.readMergeability();
  if (mergeability.baseBranch === defaultBranch) {
    return;
  }
  await args.probe.retargetBase(defaultBranch);
  await args.eventStore.append({
    runId: args.context.runId,
    specId: args.context.specId,
    projectId: args.context.projectId,
    taskId: args.taskId,
    eventType: "merge.retargeted",
    payload: {
      prUrl: args.context.prUrl,
      prNumber: args.prNumber,
      integration: args.integration,
      fromBase: args.speculative.speculativeBase,
      toBase: defaultBranch,
    },
  });
}
