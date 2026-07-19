// cspell:ignore hashtextextended
// rv-19 post-merge REVERT: the live-pointer rollback the plain `rollback()` cannot do
// (that one marks its target `rolled_back` — a terminal state `latestLive` ignores —
// leaving ZERO live rows). This restores the immediate PRIOR known-good release to the
// live production pointer when the current live release FAILS its post-merge re-proof.
import type pg from "pg";
import type { ReleaseInstanceRecord } from "../contracts/deployAdapter.js";
import { ReleaseInstanceNotFoundError, ReleaseInstancesStore } from "./releaseInstances.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

export interface RevertLiveToPriorInput {
  readonly orgId: string;
  readonly projectId: string;
  readonly brokenReleaseInstanceId: string;
}

/**
 * Demote the current live production release (the broken one) and restore its
 * `previous_release_instance_id` (the prior known-good release it superseded on
 * go-live) to the live pointer, inside the caller's `runWithOrgScope` transaction.
 * Serialized on the same `org:project:production` advisory-xact key `supersedeLockedLive`
 * uses, so a concurrent go-live can never leave two live rows. Fails LOUD — never a
 * silent broken-release-stays-live — when the target is not the current live production
 * release, has no prior, or the prior has no resolvable URL; the caller settles those as
 * needs-attention. After it commits, `latestLive` returns the PRIOR, not the broken row.
 */
export async function revertLiveToPrior(
  client: QueryClient,
  input: RevertLiveToPriorInput,
): Promise<{ prior: ReleaseInstanceRecord; broken: ReleaseInstanceRecord }> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `${input.orgId}:${input.projectId}:production`,
  ]);
  const broken = await ReleaseInstancesStore.getById(client, input.orgId, input.brokenReleaseInstanceId);
  if (broken === undefined) throw new ReleaseInstanceNotFoundError(input.brokenReleaseInstanceId);
  if (broken.projectId !== input.projectId || broken.environment !== "production" || broken.state !== "live") {
    throw new Error(
      `revertLiveToPrior requires ${input.brokenReleaseInstanceId} to be the current live production release`,
    );
  }
  const priorId = broken.previousReleaseInstanceId;
  if (priorId === null) {
    throw new Error(`release ${input.brokenReleaseInstanceId} has no prior known-good release to revert to`);
  }
  const priorExisting = await ReleaseInstancesStore.getById(client, input.orgId, priorId);
  if (priorExisting === undefined) throw new ReleaseInstanceNotFoundError(priorId);
  if (priorExisting.url.length === 0) {
    throw new Error(`prior release ${priorId} has no resolvable URL to restore to the live pointer`);
  }
  const demoted = await ReleaseInstancesStore.transition(client, {
    orgId: input.orgId,
    releaseInstanceId: input.brokenReleaseInstanceId,
    state: "superseded",
  });
  const prior = await ReleaseInstancesStore.transition(client, {
    orgId: input.orgId,
    releaseInstanceId: priorId,
    state: "live",
    environment: "production",
    url: priorExisting.url,
  });
  return { prior, broken: demoted };
}
