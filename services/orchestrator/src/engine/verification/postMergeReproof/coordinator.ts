// cspell:ignore hashtextextended
// rv-19 — post-merge production re-proof + rollback hook. AFTER a fix merges and
// deploy-on-merge lands a NEW live production release, the resolution production
// stage (bh-10 `ProductionSymptomStage`) RE-PROVES the previously-failing symptom
// against the REAL new-release URL and writes an immutable `behavior_verification_runs`
// classification. This coordinator is the deploy-side settlement of that re-proof:
//
//   • product_resolved (symptom gone in production)  → PROMOTE the proven release
//     (frozen `deployment.promoted`); the release stays the live production pointer.
//   • product_failure  (symptom STILL present)       → ROLL BACK: revert the live
//     `release_instances` pointer to the prior known-good release (`revertLiveToPrior`)
//     and record it (frozen `deployment.rolled_back`). Never silently leaves the
//     broken release live.
//   • inconclusive / infra_failure                   → HOLD: neither promote nor roll
//     back (an inconclusive re-proof is not proof the fix failed — the resolution job
//     stays retryable). Fail-closed: an unproven release is never green-promoted.
//
// The re-proof itself is bh-10's real HTTP probe against the real live URL — this
// module owns only the promote/rollback decision + effects, so it can NEVER declare a
// "promoted" without a real `product_resolved` production verdict from the stage.
// IDEMPOTENT: a re-run after a crash re-decides at most once (a prior terminal
// `deployment.promoted`/`deployment.rolled_back` for the release short-circuits).

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { ProductionResolutionStageResult, ResolutionJob } from "../../contracts/resolutionStage.js";
import { PgEventStore, type EventStore } from "../../eventStore.js";
import { ReleaseInstancesStore } from "../../repositories/releaseInstances.js";
import { revertLiveToPrior } from "../../repositories/releaseInstanceRevert.js";

type QueryClient = Pick<pg.PoolClient, "query">;
type OrgScope = <T>(orgId: string, operation: (client: QueryClient) => Promise<T>) => Promise<T>;

/**
 * The deploy-side settlement a production re-proof lands on:
 *   - promoted / rolled_back  — a live release was promoted or the live pointer reverted.
 *   - needs_attention         — a product_failure on a live release with NO prior known-good
 *     release to revert to (e.g. a first deploy): fail-closed + loud, the broken release stays
 *     live only because nothing better exists, the loop is flagged (never silently resolved),
 *     and the job COMPLETES (never a throw→retry-loop).
 *   - held                    — an inconclusive re-proof (not proof the fix failed).
 *   - noop                    — no live deployed release to act on (pre-deploy / cosmetic /
 *     pure authority-ledger retry), or the decision was already applied (idempotent).
 */
export type ReproofDeployDecision = "promoted" | "rolled_back" | "needs_attention" | "held" | "noop";

export class PostMergeReproofBindingError extends Error {
  public override readonly name = "PostMergeReproofBindingError";
}

export interface PostMergeReproofCoordinatorDeps {
  readonly pool: pg.Pool;
  /** Test seam; production always runs on `runWithOrgScope` over the control pool. */
  readonly withOrgScope?: OrgScope;
  readonly eventsForClient?: (client: QueryClient) => EventStore;
}

export interface SettleReproofInput {
  readonly orgId: string;
  readonly projectId: string;
  /** The live production release the re-proof ran against (the resolution job's binding). */
  readonly releaseInstanceId: string;
  readonly result: ProductionResolutionStageResult;
}

/**
 * The deploy-side outcome of a post-merge production re-proof: promote the proven
 * release, or roll the live pointer back to the prior known-good release.
 */
export class PostMergeReproofCoordinator {
  private readonly withOrgScope: OrgScope;
  private readonly eventsForClient: (client: QueryClient) => EventStore;

  public constructor(private readonly deps: PostMergeReproofCoordinatorDeps) {
    this.withOrgScope = deps.withOrgScope ?? ((orgId, operation) => runWithOrgScope(deps.pool, orgId, operation));
    this.eventsForClient = deps.eventsForClient ?? ((client) => new PgEventStore(client));
  }

  public async settle(input: SettleReproofInput): Promise<ReproofDeployDecision> {
    return this.withOrgScope(input.orgId, async (client) => {
      // Serialize the WHOLE decide+act (alreadyDecided → promote/rollback) on the same
      // `org:project:production` advisory-xact lock `revertLiveToPrior` uses, so concurrent
      // settles for the same project can never each emit a `deployment.promoted` (or race a
      // double rollback): the loser blocks until the winner commits, then reads its event.
      await this.lockProduction(client, input.orgId, input.projectId);
      const release = await ReleaseInstancesStore.getById(client, input.orgId, input.releaseInstanceId);
      // Promote/rollback applies ONLY to a real LIVE production release. A missing binding,
      // a wrong-project binding, or a non-live (pre-deploy / superseded / torn-down) release
      // means there is nothing deployed to promote or roll back — settle EXACTLY as before
      // (a cosmetic / pre-deploy / pure authority-ledger retry is untouched here).
      if (
        release === undefined ||
        release.projectId !== input.projectId ||
        release.environment !== "production" ||
        release.state !== "live"
      ) {
        return "noop";
      }
      // Idempotency: a prior terminal deploy decision for THIS release short-circuits.
      if (await this.alreadyDecided(client, input.orgId, input.projectId, release.deploymentId)) {
        return "noop";
      }
      const events = this.eventsForClient(client);
      switch (input.result.outcome) {
        case "passed":
          return this.promote(events, input, release.deploymentId, release.artifactDigest, release.sourceRef);
        case "failed":
          return this.rollback(
            client,
            events,
            input,
            release.deploymentId,
            release.artifactDigest,
            release.previousReleaseInstanceId,
          );
        case "inconclusive":
          // Fail-closed: an inconclusive/infra re-proof is not proof the fix failed —
          // never a green promote AND never a destructive rollback. The resolution job
          // stays retryable (settlement handles that); we take no deploy action.
          return "held";
      }
      throw new PostMergeReproofBindingError(
        `unsupported production re-proof outcome: ${String((input.result as { outcome: unknown }).outcome)}`,
      );
    });
  }

  private async promote(
    events: EventStore,
    input: SettleReproofInput,
    deploymentId: string,
    artifactDigest: string,
    deploySha: string,
  ): Promise<ReproofDeployDecision> {
    // The release stays the live production pointer; `deployment.promoted` records the
    // proof-backed promotion (a real `product_resolved` production verdict from bh-10).
    await events.append({
      orgId: input.orgId,
      projectId: input.projectId,
      eventType: "deployment.promoted",
      payload: { deploymentId, artifactDigest, deploySha, environment: "production" },
    });
    return "promoted";
  }

  private async rollback(
    client: QueryClient,
    events: EventStore,
    input: SettleReproofInput,
    deploymentId: string,
    artifactDigest: string,
    previousReleaseInstanceId: string | null,
  ): Promise<ReproofDeployDecision> {
    // No prior known-good release to revert to (a first deploy): we CANNOT roll the live
    // pointer back. Fail-closed + LOUD but do NOT throw — a throw releases the lease
    // retryable and retry-loops forever — and do NOT emit a spurious deployment.rolled_back.
    // The broken release stays live only because nothing better exists; the loop is flagged
    // needs_attention (the ResolutionAuthority's blocked decision + repair routing stand),
    // never silently "resolved", and the job COMPLETES.
    if (previousReleaseInstanceId === null) {
      return "needs_attention";
    }
    // Revert the live pointer to the prior known-good release BEFORE recording the
    // rollback, so a crash between the two re-drives through the idempotency gate
    // (the release is no longer live → `revertLiveToPrior` fails loud → retryable).
    await revertLiveToPrior(client, {
      orgId: input.orgId,
      projectId: input.projectId,
      brokenReleaseInstanceId: input.releaseInstanceId,
    });
    await events.append({
      orgId: input.orgId,
      projectId: input.projectId,
      eventType: "deployment.rolled_back",
      payload: {
        deploymentId,
        artifactDigest,
        reason: "post-merge production re-proof failed: symptom still present (product_failure)",
      },
    });
    return "rolled_back";
  }

  /**
   * Whether this release's re-proof deploy outcome was ALREADY applied (a prior terminal
   * `deployment.promoted`/`deployment.rolled_back`). Read under the release's org scope so
   * a crash-replay of the settled resolution job can short-circuit BEFORE the production
   * stage re-runs its live-binding against a release this coordinator already demoted.
   */
  public async alreadyApplied(input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly releaseInstanceId: string;
  }): Promise<boolean> {
    return this.withOrgScope(input.orgId, async (client) => {
      const release = await ReleaseInstancesStore.getById(client, input.orgId, input.releaseInstanceId);
      if (release === undefined || release.projectId !== input.projectId) return false;
      return this.alreadyDecided(client, input.orgId, input.projectId, release.deploymentId);
    });
  }

  private async lockProduction(client: QueryClient, orgId: string, projectId: string): Promise<void> {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${orgId}:${projectId}:production`]);
  }

  private async alreadyDecided(
    client: QueryClient,
    orgId: string,
    projectId: string,
    deploymentId: string,
  ): Promise<boolean> {
    const decided = await client.query<{ decided: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM events e
          WHERE e.org_id = $1 AND e.project_id = $2
            AND e.event_type IN ('deployment.promoted', 'deployment.rolled_back')
            AND e.payload ->> 'deploymentId' = $3
       ) AS decided`,
      [orgId, projectId, deploymentId],
    );
    return decided.rows[0]?.decided ?? false;
  }
}

/**
 * The live production re-proof settlement seam. A no-op unless the settled resolution
 * job is a `production` stage carrying a release binding — every OTHER stage settles
 * exactly as before. Called from the resolution walker AFTER the production stage has
 * durably written its evidence, so the coordinator only ever acts on a real verdict.
 */
export async function applyReproofDeployOutcome(
  coordinator: Pick<PostMergeReproofCoordinator, "settle"> | undefined,
  job: Pick<ResolutionJob, "orgId" | "projectId" | "stage" | "releaseInstanceId">,
  result: ProductionResolutionStageResult | { outcome: string; classification: string },
): Promise<ReproofDeployDecision | undefined> {
  if (job.stage !== "production") return undefined;
  if (coordinator === undefined) return undefined;
  // No release binding ⇒ a pre-deploy / pure authority-ledger production job with nothing
  // deployed to promote or roll back. A NO-OP (never a throw — that would retry-loop a job
  // whose authority decision already settled correctly).
  if (job.releaseInstanceId === undefined) return "noop";
  return coordinator.settle({
    orgId: job.orgId,
    projectId: job.projectId,
    releaseInstanceId: job.releaseInstanceId,
    result: result as ProductionResolutionStageResult,
  });
}

/**
 * Idempotent crash-replay guard for the LIVE settlement paths (walker + retry route). A
 * production job whose deploy re-proof was ALREADY applied (promoted/rolled_back) must NOT
 * re-run the production stage: after a rollback the bound release is demoted, so bh-10's
 * `requireLiveBinding` would throw and the recovered lease would loop forever. Returns true
 * so the caller settles the job as completed exactly once instead of re-running the stage.
 */
export async function reproofAlreadySettled(
  coordinator: Pick<PostMergeReproofCoordinator, "alreadyApplied"> | undefined,
  job: Pick<ResolutionJob, "orgId" | "projectId" | "stage" | "releaseInstanceId">,
): Promise<boolean> {
  if (job.stage !== "production" || coordinator === undefined || job.releaseInstanceId === undefined) return false;
  return coordinator.alreadyApplied({
    orgId: job.orgId,
    projectId: job.projectId,
    releaseInstanceId: job.releaseInstanceId,
  });
}
