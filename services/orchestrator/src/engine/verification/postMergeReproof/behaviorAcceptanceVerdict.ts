// rv-16a — the persisted post-merge PRODUCTION behavior-verdict lane. AFTER a fix's deploy
// produces a LIVE production release, this runs the run's DECLARED behaviors' rv-11 executable
// acceptance (the rv-6 real HTTP driver against the live `release_instances.url`, the rv-11
// assertion algebra + fail-closed outcome resolution) and PERSISTS a real per-behavior
// `behavior_verdict` (purpose `post_merge_production`) into the 0079-hardened ledger, bound to
// the deploy-created `verification_environments` row (resolved via rv-env's
// {@link VerificationEnvironmentResolver} — NEVER a fabricated `integrationNodeId`).
//
// WHY (the gap it closes): before this, the post-merge production re-verification did NOT
// persist a real behavior verdict — rv-19's re-proof used the bh-10 SYMPTOM stage, and the
// proof-backed demo (rv-18) persisted only for the DEMO. So apex's "production symptom
// re-verified gone" was not yet a persisted PRODUCTION behavior verdict, and there was no
// persisted `passed`→`failed` regression signal. This lane records BOTH:
//   1. the real, coverage-gated production behavior verdict (append-only, immutable), and
//   2. — when a behavior that previously `passed` now records `failed_product` on the live
//      release — the `passed`→`failed` pair rv-16c's regression bisection reads.
//
// FALSE-GREEN CLOSED (inherits rv-6/rv-11 + the 0079 CHECK + the store's coverage guard):
//   • A behavior verdict is `passed` ONLY when every required assertion executed against a
//     REAL observation and passed (required >= 1). A 200-but-broken behavior records
//     `failed_product`, never a fabricated pass.
//   • An unobservable / unreachable surface records `inconclusive_*` — never a persisted pass.
//   • The env is the REAL deploy-created row (its FK) — a verdict is never attributed to a
//     fabricated environment id.
//
// It runs ALONGSIDE rv-19's promote/rollback (which still reads the bh-10 symptom verdict);
// it neither promotes nor rolls back. It runs while the release is still LIVE (BEFORE the
// rv-19 deploy decision), so even a re-proof that will roll back still records the honest
// production behavior verdict against the release that was live.

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { BehaviorVerdictOutcome } from "../../contracts/runtimeVerificationAdapters.js";
import type { ResolutionJob } from "../../contracts/resolutionStage.js";
import type { ReleaseInstanceRecord } from "../../contracts/deployAdapter.js";
import { ReleaseInstancesStore } from "../../repositories/releaseInstances.js";
import {
  PgVerificationEnvironmentResolver,
  type VerificationEnvironmentResolver,
} from "../../repositories/verificationEnvironments.js";
import {
  AcceptanceOrchestrator,
  actuateFlakeQuarantine,
  FLAKE_CLASSIFIER_ACTOR,
  HttpAcceptanceSurfaceDriver,
  PgAcceptancePlanLoader,
  PgAcceptanceRunStore,
  PgAcceptanceEventSink,
  PgReleaseInstanceBaseUrlResolver,
  type AcceptanceEventSink,
  type AcceptancePlanLoader,
  type AcceptanceRunRequest,
  type AcceptanceRunResult,
  type FlakeQuarantineActuatorStore,
} from "../acceptance/index.js";
import { PgBehaviorQuarantineStore } from "../../repositories/behaviorQuarantines.js";
import { EphemeralAcceptanceEventSink } from "../../demo/proofBackedWebDemo.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("post-merge-behavior-acceptance");

type QueryClient = Pick<pg.PoolClient, "query">;
type OrgScope = <T>(orgId: string, operation: (client: QueryClient) => Promise<T>) => Promise<T>;

/** The acceptance engine the lane drives — satisfied by the real {@link AcceptanceOrchestrator}. */
export interface AcceptanceExecutor {
  execute(request: AcceptanceRunRequest): Promise<AcceptanceRunResult>;
}

export interface PostMergeBehaviorAcceptanceVerifierDeps {
  readonly pool: pg.Pool;
  /** Compiles the release's `behavior_revisions.acceptance` specs into executable plans. */
  readonly planLoader: AcceptancePlanLoader;
  /** The rv-11 acceptance orchestrator (real rv-6 driver + persisting store). */
  readonly orchestrator: AcceptanceExecutor;
  /** Resolves the deploy-created `verification_environments` id for the live release (rv-env). */
  readonly resolveEnvironment: VerificationEnvironmentResolver;
  /** Emits the frozen `post_merge.behavior.{verified,failed}` events (org-scoped per append). */
  readonly events: AcceptanceEventSink;
  /**
   * rv-17 flake quarantine actuator store. After the production verdicts are recorded, the lane
   * classifies each behavior from its recorded `post_merge_production` verdicts (same artifact +
   * purpose) and, on a decisive flaky pass↔fail conflict, persists a `quarantine` transition — the
   * LIVE production writer for the quarantine table. Absent ⇒ classification is dormant (no rows).
   */
  readonly quarantineStore?: FlakeQuarantineActuatorStore;
  /** Test seam; production always runs on `runWithOrgScope` over the control pool. */
  readonly withOrgScope?: OrgScope;
}

export interface PostMergeBehaviorVerdict {
  readonly behaviorRevisionId: string;
  readonly verdictId: string;
  readonly outcome: BehaviorVerdictOutcome;
}

export type PostMergeBehaviorVerifyDecision = "recorded" | "noop" | "no_behaviors" | "already_recorded";

export interface PostMergeBehaviorVerifyResult {
  readonly decision: PostMergeBehaviorVerifyDecision;
  readonly runId?: string;
  readonly passed: number;
  readonly failed: number;
  readonly verdicts: readonly PostMergeBehaviorVerdict[];
  /**
   * mq-7 — the observed epoch: the artifact_digest these verdicts were recorded at. Present on a
   * `recorded` result; the downstream regression bisection uses it to EPOCH-SCOPE the quarantine
   * masking check (a stale-epoch quarantine never masks this new-epoch regression).
   */
  readonly artifactDigest?: string;
}

export interface VerifyPostMergeBehaviorInput {
  readonly orgId: string;
  readonly projectId: string;
  readonly releaseInstanceId: string;
}

/** A deploy-created live release the post-merge behavior verdict binds against, or a reason to skip. */
type ReleaseGate =
  | { readonly kind: "release"; readonly release: ReleaseInstanceRecord }
  | { readonly kind: "skip"; readonly decision: PostMergeBehaviorVerifyDecision };

const NON_PASS: PostMergeBehaviorVerifyResult = { decision: "noop", passed: 0, failed: 0, verdicts: [] };

/**
 * The persisted post-merge production behavior-verdict lane. `verify` drives the run's declared
 * behaviors' acceptance against the LIVE production release and records a real per-behavior
 * verdict + the frozen `post_merge.behavior.*` events. A no-op unless the bound release is a
 * real live production release; a fail-closed skip when it is already recorded or delivers no
 * behaviors.
 */
export class PostMergeBehaviorAcceptanceVerifier {
  private readonly withOrgScope: OrgScope;

  public constructor(private readonly deps: PostMergeBehaviorAcceptanceVerifierDeps) {
    this.withOrgScope = deps.withOrgScope ?? ((orgId, operation) => runWithOrgScope(deps.pool, orgId, operation));
  }

  public async verify(input: VerifyPostMergeBehaviorInput): Promise<PostMergeBehaviorVerifyResult> {
    const gate = await this.gateRelease(input);
    if (gate.kind === "skip") return { ...NON_PASS, decision: gate.decision };
    const release = gate.release;

    // Resolve the deploy-created verification environment for THIS live release (rv-env). The
    // acceptance run persists its verdict against a REAL env id — never the integration node id.
    const environmentId = await this.deps.resolveEnvironment.resolveForLiveRelease(release);
    const plans = await this.deps.planLoader.loadPlans({
      orgId: release.orgId,
      behaviorRevisionIds: release.behaviorRevisionIds,
    });
    const runResult = await this.deps.orchestrator.execute(this.buildRequest(release, environmentId, plans));

    const verdicts = runResult.behaviors.map((behavior) => ({
      behaviorRevisionId: behavior.behaviorRevisionId,
      verdictId: behavior.verdictId,
      outcome: behavior.outcome,
    }));
    await this.emitVerdictEvents(release, verdicts);
    // rv-17: LIVE flake classification + quarantine off the just-recorded production verdicts.
    await this.actuateFlakeQuarantines(release, runResult);

    const passed = verdicts.filter((verdict) => verdict.outcome === "passed").length;
    return {
      decision: "recorded",
      runId: runResult.runId,
      passed,
      failed: verdicts.length - passed,
      verdicts,
      // mq-7: the observed epoch these verdicts were recorded at, so downstream bisection can
      // epoch-scope the quarantine masking check (a stale-epoch quarantine never masks this).
      artifactDigest: release.artifactDigest,
    };
  }

  /**
   * Load the bound release under org scope and gate it: only a REAL live production release
   * with declared behaviors and no already-recorded production acceptance run proceeds.
   */
  private async gateRelease(input: VerifyPostMergeBehaviorInput): Promise<ReleaseGate> {
    return this.withOrgScope(input.orgId, async (client) => {
      const release = await ReleaseInstancesStore.getById(client, input.orgId, input.releaseInstanceId);
      if (
        release === undefined ||
        release.projectId !== input.projectId ||
        release.environment !== "production" ||
        release.state !== "live" ||
        release.url.length === 0
      ) {
        return { kind: "skip", decision: "noop" } as const;
      }
      if (release.behaviorRevisionIds.length === 0) {
        return { kind: "skip", decision: "no_behaviors" } as const;
      }
      if (await this.alreadyRecorded(client, release)) {
        return { kind: "skip", decision: "already_recorded" } as const;
      }
      return { kind: "release", release } as const;
    });
  }

  /**
   * Whether a COMPLETED post-merge production acceptance run already exists for this exact
   * deployment (its integration node + artifact digest). The append-only ledger means a
   * crash-replay of the settled resolution job (or a second settle path) must NOT re-drive a
   * duplicate persisted verdict for the same live release deployment.
   */
  private async alreadyRecorded(client: QueryClient, release: ReleaseInstanceRecord): Promise<boolean> {
    const result = await client.query<{ recorded: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM behavior_verification_runs
          WHERE org_id = $1 AND project_id = $2 AND integration_node_id = $3 AND artifact_digest = $4
            AND purpose = 'post_merge_production' AND status = 'completed'
       ) AS recorded`,
      [release.orgId, release.projectId, release.integrationNodeId, release.artifactDigest],
    );
    return result.rows[0]?.recorded ?? false;
  }

  private buildRequest(
    release: ReleaseInstanceRecord,
    environmentId: string,
    plans: AcceptanceRunRequest["plans"],
  ): AcceptanceRunRequest {
    return {
      orgId: release.orgId,
      projectId: release.projectId,
      // The release's integration node binds the rv-6 resolver to THIS release's live URL.
      integrationNodeId: release.integrationNodeId,
      // rv-env: the REAL deploy-created verification environment (not the integration node).
      environmentId,
      preparedHeadSha: release.sourceRef,
      jjTreeId: release.sourceRef,
      artifactDigest: release.artifactDigest,
      deploymentFingerprint: release.deploymentId,
      purpose: "post_merge_production",
      plans,
    };
  }

  /**
   * rv-17 / mq-7 — the LIVE flake-quarantine writer + epoch re-evaluator. For each behavior just
   * verified in production, classify from its recorded `post_merge_production` verdicts (same
   * artifact + purpose) and either open a quarantine on a decisive flaky conflict or RE-EVALUATE an
   * existing quarantine against this new epoch (release on a new-epoch regression / recovery).
   *
   * Best-effort + non-fatal by DESIGN: a failure here must never throw. Throwing would leave the
   * settled run recorded but re-drive `verify()` on retry, where `alreadyRecorded()` short-circuits
   * to `already_recorded` — which stops the regression bisection from ever running (a NEW masking
   * path). It is SAFE to swallow because the mq-7 anti-masking invariant no longer depends on this
   * write: the regression bisection masking check is EPOCH-SCOPED (`isQuarantinedInEpoch`), so a
   * new-epoch consistent_failure is NEVER masked by a stale quarantine even when this actuation
   * throws or is skipped and the `release` row is never written. But the failure is NOT silent
   * success: it is surfaced at ERROR so the (now-stale-until-next-observation) quarantine ledger is
   * visible for repair, rather than buried as an expected "diagnostic only" event.
   */
  private async actuateFlakeQuarantines(release: ReleaseInstanceRecord, runResult: AcceptanceRunResult): Promise<void> {
    const store = this.deps.quarantineStore;
    if (store === undefined) return;
    for (const behavior of runResult.behaviors) {
      try {
        await actuateFlakeQuarantine(store, {
          orgId: release.orgId,
          projectId: release.projectId,
          behaviorRevisionId: behavior.behaviorRevisionId,
          artifactDigest: release.artifactDigest,
          purpose: "post_merge_production",
          contextHash: runResult.runtimeBehaviorContextHash,
          actor: FLAKE_CLASSIFIER_ACTOR,
        });
      } catch (error) {
        log.error(
          "rv-17/mq-7 flake quarantine actuation FAILED — the epoch re-evaluation/release write did " +
            "not persist. Anti-masking is UPHELD by epoch-scoped bisection consumption " +
            "(isQuarantinedInEpoch), NOT by this write, so a new-epoch regression is NOT masked; the " +
            "quarantine ledger may be stale for this behavior until the next successful actuation.",
          { behaviorRevisionId: behavior.behaviorRevisionId, artifactDigest: release.artifactDigest },
          error,
        );
      }
    }
  }

  /** Emit the frozen `post_merge.behavior.verified` / `.failed` event for each persisted verdict. */
  private async emitVerdictEvents(
    release: ReleaseInstanceRecord,
    verdicts: readonly PostMergeBehaviorVerdict[],
  ): Promise<void> {
    for (const verdict of verdicts) {
      if (verdict.outcome === "passed") {
        await this.deps.events.append({
          orgId: release.orgId,
          projectId: release.projectId,
          eventType: "post_merge.behavior.verified",
          payload: {
            behaviorRevisionId: verdict.behaviorRevisionId,
            verdictId: verdict.verdictId,
            deploySha: release.sourceRef,
            artifactDigest: release.artifactDigest,
          },
        });
        continue;
      }
      await this.deps.events.append({
        orgId: release.orgId,
        projectId: release.projectId,
        eventType: "post_merge.behavior.failed",
        payload: {
          behaviorRevisionId: verdict.behaviorRevisionId,
          verdictId: verdict.verdictId,
          deploySha: release.sourceRef,
          outcome: verdict.outcome,
        },
      });
    }
  }
}

/**
 * The live post-merge settlement seam. A no-op unless the settled resolution job is a
 * `production` stage carrying a release binding — every OTHER stage settles exactly as before.
 * Called from the resolution walker (and the operator-retry route) AFTER the production stage
 * has durably written its evidence and BEFORE the rv-19 deploy decision, so the acceptance run
 * binds the still-live release and its verdict is persisted regardless of promote/rollback.
 */
export async function recordPostMergeBehaviorVerdict(
  verifier: Pick<PostMergeBehaviorAcceptanceVerifier, "verify"> | undefined,
  job: Pick<ResolutionJob, "orgId" | "projectId" | "stage" | "releaseInstanceId">,
): Promise<PostMergeBehaviorVerifyResult | undefined> {
  if (job.stage !== "production" || verifier === undefined || job.releaseInstanceId === undefined) return undefined;
  return verifier.verify({ orgId: job.orgId, projectId: job.projectId, releaseInstanceId: job.releaseInstanceId });
}

/**
 * Build the production post-merge behavior-acceptance verifier: the real rv-11
 * {@link AcceptanceOrchestrator} driving the rv-6 {@link HttpAcceptanceSurfaceDriver} over the
 * live `release_instances.url`, compiling plans from `behavior_revisions.acceptance`, PERSISTING
 * verdicts through {@link PgAcceptanceRunStore} bound to the deploy-created env, and emitting the
 * frozen `post_merge.behavior.*` events through {@link PgAcceptanceEventSink}. The orchestrator's
 * own pre-merge `behavior.verification.*` events stay swallowed (this lane owns the frozen
 * post-merge vocabulary), mirroring the proof-backed demo composition.
 */
export function buildPostMergeBehaviorAcceptanceVerifier(pool: pg.Pool): PostMergeBehaviorAcceptanceVerifier {
  const orchestrator = new AcceptanceOrchestrator({
    store: new PgAcceptanceRunStore(pool),
    events: new EphemeralAcceptanceEventSink(),
    drivers: [new HttpAcceptanceSurfaceDriver({ resolveBaseUrl: new PgReleaseInstanceBaseUrlResolver(pool) })],
  });
  return new PostMergeBehaviorAcceptanceVerifier({
    pool,
    planLoader: new PgAcceptancePlanLoader(pool),
    orchestrator,
    resolveEnvironment: new PgVerificationEnvironmentResolver(pool),
    events: new PgAcceptanceEventSink(pool),
    // rv-17: the LIVE flake-quarantine writer — classifies + quarantines off recorded verdicts.
    quarantineStore: new PgBehaviorQuarantineStore(pool),
  });
}
