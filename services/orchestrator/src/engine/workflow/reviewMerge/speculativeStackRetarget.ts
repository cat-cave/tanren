// The speculative-merge state + the STACKED-PR retarget walk, extracted from
// `mergeDispatch.ts` (file-size cap). `resolveSpeculativeState` reads the run's speculative
// state from `runs.ancestor_stack` (a run is "speculative" iff the stack is non-empty, §2.3);
// `retargetStackWalk` walks the PR base ONE step down the stack on each ancestor merge. See
// walker-jj-local-integration-design.md §3.2/§3.3. The merge HOLD gating stays in
// `mergeDispatch.ts` and is UNCHANGED.
//
// gv-4: merged membership is resolved over the COMPLETE persisted ancestor member vector
// (`ancestor_stack[].specId`), never direct-only `specs.depends_on`. Applying an incomplete
// direct-only set to the full stack leaves already-merged transitive ancestors as a stale
// PR base after the direct parent lands.

import { type AncestorStack, resolveAncestorStack } from "../../dag/ancestorStack.js";
import type { EventStore } from "../../eventStore.js";
import type { RunStateWriter } from "../../contracts/runStateWriter.js";
import type { ReviewMergeRunContext, RunStateClient } from "./context.js";
import type { DispatchedIntegration, MergeProbe } from "./mergeDispatchTypes.js";

/** The resolved speculative state of a run at merge time (see {@link resolveSpeculativeState}). */
export interface SpeculativeState {
  unmergedAncestors: string[];
  /**
   * §3.2/§3.3: the ordered ancestor stack (`runs.ancestor_stack`) — the jj-local base source
   * (a run is "speculative" iff this is non-empty). The retarget walks the PR base ONE step
   * down it on each ancestor merge + drops merged heads from `runs.ancestor_stack`.
   */
  ancestorStack: AncestorStack;
  /** The genuinely-merged ancestor spec ids — the set the stack-walk drops from the stack. */
  mergedSpecIds: ReadonlySet<string>;
}

/**
 * Spec ids that form the sole retarget membership vector: every member of the persisted
 * `ancestor_stack` (transitive truth), in stack order. Direct `depends_on` is intentionally
 * not a source — a depth-N chain may list only the immediate parent as a dep while the stack
 * still carries merged grandparents.
 */
export function ancestorStackMemberSpecIds(ancestorStack: AncestorStack): string[] {
  return ancestorStack.map((member) => member.specId);
}

/**
 * §2c/§2.3: the speculative state of a run at merge time. `undefined` for a NORMAL run (an
 * EMPTY `ancestor_stack`) — it merges against `default_branch` as always. For a SPECULATIVE
 * run, `ancestorStack` is the ordered stack the PR is stacked on and `unmergedAncestors` is
 * the (possibly empty) set of stack members not yet genuinely merged. The merge stage uses
 * this to:
 *   - HOLD the merge while `unmergedAncestors` is non-empty (no unreviewed ancestor code
 *     reaches `main` early — the dependent's WORK ran on the jj-assembled stack, but its
 *     MERGE waits), and
 *   - retarget the PR base ONE step down the stack as each ancestor merges (the stack walk),
 *     landing on `default_branch` once the stack empties.
 * A `done`/`merged` ancestor is satisfied; anything else is unmerged.
 *
 * Membership is the complete persisted member vector (gv-4), not direct `depends_on`.
 */
export async function resolveSpeculativeState(
  pool: RunStateClient,
  runId: string,
): Promise<SpeculativeState | undefined> {
  const runResult = await pool.query<{
    ancestor_stack: unknown;
    spec_id: string;
    project_id: string;
  }>("SELECT ancestor_stack, spec_id, project_id FROM runs WHERE run_id = $1", [runId]);
  const run = runResult.rows[0];
  if (run === undefined) {
    return undefined;
  }
  // §2.3: a run is "speculative" iff its `ancestor_stack` is non-empty. Resolve the ordered
  // stack so the retarget can walk ONE step down it on each ancestor merge.
  const ancestorStack = resolveAncestorStack({ ancestorStack: run.ancestor_stack });
  if (ancestorStack.length === 0) {
    return undefined;
  }
  // gv-4: sole base authority is the persisted ancestor member vector — never direct-only
  // `depends_on`. Empty stack is already handled above; a non-empty stack always has members.
  const ancestorSpecIds = ancestorStackMemberSpecIds(ancestorStack);
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
    [run.project_id, ancestorSpecIds],
  );
  const merged = new Set(mergedResult.rows.map((row) => row.spec_id));
  const unmergedAncestors = ancestorSpecIds.filter((id) => !merged.has(id));
  return { unmergedAncestors, ancestorStack, mergedSpecIds: merged };
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
async function retargetStackWalk(args: SpeculativeRetargetArgs & { defaultBranch: string }): Promise<void> {
  const { toBase, remainingStack } = resolveStackRetarget(
    args.speculative.ancestorStack,
    args.speculative.mergedSpecIds,
    args.defaultBranch,
  );
  // §5h: read the PR's live base off the freshness probe's `readBaseBranch` (the
  // `CodeHost`/projection-backed read), NOT the GitHub `mergeable_state` snapshot. The
  // retarget itself routes through the best-effort `VisibilityProjection` (a forge-UI mirror —
  // the land targets the real default branch regardless of this cosmetic PR base).
  const fromBase = await args.probe.readBaseBranch();
  if (fromBase !== toBase) {
    await args.probe.retargetBase(toBase);
    await args.eventStore.append({
      runId: args.context.runId,
      specId: args.context.specId,
      projectId: args.context.projectId,
      // The run's explicit tenant key (v68 fix) the eventStore.append stamps directly.
      orgId: args.context.orgId,
      taskId: args.taskId,
      eventType: "merge.retargeted",
      payload: {
        prUrl: args.context.prUrl,
        prNumber: args.prNumber,
        integration: args.integration,
        fromBase,
        toBase,
      },
    });
  }
  // Drop the merged heads from `runs.ancestor_stack`. Only when the stack actually shrank,
  // so a steady-state re-entry issues no write.
  //
  // PLANE-SPLIT: `runs` is a CONTROL-PLANE table the de-privileged data plane can no longer
  // write directly (migration 0035). So when a `RunStateWriter` + org are wired (remote-writes
  // on) this routes through `setRunSpeculativeBase`, whose SQL is BYTE-IDENTICAL
  // (`UPDATE runs SET ancestor_stack = $2::jsonb WHERE run_id = $1`); absent them (the
  // in-process dev path), it runs the same UPDATE on the pool directly.
  if (remainingStack.length !== args.speculative.ancestorStack.length) {
    // Audit D-R3.2: the writer is REQUIRED; on production paths the ambient
    // `runWithJobOrgId` provides the org, so the writer route always runs. The
    // pool-direct UPDATE is kept ONLY for the test/dev path with no ambient org
    // (the writer cannot resolve a scope without it) — byte-identical SQL.
    if (args.orgId !== undefined) {
      await args.runStateWriter.setRunSpeculativeBase({
        runId: args.context.runId,
        orgId: args.orgId,
        ancestorStack: remainingStack,
      });
      return;
    }
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
  /**
   * REQUIRED (audit D-R3.2 sweep): the `runs.ancestor_stack` head-drop routes through the
   * writer — the de-privileged data plane can't `UPDATE runs` directly. PR #714 made the
   * writer-undefined fallback unreachable in production.
   */
  runStateWriter: RunStateWriter;
  /** The run's org (the ambient per-job org), required to scope the remote `setRunSpeculativeBase`. */
  orgId?: string;
  context: ReviewMergeRunContext;
  taskId: string;
  integration: DispatchedIntegration;
  prNumber: number;
  probe: MergeProbe;
  speculative: SpeculativeState;
}

/**
 * §3.2/§3.3 jj-local: re-point a speculative dependent's PR base BEFORE any merge — the
 * STACKED-PR WALK. Walks the PR base ONE step down the `ancestor_stack` on each ancestor
 * merge (drops merged heads; held OR cleared), landing on `default_branch` once the stack
 * empties. A run with an empty stack is not speculative and never reaches here. The merge
 * HOLD itself stays in the caller and is UNCHANGED.
 */
export async function applySpeculativeRetarget(args: SpeculativeRetargetArgs): Promise<void> {
  if (args.speculative.ancestorStack.length > 0) {
    await retargetStackWalk({ ...args, defaultBranch: args.context.baseBranch });
  }
}
