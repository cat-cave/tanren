// cspell:ignore rederive
// MQ-5 production handoff from an authorized exact batch to one group CAS.

import type pg from "pg";
import type { BatchAuthorityBinding } from "../contracts/batchMergeCoordinator.js";
import type { MergeQueueEntry } from "../contracts/mergeCoordinator.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import { LandCasRejectedError } from "../providers/githubCodeHost.js";
import { PgLandGroupStore } from "./landGroupStore.js";
import { buildPgExactBatchAuthority } from "./multiMemberAuthorityPgAuthority.js";
import { buildMultiMemberCodeHost, type MultiMemberAuthorityHostDeps } from "./multiMemberAuthorityPgHost.js";
import { gatherMultiMemberAuthorityState, loadMultiMemberLandContext } from "./multiMemberAuthorityPgState.js";
import { loadMultiMemberLandGroupContexts } from "./multiMemberLandGroupContextPg.js";
import type { AuthorizedSubsetEvaluation, LandGroupLandOutcome } from "./multiMemberAuthorityTypes.js";

export interface PgLandGroupAuthorityDeps extends MultiMemberAuthorityHostDeps {
  readonly pool: pg.Pool;
  readonly runStateWriter: RunStateWriter;
}

/**
 * Form and land the exact authorization through MergeAuthorityV2. A CAS rejection
 * leaves the group formed and asks the event-driven coordinator to re-derive a
 * fresh integration node on the next pass; that is progress-based, never capped.
 */
export async function landAuthorizedGroupPg(
  deps: PgLandGroupAuthorityDeps,
  input: {
    readonly projectId: string;
    readonly entries: ReadonlyArray<MergeQueueEntry>;
    readonly binding: BatchAuthorityBinding;
    readonly evaluation: AuthorizedSubsetEvaluation;
    readonly confirmBeforeLand: () => Promise<boolean>;
  },
): Promise<LandGroupLandOutcome> {
  const gathered = await gatherMultiMemberAuthorityState(deps.pool, input);
  const { host, repo } = await buildMultiMemberCodeHost(deps, gathered.project, gathered.orgId);
  const [context, members] = await Promise.all([
    loadMultiMemberLandContext(deps.pool, gathered.orgId, input, gathered.policyVersion),
    loadMultiMemberLandGroupContexts({
      pool: deps.pool,
      orgId: gathered.orgId,
      projectId: input.projectId,
      entries: input.entries,
      binding: input.binding,
    }),
  ]);
  const landStore = new PgLandGroupStore({
    pool: deps.pool,
    orgId: gathered.orgId,
    projectId: input.projectId,
    groupId: input.evaluation.groupId,
    partitionId: input.entries[0]?.partitionId ?? input.evaluation.groupId,
    policyVersion: gathered.policyVersion,
    members,
  });
  const authority = buildPgExactBatchAuthority({
    pool: deps.pool,
    orgId: gathered.orgId,
    binding: input.binding,
    envelope: input.evaluation.authorization.envelope,
    host,
    repo,
    intoMain: gathered.project.default_branch,
    context,
    runStateWriter: deps.runStateWriter,
    landStore,
  });
  // The group policy fence is deliberately after all PG context/setup and before
  // the one irreversible host CAS. A post-proof freeze/blackout therefore leaves
  // the claimed queue rows held and never reaches `authority.land()`.
  if (!(await input.confirmBeforeLand())) return { kind: "policy_held" };
  try {
    const landed = await authority.land(input.evaluation.authorization);
    if (landed.kind === "landed") return { kind: "landed", mainSha: landed.mainSha };
    // The binding changed after evaluation. It must be materialized and proven again;
    // never reinterpret this pre-CAS failure as a completed/ambiguous host land.
    if (landed.kind === "revalidation_failed") return { kind: "rederive" };
    return { kind: "reconcile_pending" };
  } catch (error) {
    if (error instanceof LandCasRejectedError) return { kind: "rederive" };
    throw error;
  }
}
