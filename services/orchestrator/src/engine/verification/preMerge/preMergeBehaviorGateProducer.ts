// rv-premerge — the PRODUCER of `purpose='pre_merge'` behavior verdicts.
//
// THE GAP THIS CLOSES: the land-time behavior gate (`merge/behaviorLandGate.ts`,
// `resolveLandTimeBehaviorGate`) reads a run's `pre_merge` behavior verdicts and blocks
// the land on a failing/inconclusive one — but NOTHING produced those verdicts, so it
// always resolved `not_applicable`. This producer feeds it: at the merge-authority stage
// it deploys the PR head to an EPHEMERAL preview, drives the rv-11 executable-acceptance
// orchestrator (real rv-6 HTTP driver) against the preview URL for the run's declared
// behaviors, records a PERSISTING `pre_merge` run + BLOCKING verdicts, and tears the
// preview down. The recorded verdicts are what `resolveLandTimeBehaviorGate` blocks on.
//
// OPT-IN, DEFAULT OFF: this adds a real preview deploy per gate (cost + time). It runs
// ONLY when the project opted into `preMergeBehaviorGate` AND the run wired a producer;
// otherwise the merge stage does NO preview deploy (a genuine zero-cost no-op). apex's
// back-half is already covered by the POST-merge re-proof (rv-19), so this is an
// ADDITIONAL safety layer, not the critical path.
//
// FAIL-CLOSED (anti-cosplay): the acceptance run is the REAL rv-11 orchestrator against a
// REAL preview URL — never a fabricated verdict. A decisive product failure BLOCKS; an
// inconclusive/failed/absent verification BLOCKS (inconclusive ≠ passed). A preview deploy
// that FAILS blocks (never a silent pass). A NON-WEB product (the deploy adapter has no
// preview surface) resolves `not_applicable` — the merge decides on CI alone, never fails.
// The preview is torn down even on failure (no leaked previews — the apex-v96 lesson).

import type { Digest } from "../../contracts/cas.js";
import type { BehaviorVerdictOutcome } from "../../contracts/runtimeVerificationAdapters.js";
import type {
  AcceptancePlan,
  AcceptancePlanLoader,
  AcceptanceRunRequest,
  AcceptanceRunResult,
} from "../acceptance/index.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("pre-merge-behavior-gate");

/** The run-scoped inputs the producer gates one merge candidate's PR head with. */
export interface PreMergeBehaviorGateInput {
  readonly orgId: string;
  readonly projectId: string;
  /** The MERGE run id — `behavior_verification_runs.run_id`, the key the land gate reads. */
  readonly runId: string;
  readonly specId: string;
  readonly repoUrl: string;
  /** The PUSHED PR head the land authority binds to (`pushSource.headSha`). */
  readonly headSha: string;
  /** The run's declared behavior revisions (`context.behaviorIds`) — the affected set. */
  readonly behaviorRevisionIds: readonly string[];
}

/** The gate's decision over the pre-merge behavior verification. */
export type PreMergeBehaviorGateOutcome =
  // No preview surface (non-web product) OR no declared/compilable behaviors ⇒ the merge
  // decides on CI alone; NEVER blocks (there is nothing to prove against a preview here).
  | { readonly kind: "not_applicable"; readonly reason: string }
  // Every blocking behavior passed on the preview ⇒ proceed to merge.
  | { readonly kind: "passed"; readonly runId: string; readonly passedBlockingCount: number }
  // A blocking behavior FAILED, was inconclusive, or the verification could not complete
  // (deploy/run failure) ⇒ FAIL-CLOSED: the merge is blocked. `recordedRunId` present ⇒ a
  // `pre_merge` run was persisted (so `resolveLandTimeBehaviorGate` ALSO blocks at land
  // time); absent ⇒ the preview never came up, so the caller MUST block on this outcome.
  | { readonly kind: "blocked"; readonly reason: string; readonly recordedRunId?: string };

/** A live ephemeral preview the acceptance run drives, plus its persistence bindings. */
export interface PreviewSurface {
  readonly deploymentId: string;
  readonly url: string;
  readonly integrationNodeId: string;
  readonly artifactDigest: Digest;
  /** The `verification_environments` (deployment_target='preview') row id the run FKs. */
  readonly environmentId: string;
}

/** Provisioning a preview surface for the PR head, or why one is unavailable/failed. */
export type PreviewProvisionResult =
  // A web preview came up; run acceptance against it.
  | { readonly kind: "provisioned"; readonly surface: PreviewSurface }
  // No preview surface exists for this product (a non-web adapter throws on applyPreview) —
  // the producer resolves `not_applicable` (merge on CI alone).
  | { readonly kind: "no_surface"; readonly reason: string }
  // The preview deploy was EXPECTED but FAILED — fail-closed (the caller blocks the merge).
  | { readonly kind: "failed"; readonly reason: string };

/**
 * Provisions + tears down an ephemeral preview for the PR head. The production impl wraps
 * the real `DeployAdapter.applyPreview`/`teardownPreview` + the preview
 * `verification_environments` creation; a test impl scripts each result.
 */
export interface PreviewSurfaceProvisioner {
  provision(input: PreMergeBehaviorGateInput): Promise<PreviewProvisionResult>;
  /** Tear the preview down — invoked in a `finally`; the producer swallows a teardown throw. */
  teardown(surface: PreviewSurface): Promise<void>;
}

/** The rv-11 orchestrator, bound (by the factory) to a specific preview URL for this run. */
export interface AcceptanceExecutor {
  execute(request: AcceptanceRunRequest): Promise<AcceptanceRunResult>;
}

/** Builds the PERSISTING rv-11 orchestrator (real rv-6 driver) bound to a preview URL. */
export type AcceptanceExecutorFactory = (baseUrl: string) => AcceptanceExecutor;

export interface PreMergeBehaviorGateProducer {
  produce(input: PreMergeBehaviorGateInput): Promise<PreMergeBehaviorGateOutcome>;
}

export interface PreviewBehaviorGateProducerDeps {
  readonly provisioner: PreviewSurfaceProvisioner;
  readonly planLoader: AcceptancePlanLoader;
  readonly buildExecutor: AcceptanceExecutorFactory;
}

const DECISIVE_FAILURES: ReadonlySet<BehaviorVerdictOutcome> = new Set<BehaviorVerdictOutcome>([
  "failed_product",
  "failed_visual",
  "failed_verification_contract",
]);
const INCONCLUSIVE_OUTCOMES: ReadonlySet<BehaviorVerdictOutcome> = new Set<BehaviorVerdictOutcome>([
  "inconclusive_infrastructure",
  "inconclusive_external",
  "cancelled_superseded",
]);

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The real producer: preview-deploy the PR head → run rv-11 acceptance against it →
 * record a `pre_merge` run + BLOCKING verdicts → tear the preview down. Judges the run
 * outcome fail-closed, mirroring `resolveLandTimeBehaviorGate` so the immediate gate
 * decision and the land-time gate agree (defense in depth).
 */
export class PreviewBehaviorGateProducer implements PreMergeBehaviorGateProducer {
  public constructor(private readonly deps: PreviewBehaviorGateProducerDeps) {}

  public async produce(input: PreMergeBehaviorGateInput): Promise<PreMergeBehaviorGateOutcome> {
    if (input.behaviorRevisionIds.length === 0) {
      return { kind: "not_applicable", reason: "run declares no behaviors to verify pre-merge" };
    }
    // Compile the plans FIRST — a malformed/missing acceptance spec is fail-closed WITHOUT
    // paying the preview-deploy cost. A behavior that cannot be compiled cannot be proven.
    let plans: readonly AcceptancePlan[];
    try {
      plans = await this.deps.planLoader.loadPlans({
        orgId: input.orgId,
        behaviorRevisionIds: input.behaviorRevisionIds,
      });
    } catch (error) {
      return { kind: "blocked", reason: `pre-merge acceptance plan load failed: ${messageOf(error)}` };
    }
    if (plans.length === 0) {
      return { kind: "not_applicable", reason: "no compiled acceptance plans for the run's behaviors" };
    }

    const provisioned = await this.deps.provisioner.provision(input);
    if (provisioned.kind === "no_surface") {
      // A non-web product has no preview surface — merge on CI alone, never fail.
      return { kind: "not_applicable", reason: provisioned.reason };
    }
    if (provisioned.kind === "failed") {
      // The preview deploy was expected but failed — inconclusive, fail-closed. No run row
      // exists, so the CALLER must block on this outcome (there is nothing at land time yet).
      return { kind: "blocked", reason: `pre-merge preview deploy failed: ${provisioned.reason}` };
    }

    const { surface } = provisioned;
    try {
      return await this.runAcceptance(input, surface, plans);
    } catch (error) {
      // The rv-11 run itself threw (persistence / driver construction) — fail-closed.
      log.warn("pre-merge behavior verification threw (fail-closed; merge blocked)", {
        runId: input.runId,
        reason: messageOf(error),
      });
      return { kind: "blocked", reason: `pre-merge behavior verification error: ${messageOf(error)}` };
    } finally {
      // Tear the preview down EVEN on failure — no leaked preview deployments.
      await this.tearDown(surface);
    }
  }

  private async runAcceptance(
    input: PreMergeBehaviorGateInput,
    surface: PreviewSurface,
    plans: readonly AcceptancePlan[],
  ): Promise<PreMergeBehaviorGateOutcome> {
    const executor = this.deps.buildExecutor(surface.url);
    const result = await executor.execute({
      orgId: input.orgId,
      projectId: input.projectId,
      integrationNodeId: surface.integrationNodeId,
      environmentId: surface.environmentId,
      preparedHeadSha: input.headSha,
      jjTreeId: input.headSha,
      artifactDigest: surface.artifactDigest,
      deploymentFingerprint: surface.deploymentId,
      purpose: "pre_merge",
      specId: input.specId,
      // Binds `behavior_verification_runs.run_id` to the MERGE run — the key
      // `resolveLandTimeBehaviorGate` reads at land time.
      externalRunId: input.runId,
      plans,
    });

    // The orchestrator recorded a completed `pre_merge` run + one BLOCKING verdict per plan.
    // Judge fail-closed, MIRRORING `resolveLandTimeBehaviorGate` so both gates agree.
    const failure = result.behaviors.find((behavior) => DECISIVE_FAILURES.has(behavior.outcome));
    if (failure !== undefined) {
      return {
        kind: "blocked",
        reason: `behavior '${failure.behaviorRevisionId}' failed on the preview (${failure.outcome})`,
        recordedRunId: result.runId,
      };
    }
    const inconclusive = result.behaviors.find((behavior) => INCONCLUSIVE_OUTCOMES.has(behavior.outcome));
    if (inconclusive !== undefined) {
      return {
        kind: "blocked",
        reason: `behavior '${inconclusive.behaviorRevisionId}' was inconclusive on the preview (${inconclusive.outcome})`,
        recordedRunId: result.runId,
      };
    }
    const passedBlockingCount = result.behaviors.filter((behavior) => behavior.outcome === "passed").length;
    if (passedBlockingCount === 0) {
      // A completed run with no passing blocking behavior is NOT green — fail-closed.
      return {
        kind: "blocked",
        reason: "pre-merge behavior verification produced no passing blocking behavior verdict",
        recordedRunId: result.runId,
      };
    }
    return { kind: "passed", runId: result.runId, passedBlockingCount };
  }

  private async tearDown(surface: PreviewSurface): Promise<void> {
    try {
      await this.deps.provisioner.teardown(surface);
    } catch (error) {
      log.warn("pre-merge preview teardown failed (best-effort; no run failure)", {
        deploymentId: surface.deploymentId,
        reason: messageOf(error),
      });
    }
  }
}
