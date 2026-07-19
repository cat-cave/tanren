// rv-18 A2 — the PROOF-BACKED web demo (no more `/`-probe). For a deployed WEB product,
// this DRIVES the rv-11 executable-acceptance orchestrator (the rv-6 HTTP driver making
// REAL requests against the run's REAL `release_instances.url`, the rv-11 assertion
// algebra + fail-closed outcome resolution) to EXECUTE the product's declared behaviors,
// then derives the demo verdict from the REAL per-behavior acceptance outcome — NOT from
// a 200 on `/`. The whole point: a product whose `/` returns 200 but whose declared
// behavior FAILS its acceptance assertion produces a FAILED demo (`failed_product`), and a
// genuinely-working product (behaviors pass) produces a passing demo.
//
// FALSE-GREEN CLOSED (inherits rv-6/rv-11):
//   • A behavior is demo-`passed` ONLY when its acceptance outcome is exactly `passed`
//     (every required assertion executed against a REAL observation and passed). No
//     partial credit, no reachability shortcut.
//   • `failed_product` / `failed_verification_contract` / `failed_visual` → demo-`failed`.
//   • `inconclusive_*` (the surface was unreachable / a subject was unobservable) is NEVER
//     a fabricated pass. When EVERY behavior went inconclusive (the product could not be
//     exercised at all) the demo fails LOUD as unobservable so the operator triages an
//     infra halt, distinct from a real product-behavior failure.
//
// LEDGER + EVIDENCE: the acceptance run drives REAL observations, and (rv-env) now that the
// deploy path provisions a `verification_environments` row for the live release, the run
// PERSISTS its real per-behavior verdict into the 0079-hardened `behavior_verdicts` ledger
// through the {@link PgAcceptanceRunStore} bound to that deploy-created environment (resolved
// via {@link VerificationEnvironmentResolver} — never a fabricated `integrationNodeId`). It
// ALSO records the operator-facing append-only, org-scoped `demo.evidence.recorded` +
// `demo.completed` events (the acceptance orchestrator's own `behavior.verification.*`
// vocabulary stays swallowed so the pre-merge-gate timeline is uncontaminated). Every
// recorded field is NON-SECRET — a behavior id, an outcome, and an assertion tally.

import { randomUUID } from "node:crypto";
import { runWithJobOrgId } from "@tanren/db";
import type pg from "pg";
import type { ReleaseInstanceRecord } from "../contracts/deployAdapter.js";
import type { BehaviorVerdictOutcome } from "../contracts/runtimeVerificationAdapters.js";
import type { EventStore } from "../eventStore.js";
import {
  AcceptanceOrchestrator,
  BehaviorRevisionNotFoundError,
  HttpAcceptanceSurfaceDriver,
  MalformedAcceptanceSpecError,
  PgAcceptancePlanLoader,
  PgAcceptanceRunStore,
  PgReleaseInstanceBaseUrlResolver,
  type AcceptanceBehaviorResult,
  type AcceptanceEventSink,
  type AcceptancePlan,
  type AcceptancePlanLoader,
  type AcceptanceRunRequest,
  type AcceptanceRunResult,
  type AcceptanceRunStore,
  type CompleteAcceptanceRunInput,
  type RecordAcceptanceRunInput,
  type RecordAcceptanceVerdictInput,
  type StoredAcceptanceVerdict,
} from "../verification/acceptance/index.js";
import {
  PgVerificationEnvironmentResolver,
  type VerificationEnvironmentResolver,
} from "../repositories/verificationEnvironments.js";
import type { BehaviorEvidence } from "./demoEvidence.js";
import type { DemoTarget } from "./demoEngine.js";

/** The acceptance engine the demo drives — satisfied by the real {@link AcceptanceOrchestrator}. */
export interface AcceptanceExecutor {
  execute(request: AcceptanceRunRequest): Promise<AcceptanceRunResult>;
}

/**
 * A run whose deployed release delivered ZERO declared behavior revisions: a proof-backed
 * demo has nothing to prove and must NOT claim success (the naive `/`-probe would have
 * passed such a product trivially). Fails closed → the watcher records a durable
 * `demo.failed` (`load_behaviors_failed`).
 */
export class ProofBackedDemoNoBehaviorsError extends Error {
  public override readonly name = "ProofBackedDemoNoBehaviorsError";
  public constructor(
    public readonly runId: string,
    public readonly releaseInstanceId: string,
  ) {
    super(
      `proof-backed demo: run '${runId}' release '${releaseInstanceId}' delivered no behavior revisions — ` +
        "nothing to prove against the live surface",
    );
  }
}

/**
 * Every behavior went `inconclusive_*`: the deployed product could not be EXERCISED at all
 * (the base URL was unresolved or the product was unreachable). NEVER a fabricated pass —
 * the demo fails loud so the operator triages an infra halt, distinct from a real
 * product-behavior failure. The watcher records a durable `demo.failed` (`exercise_failed`).
 */
export class ProofBackedDemoUnobservableError extends Error {
  public override readonly name = "ProofBackedDemoUnobservableError";
  public constructor(
    public readonly runId: string,
    public readonly behaviorCount: number,
  ) {
    super(
      `proof-backed demo: run '${runId}' could not observe any of its ${String(behaviorCount)} behavior(s) ` +
        "against the live surface (unreachable / unobservable) — inconclusive, never a fabricated pass",
    );
  }
}

export interface ProofBackedWebDemoDeps {
  /** The event store the demo's append-only, org-scoped evidence + summary route through. */
  readonly events: EventStore;
  /** Compiles the release's `behavior_revisions.acceptance` specs into executable plans. */
  readonly planLoader: AcceptancePlanLoader;
  /** The acceptance orchestrator the demo drives (real rv-6 driver + rv-11 evaluation). */
  readonly orchestrator: AcceptanceExecutor;
  /**
   * Resolves the deploy-created `verification_environments` id for the run's live release so
   * the acceptance run PERSISTS its verdict against a real environment (rv-env) — never the
   * fabricated `integrationNodeId`.
   */
  readonly resolveEnvironment: VerificationEnvironmentResolver;
}

/** The in-memory result of a proof-backed demo — the per-behavior evidence + the pass/fail tally. */
export interface ProofBackedDemoResult {
  readonly evidence: readonly BehaviorEvidence[];
  readonly passed: number;
  readonly failed: number;
}

/** Fold a real acceptance verdict outcome into the demo's three-way class. */
function classifyOutcome(outcome: BehaviorVerdictOutcome): "passed" | "failed" | "inconclusive" {
  if (outcome === "passed") return "passed";
  if (
    outcome === "inconclusive_infrastructure" ||
    outcome === "inconclusive_external" ||
    outcome === "cancelled_superseded"
  ) {
    return "inconclusive";
  }
  // failed_product / failed_verification_contract / failed_visual
  return "failed";
}

/** Map one acceptance behavior result to the demo's per-behavior evidence (non-secret). */
function toEvidence(result: AcceptanceBehaviorResult): BehaviorEvidence {
  const cls = classifyOutcome(result.outcome);
  return {
    behaviorId: result.behaviorRevisionId,
    behaviorTitle: result.behaviorRevisionId,
    surfaceKind: "web_url",
    // Demo-`passed` ONLY on a real acceptance `passed`; every other outcome (product
    // failure OR inconclusive) is demo-`failed` — never a fabricated pass. The precise
    // acceptance outcome is preserved in `detail` so the operator distinguishes them.
    outcome: cls === "passed" ? "passed" : "failed",
    detail:
      `acceptance ${result.outcome}: ${String(result.passedAssertionCount)}/${String(result.requiredAssertionCount)} ` +
      `assertions passed (executed ${String(result.executedAssertionCount)})`,
  };
}

/**
 * The proof-backed web demo. `demo` drives the acceptance orchestrator against the run's
 * real deployed release, maps the REAL per-behavior verdicts to demo evidence, and records
 * the append-only, org-scoped `demo.evidence.recorded` + `demo.completed` events.
 */
export class ProofBackedWebDemo {
  public constructor(private readonly deps: ProofBackedWebDemoDeps) {}

  public async demo(target: DemoTarget, release: ReleaseInstanceRecord): Promise<ProofBackedDemoResult> {
    if (release.behaviorRevisionIds.length === 0) {
      throw new ProofBackedDemoNoBehaviorsError(target.runId, release.releaseInstanceId);
    }
    const plans = await this.deps.planLoader.loadPlans({
      orgId: target.orgId,
      behaviorRevisionIds: release.behaviorRevisionIds,
    });
    // Resolve the deploy-created verification environment for THIS live release so the
    // acceptance run persists its verdict against a real env (fail-closed if none/mismatch).
    const environmentId = await this.deps.resolveEnvironment.resolveForLiveRelease(release);
    const runResult = await this.deps.orchestrator.execute(this.buildRequest(target, release, plans, environmentId));

    const evidence = runResult.behaviors.map((behavior) => toEvidence(behavior));
    const passed = evidence.filter((entry) => entry.outcome === "passed").length;
    const failed = evidence.length - passed;

    // The product could not be exercised at all (every behavior inconclusive) — fail loud
    // as unobservable rather than record a `demo.completed` that misreads as product failure.
    const anyObserved = runResult.behaviors.some((behavior) => classifyOutcome(behavior.outcome) !== "inconclusive");
    if (runResult.behaviors.length > 0 && !anyObserved) {
      throw new ProofBackedDemoUnobservableError(target.runId, runResult.behaviors.length);
    }

    await this.recordEvidence(target, evidence, passed, failed);
    return { evidence, passed, failed };
  }

  private buildRequest(
    target: DemoTarget,
    release: ReleaseInstanceRecord,
    plans: readonly AcceptancePlan[],
    environmentId: string,
  ): AcceptanceRunRequest {
    return {
      orgId: target.orgId,
      projectId: target.projectId,
      // The release's integration node binds the rv-6 resolver to THIS run's release URL.
      integrationNodeId: release.integrationNodeId,
      // rv-env: the REAL deploy-created verification environment (not the integration node).
      environmentId,
      preparedHeadSha: release.sourceRef,
      jjTreeId: release.sourceRef,
      artifactDigest: release.artifactDigest,
      deploymentFingerprint: release.deploymentId,
      purpose: "post_merge_production",
      specId: target.specId,
      externalRunId: target.runId,
      plans,
    };
  }

  /** Append the per-behavior evidence + the demo summary under the run's org scope (RLS). */
  private async recordEvidence(
    target: DemoTarget,
    evidence: readonly BehaviorEvidence[],
    passed: number,
    failed: number,
  ): Promise<void> {
    await runWithJobOrgId(target.orgId, async () => {
      for (const entry of evidence) {
        await this.deps.events.append({
          runId: target.runId,
          specId: target.specId,
          projectId: target.projectId,
          orgId: target.orgId,
          eventType: "demo.evidence.recorded",
          payload: {
            behaviorId: entry.behaviorId,
            behaviorTitle: entry.behaviorTitle,
            surfaceKind: entry.surfaceKind,
            outcome: entry.outcome,
            detail: entry.detail,
          },
        });
      }
      await this.deps.events.append({
        runId: target.runId,
        specId: target.specId,
        projectId: target.projectId,
        orgId: target.orgId,
        eventType: "demo.completed",
        payload: { surfaceKind: "web_url", behaviorCount: evidence.length, passed, failed },
      });
    });
  }
}

/**
 * The demo's NON-PERSISTING acceptance run store. The demo drives the full rv-11
 * orchestrator for its REAL evaluation (drivers + assertion algebra + outcome resolution),
 * but persists the verdict as demo evidence (append-only `demo.*` events) rather than into
 * the pre-merge `behavior_verdicts` ledger — whose `behavior_verification_runs.environment_id`
 * FK requires a provisioned `verification_environments` row the deploy path does not create.
 * The orchestrator computes each outcome via its fail-closed `resolveOutcome` BEFORE this
 * store sees it, so a non-persisting sink cannot launder a verdict.
 */
export class EphemeralAcceptanceRunStore implements AcceptanceRunStore {
  // eslint-disable-next-line @typescript-eslint/require-await
  public async recordRun(_input: RecordAcceptanceRunInput): Promise<string> {
    return `demo_acceptance_run_${randomUUID()}`;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  public async completeRun(_input: CompleteAcceptanceRunInput): Promise<void> {}
  // eslint-disable-next-line @typescript-eslint/require-await
  public async recordVerdict(_input: RecordAcceptanceVerdictInput): Promise<string> {
    return `demo_acceptance_verdict_${randomUUID()}`;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  public async listVerdicts(_input: {
    readonly orgId: string;
    readonly runId: string;
  }): Promise<readonly StoredAcceptanceVerdict[]> {
    return [];
  }
}

/**
 * The demo's NON-PERSISTING acceptance event sink. The orchestrator emits the pre-merge
 * runtime-verification vocabulary (`behavior.verification.*` / `behavior.verdict.recorded`);
 * a post-deploy DEMO surfaces its own `demo.*` events instead, so these are swallowed here
 * to keep the pre-merge-gate timeline uncontaminated. No secret material is involved.
 */
export class EphemeralAcceptanceEventSink implements AcceptanceEventSink {
  // eslint-disable-next-line @typescript-eslint/require-await
  public async append(): Promise<void> {}
}

/**
 * Build the production proof-backed web demo: the real rv-11 {@link AcceptanceOrchestrator}
 * driving the rv-6 {@link HttpAcceptanceSurfaceDriver} over the run's real
 * `release_instances.url` (bound by {@link PgReleaseInstanceBaseUrlResolver}), compiling
 * plans from `behavior_revisions.acceptance` ({@link PgAcceptancePlanLoader}). A thin
 * factory so the demo-on-deploy watcher imports ONE demo symbol (keeps that file under its
 * dependency cap; mirrors `buildDemoOnDeployWatcher`).
 */
export function buildProofBackedWebDemo(pool: pg.Pool, events: EventStore): ProofBackedWebDemo {
  const orchestrator = new AcceptanceOrchestrator({
    // rv-env: the PERSISTING store — the demo's real per-behavior verdict now lands in the
    // 0079-hardened `behavior_verdicts` ledger (bound to the deploy-created env), not a sink.
    store: new PgAcceptanceRunStore(pool),
    // The orchestrator's pre-merge `behavior.verification.*` events stay swallowed; the demo
    // surfaces its own `demo.*` events via `events` below.
    events: new EphemeralAcceptanceEventSink(),
    drivers: [new HttpAcceptanceSurfaceDriver({ resolveBaseUrl: new PgReleaseInstanceBaseUrlResolver(pool) })],
  });
  return new ProofBackedWebDemo({
    events,
    planLoader: new PgAcceptancePlanLoader(pool),
    orchestrator,
    resolveEnvironment: new PgVerificationEnvironmentResolver(pool),
  });
}

/**
 * Whether a proof-backed web demo failure is a LOAD failure (the release delivered no
 * declared behaviors, or its stored acceptance spec is missing/malformed) — as opposed to a
 * drive/observe failure. Lets the watcher refine the durable `demo.failed.reason` to
 * `load_behaviors_failed` without importing the acceptance error classes itself.
 */
export function isProofBackedLoadFailure(error: unknown): boolean {
  return (
    error instanceof ProofBackedDemoNoBehaviorsError ||
    error instanceof MalformedAcceptanceSpecError ||
    error instanceof BehaviorRevisionNotFoundError
  );
}
