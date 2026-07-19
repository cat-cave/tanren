/**
 * rv-11 A1 executable-acceptance orchestrator. For a behavior with a compiled
 * executable acceptance plan (rv-2/3), it EXECUTES the plan: leases fixtures
 * (rv-7), drives the required surface through a driver adapter (rv-6), collects a
 * REAL per-assertion pass/fail from the driver's observations, and records an
 * immutable behavior verdict (rv-10 substrate) through {@link AcceptanceRunStore}.
 *
 * The executed-assertion count is the number of assertions a driver observation
 * actually covered — never a copy of the required count. Combined with the
 * store's coverage guard + the 0079 DB CHECK, a `passed` verdict is impossible
 * unless every required assertion executed and passed (required >= 1).
 */

import { createHash } from "node:crypto";
import { canonicalJson, type CanonicalBody, type Digest } from "../../contracts/cas.js";
import type { FixtureLeaseAdapter } from "../../contracts/fixtureLeaseAdapter.js";
import type {
  AdapterUnavailableResult,
  BehaviorVerdictOutcome,
  DriverExecutionResult,
  DriverObservation,
  VerificationRunPurpose,
} from "../../contracts/runtimeVerificationAdapters.js";
import type {
  ComparisonOperator,
  ExampleRow,
  ExecutionMatrix,
  RequiredSurface,
} from "../../contracts/runtimeVerificationPlan.js";
import { evaluateAssertion } from "./assertionEvaluator.js";
import type { CauseSpec, EffectCorrelation } from "./causalCorrelation.js";
import {
  CausalCorrelationStage,
  type AcceptanceCauseDriver,
  type CausalAssertionRef,
  type CausalCorrelationStageDependencies,
  type CausalEffectReader,
  type CausalStageResult,
} from "./causalStage.js";
import type { AcceptanceEventSink } from "./eventSink.js";
import type { AcceptanceRunStore } from "./verdictStore.js";

export interface AcceptanceAssertion {
  readonly assertionId: string;
  readonly subject: string;
  readonly comparisonOperator: ComparisonOperator;
  readonly expected: CanonicalBody;
  /**
   * rv-12: when present this is a causal cardinality assertion — its ACTUAL is
   * the set of rv-8 effects correlated to the referenced cause, not a direct
   * driver observation. The subject is observed by the causal stage.
   */
  readonly correlation?: EffectCorrelation;
}

/**
 * rv-6: a single REAL HTTP request the api surface driver fires against the
 * deployed product. Its observations feed assertions whose subject is
 * `<probeId>.<selector>` (e.g. `p1.status`, `p1.body.count`). The narrow plan
 * carries the request spec so the driver knows WHAT to send; the assertion
 * algebra stays subject-keyed and unchanged.
 */
export interface HttpProbeSpec {
  readonly probeId: string;
  readonly method: string;
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: CanonicalBody;
}

/** The narrow view of a compiled ExecutableBehaviorPlanV1 the orchestrator reads. */
export interface AcceptancePlan {
  readonly planId: string;
  readonly behaviorRevisionId: string;
  readonly requiredSurfaces: readonly RequiredSurface[];
  readonly assertions: readonly AcceptanceAssertion[];
  readonly fixtures: readonly unknown[];
  readonly examples: readonly ExampleRow[];
  readonly executionMatrix: ExecutionMatrix;
  /** rv-12: the causes a plan's causal assertions drive + correlate effects to. */
  readonly causes?: readonly CauseSpec[];
  /** rv-6: the HTTP requests the api surface driver fires to observe subjects. */
  readonly httpProbes?: readonly HttpProbeSpec[];
}

export interface AcceptanceDriveInput {
  readonly orgId: string;
  readonly projectId: string;
  readonly plan: AcceptancePlan;
  readonly example: ExampleRow | undefined;
  readonly matrixKey: string;
  readonly deploymentFingerprint: string;
}

/** A surface driver (Playwright/API/CLI/…): drives the deployment, emits observations. */
export interface AcceptanceSurfaceDriver {
  readonly surface: RequiredSurface;
  drive(input: AcceptanceDriveInput): Promise<DriverExecutionResult | AdapterUnavailableResult>;
}

export interface AcceptanceRunRequest {
  readonly orgId: string;
  readonly projectId: string;
  readonly integrationNodeId: string;
  readonly environmentId: string;
  readonly preparedHeadSha: string;
  readonly jjTreeId: string;
  readonly artifactDigest: Digest;
  readonly deploymentFingerprint: string;
  readonly purpose?: VerificationRunPurpose;
  readonly specId?: string;
  readonly externalRunId?: string;
  readonly runtimeBehaviorContextHash?: Digest;
  readonly plans: readonly AcceptancePlan[];
}

export interface AcceptanceBehaviorResult {
  readonly behaviorRevisionId: string;
  readonly planId: string;
  readonly verdictId: string;
  readonly outcome: BehaviorVerdictOutcome;
  readonly requiredAssertionCount: number;
  readonly executedAssertionCount: number;
  readonly passedAssertionCount: number;
}

export interface AcceptanceRunResult {
  readonly runId: string;
  readonly requiredVerdictCount: number;
  readonly passedVerdictCount: number;
  readonly behaviors: readonly AcceptanceBehaviorResult[];
}

export interface AcceptanceOrchestratorDependencies {
  readonly store: AcceptanceRunStore;
  readonly events: AcceptanceEventSink;
  readonly drivers?: readonly AcceptanceSurfaceDriver[];
  readonly fixtureLease?: FixtureLeaseAdapter;
  /** rv-12: cause drivers that fire the triggering actions for causal assertions. */
  readonly causeDrivers?: readonly AcceptanceCauseDriver[];
  /** rv-12: reads rv-8 immutable effect observations for correlation. */
  readonly effectReader?: CausalEffectReader;
  /** rv-12: injectable clock for causal observation timestamps (tests). */
  readonly now?: () => string;
}

function sha256(value: string): Digest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}` as Digest;
}

function isUnavailable(result: DriverExecutionResult | AdapterUnavailableResult): result is AdapterUnavailableResult {
  return result.kind === "unavailable";
}

function matrixKeyOf(matrix: ExecutionMatrix): string {
  const dims = [matrix.browser, matrix.viewport, matrix.locale, matrix.theme, matrix.device];
  const key = dims.map((values) => values[0] ?? "*").join("/");
  return key.slice(0, 256);
}

interface AssertionEvaluation {
  readonly executedCount: number;
  readonly passedCount: number;
  readonly observed: readonly { readonly assertionId: string; readonly satisfied: boolean }[];
}

function evaluatePlan(plan: AcceptancePlan, observations: readonly DriverObservation[]): AssertionEvaluation {
  const bySubject = new Map<string, CanonicalBody>();
  for (const observation of observations) bySubject.set(observation.subject, observation.value);
  const observed: { assertionId: string; satisfied: boolean }[] = [];
  let executedCount = 0;
  let passedCount = 0;
  for (const assertion of plan.assertions) {
    // No driver observation for this subject ⇒ the assertion did NOT execute.
    if (!bySubject.has(assertion.subject)) continue;
    executedCount += 1;
    const actual = bySubject.get(assertion.subject) ?? null;
    const satisfied = evaluateAssertion(assertion.comparisonOperator, actual, assertion.expected);
    if (satisfied) passedCount += 1;
    observed.push({ assertionId: assertion.assertionId, satisfied });
  }
  return { executedCount, passedCount, observed };
}

/** The aggregate of driving EVERY required surface for one behavior. */
interface DriveAggregate {
  readonly observations: readonly DriverObservation[];
  /** At least one required surface was attempted (there was a surface to drive). */
  readonly drove: boolean;
  /** A required surface had no wired driver — the surface could not be exercised. */
  readonly missingDriver: boolean;
  /** A required surface's driver reported its environment unavailable. */
  readonly unavailable?: AdapterUnavailableResult;
}

/**
 * Fold the rv-12 causal stage into the surface-drive aggregate. Causal work
 * counts as "drove" (so a causal-only plan is not spuriously infra-inconclusive),
 * a missing cause driver / effect reader is a missing driver, and a reported
 * unavailability propagates — every causal fail-closed path lands as an
 * infra/external outcome through {@link resolveOutcome}, never a pass.
 */
function mergeCausalIntoAggregate(surface: DriveAggregate, causal: CausalStageResult): DriveAggregate {
  const unavailable = surface.unavailable ?? causal.unavailable;
  return {
    observations: [...surface.observations, ...causal.observations],
    drove: surface.drove || causal.attempted,
    missingDriver: surface.missingDriver || causal.missingCauseDriver || causal.missingObserver,
    ...(unavailable === undefined ? {} : { unavailable }),
  };
}

function resolveOutcome(
  aggregate: DriveAggregate,
  required: number,
  evaluation: AssertionEvaluation,
): BehaviorVerdictOutcome {
  // Infra gaps fail closed BEFORE any coverage claim: a surface we could not
  // drive can never contribute a passing assertion.
  if (!aggregate.drove) return "inconclusive_infrastructure";
  if (aggregate.unavailable !== undefined) return aggregate.unavailable.outcome;
  if (aggregate.missingDriver) return "inconclusive_infrastructure";
  // A plan that requires no assertions has no coverage — never a pass.
  if (required < 1) return "failed_verification_contract";
  if (evaluation.executedCount < required) return "failed_verification_contract";
  if (evaluation.passedCount === required) return "passed";
  return "failed_product";
}

/** Executes compiled acceptance plans and records immutable per-behavior verdicts. */
export class AcceptanceOrchestrator {
  private readonly store: AcceptanceRunStore;
  private readonly events: AcceptanceEventSink;
  private readonly drivers: Map<RequiredSurface, AcceptanceSurfaceDriver>;
  private readonly fixtureLease?: FixtureLeaseAdapter;
  private readonly causalStage: CausalCorrelationStage;

  public constructor(dependencies: AcceptanceOrchestratorDependencies) {
    this.store = dependencies.store;
    this.events = dependencies.events;
    this.drivers = new Map((dependencies.drivers ?? []).map((driver) => [driver.surface, driver]));
    this.fixtureLease = dependencies.fixtureLease;
    const stageDeps: CausalCorrelationStageDependencies = {
      ...(dependencies.causeDrivers === undefined ? {} : { causeDrivers: dependencies.causeDrivers }),
      ...(dependencies.effectReader === undefined ? {} : { effectReader: dependencies.effectReader }),
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    };
    this.causalStage = new CausalCorrelationStage(stageDeps);
  }

  public async execute(request: AcceptanceRunRequest): Promise<AcceptanceRunResult> {
    const planSetHash = sha256(canonicalJson(request.plans.map((plan) => plan.planId).sort()));
    const contextHash = request.runtimeBehaviorContextHash ?? sha256(`${request.artifactDigest} ${planSetHash}`);
    const runId = await this.store.recordRun({
      orgId: request.orgId,
      projectId: request.projectId,
      purpose: request.purpose ?? "pre_merge",
      environmentId: request.environmentId,
      preparedHeadSha: request.preparedHeadSha,
      jjTreeId: request.jjTreeId,
      planSetHash,
      runtimeBehaviorContextHash: contextHash,
      artifactDigest: request.artifactDigest,
      integrationNodeId: request.integrationNodeId,
      ...(request.externalRunId === undefined ? {} : { runId: request.externalRunId }),
      ...(request.specId === undefined ? {} : { specId: request.specId }),
    });

    for (const plan of request.plans) {
      await this.events.append({
        orgId: request.orgId,
        projectId: request.projectId,
        eventType: "behavior.verification.started",
        payload: {
          behaviorRevisionId: plan.behaviorRevisionId,
          integrationNodeId: request.integrationNodeId,
          artifactDigest: request.artifactDigest,
        },
      });
    }

    const behaviors: AcceptanceBehaviorResult[] = [];
    for (const plan of request.plans) {
      behaviors.push(await this.runBehavior(request, runId, plan, contextHash));
    }

    const passedVerdictCount = behaviors.filter((behavior) => behavior.outcome === "passed").length;
    await this.store.completeRun({ orgId: request.orgId, runId, status: "completed" });
    await this.events.append({
      orgId: request.orgId,
      projectId: request.projectId,
      eventType: "behavior.verification.completed",
      payload: {
        integrationNodeId: request.integrationNodeId,
        requiredVerdictCount: request.plans.length,
        passedVerdictCount,
      },
    });

    return { runId, requiredVerdictCount: request.plans.length, passedVerdictCount, behaviors };
  }

  private async runBehavior(
    request: AcceptanceRunRequest,
    runId: string,
    plan: AcceptancePlan,
    contextHash: Digest,
  ): Promise<AcceptanceBehaviorResult> {
    const matrixKey = matrixKeyOf(plan.executionMatrix);
    const shardId = `${plan.planId}:0`;
    const example = plan.examples[0];
    const exampleHash = example?.rowHash ?? sha256(`${plan.planId} example`);
    const matrixHash = sha256(canonicalJson(plan.executionMatrix as unknown as CanonicalBody));

    await this.events.append({
      orgId: request.orgId,
      projectId: request.projectId,
      eventType: "behavior.shard.started",
      payload: { behaviorRevisionId: plan.behaviorRevisionId, shardId, matrixKey },
    });
    await this.events.append({
      orgId: request.orgId,
      projectId: request.projectId,
      eventType: "behavior.attempt.started",
      payload: { behaviorRevisionId: plan.behaviorRevisionId, shardId, attempt: 0 },
    });

    const leaseId = await this.acquireFixtures(request, runId, plan);
    const surfaceAggregate = await this.driveSurfaces(request, plan, example, matrixKey);
    const causal = await this.runCausalStage(request, plan);
    const aggregate = mergeCausalIntoAggregate(surfaceAggregate, causal);
    const evaluation = evaluatePlan(plan, aggregate.observations);
    for (const entry of evaluation.observed) {
      await this.events.append({
        orgId: request.orgId,
        projectId: request.projectId,
        eventType: "behavior.assertion.observed",
        payload: {
          behaviorRevisionId: plan.behaviorRevisionId,
          shardId,
          assertionId: entry.assertionId,
          satisfied: entry.satisfied,
        },
      });
    }

    const required = plan.assertions.length;
    const outcome = resolveOutcome(aggregate, required, evaluation);
    const verdictId = await this.store.recordVerdict({
      orgId: request.orgId,
      projectId: request.projectId,
      runId,
      behaviorRevisionId: plan.behaviorRevisionId,
      exampleHash,
      matrixHash,
      requiredAssertionCount: required,
      executedAssertionCount: evaluation.executedCount,
      outcome,
      attemptCount: 1,
      flakeState: "stable",
      gateEffect: "blocking",
      artifactDigest: request.artifactDigest,
      runtimeBehaviorContextHash: contextHash,
    });
    await this.events.append({
      orgId: request.orgId,
      projectId: request.projectId,
      eventType: "behavior.verdict.recorded",
      payload: {
        behaviorRevisionId: plan.behaviorRevisionId,
        verdictId,
        outcome,
        executedAssertionCount: evaluation.executedCount,
        flakeState: "stable",
      },
    });

    await this.releaseFixtures(request, leaseId, runId, plan.planId);

    return {
      behaviorRevisionId: plan.behaviorRevisionId,
      planId: plan.planId,
      verdictId,
      outcome,
      requiredAssertionCount: required,
      executedAssertionCount: evaluation.executedCount,
      passedAssertionCount: evaluation.passedCount,
    };
  }

  private async acquireFixtures(
    request: AcceptanceRunRequest,
    runId: string,
    plan: AcceptancePlan,
  ): Promise<string | undefined> {
    if (this.fixtureLease === undefined || plan.fixtures.length === 0) return undefined;
    const lease = await this.fixtureLease.acquire({
      orgId: request.orgId,
      projectId: request.projectId,
      kind: "dataset",
      correlationNamespace: `${runId}:${plan.planId}`,
    });
    return lease.leaseId;
  }

  private async releaseFixtures(
    request: AcceptanceRunRequest,
    leaseId: string | undefined,
    runId: string,
    planId: string,
  ): Promise<void> {
    if (this.fixtureLease === undefined || leaseId === undefined) return;
    await this.fixtureLease.release({
      orgId: request.orgId,
      projectId: request.projectId,
      leaseId,
      cleanupEvidenceHash: sha256(`${runId} ${planId} cleanup`),
    });
  }

  /**
   * Run the rv-12 causal-correlation stage for a plan's causal assertions:
   * fire each referenced cause, read the rv-8 effect evidence, correlate, and
   * return the per-subject observations plus the fail-closed availability flags.
   */
  private async runCausalStage(request: AcceptanceRunRequest, plan: AcceptancePlan): Promise<CausalStageResult> {
    const causalAssertions: CausalAssertionRef[] = [];
    for (const assertion of plan.assertions) {
      if (assertion.correlation === undefined) continue;
      causalAssertions.push({
        assertionId: assertion.assertionId,
        subject: assertion.subject,
        comparisonOperator: assertion.comparisonOperator,
        correlation: assertion.correlation,
      });
    }
    return this.causalStage.run({
      orgId: request.orgId,
      projectId: request.projectId,
      deploymentFingerprint: request.deploymentFingerprint,
      causes: plan.causes ?? [],
      causalAssertions,
    });
  }

  /**
   * Drive EVERY required surface and gather observations from each. A plan that
   * declares more than one required surface must exercise all of them: an
   * assertion whose subject belongs to an undriven or unavailable surface is
   * never observed, so it cannot execute — and a missing/unavailable required
   * surface forces an infra-conclusive outcome (never a pass on a subset).
   */
  private async driveSurfaces(
    request: AcceptanceRunRequest,
    plan: AcceptancePlan,
    example: ExampleRow | undefined,
    matrixKey: string,
  ): Promise<DriveAggregate> {
    const surfaces = plan.requiredSurfaces;
    if (surfaces.length === 0) return { observations: [], drove: false, missingDriver: false };
    const observations: DriverObservation[] = [];
    let missingDriver = false;
    let unavailable: AdapterUnavailableResult | undefined;
    for (const surface of surfaces) {
      const driver = this.drivers.get(surface);
      if (driver === undefined) {
        missingDriver = true;
        continue;
      }
      const result = await driver.drive({
        orgId: request.orgId,
        projectId: request.projectId,
        plan,
        example,
        matrixKey,
        deploymentFingerprint: request.deploymentFingerprint,
      });
      if (isUnavailable(result)) {
        unavailable = result;
        continue;
      }
      observations.push(...result.observations);
    }
    return { observations, drove: true, missingDriver, ...(unavailable === undefined ? {} : { unavailable }) };
  }
}
