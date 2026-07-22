/**
 * rv-11 A1 acceptance: the plan/request/result data shapes the orchestrator
 * reads and returns. Split out of orchestrator.ts to keep that file under the
 * 500-line cap; re-exported from ./orchestrator.js so the public import specifier
 * is unchanged.
 */

import type { CanonicalBody, Digest } from "../../contracts/cas.js";
import type {
  AdapterUnavailableResult,
  BehaviorVerdictOutcome,
  DriverExecutionResult,
  EvidenceLinkRef,
  VerificationRunPurpose,
} from "../../contracts/runtimeVerificationAdapters.js";
import type {
  CapabilityFragmentRef,
  ComparisonOperator,
  ExampleRow,
  ExecutionMatrix,
  RequiredSurface,
} from "../../contracts/runtimeVerificationPlan.js";
import type { CauseSpec, EffectCorrelation } from "./causalCorrelation.js";
import type { VisualVerificationRequirement } from "./designRenderStage.js";

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

/**
 * rv-26.6 (apex P6): one interactive browser interaction the `browser` surface driver
 * performs — `clicks` REAL clicks on `selector` in the deployed dashboard. Its observed
 * confirmed-click count feeds an assertion whose subject is `<interactionId>.clickCount`
 * (e.g. `notify.clickCount` equals 100). Each confirmed click also emits one
 * `behavior.action.observed` event keyed by `interactionId`.
 */
export interface ClickInteractionSpec {
  readonly interactionId: string;
  readonly selector: string;
  readonly clicks: number;
}

/** rv-3: one verification-capability fragment resolved + bound into a plan step. */
export interface PlanCapabilityFragment {
  readonly stepKind: "fixture" | "action" | "cleanup";
  readonly stepId: string;
  readonly capabilityFragmentRef: CapabilityFragmentRef;
  readonly params: CanonicalBody;
}

/** The narrow view of a compiled ExecutableBehaviorPlanV1 the orchestrator reads. */
export interface AcceptancePlan {
  readonly planId: string;
  readonly behaviorRevisionId: string;
  readonly requiredSurfaces: readonly RequiredSurface[];
  readonly assertions: readonly AcceptanceAssertion[];
  readonly fixtures: readonly unknown[];
  /** rv-3: the verification-capability fragments resolved + bound into this plan's
   *  fixture/action/cleanup lanes, each carrying its concrete registry version ref. */
  readonly capabilityFragments?: readonly PlanCapabilityFragment[];
  readonly examples: readonly ExampleRow[];
  readonly executionMatrix: ExecutionMatrix;
  /** rv-12: the causes a plan's causal assertions drive + correlate effects to. */
  readonly causes?: readonly CauseSpec[];
  /** rv-6: the HTTP requests the api surface driver fires to observe subjects. */
  readonly httpProbes?: readonly HttpProbeSpec[];
  /** rv-26.6: the interactive clicks the `browser` surface driver performs to observe `<id>.clickCount`. */
  readonly clickInteractions?: readonly ClickInteractionSpec[];
  /**
   * rv-13 A4: when `required`, the behavior ALSO demands a passing rendered-visual
   * (ds-4 design-render a11y) verdict for the project — folded fail-closed as a
   * downgrade-only overlay on the behavior's outcome. Absent ⇒ no visual gate.
   */
  readonly visualVerification?: VisualVerificationRequirement;
}

/**
 * The ordinary API surface driver must never fire a probe that a causal API
 * driver owns. The causal driver captures its provider watermark, propagates
 * its correlation, and fires the action exactly once after the durable delivery
 * intent marker. Letting both drivers send the same probe would create an
 * unfenced duplicate external effect.
 */
export function withoutCausalApiTriggers(plan: AcceptancePlan): AcceptancePlan {
  const referencedCauses = new Set(
    plan.assertions.flatMap((assertion) =>
      assertion.correlation === undefined ? [] : [assertion.correlation.causeId],
    ),
  );
  const causalActions = new Set(
    (plan.causes ?? [])
      .filter((cause) => cause.surface === "api" && referencedCauses.has(cause.causeId))
      .map((cause) => cause.action),
  );
  if (causalActions.size === 0 || plan.httpProbes === undefined) return plan;
  const httpProbes = plan.httpProbes.filter((probe) => !causalActions.has(probe.probeId));
  return httpProbes.length === plan.httpProbes.length ? plan : { ...plan, httpProbes };
}

/**
 * Preview demos prove only their preview-safe assertions. A causal assertion drives an
 * externally visible product effect against an exact production binding, so it cannot be
 * exercised on a preview release or be allowed to consume the production A3 coordinate.
 * The production delivery demo retains the unmodified plan and is the sole A3 trigger.
 */
export function withoutLiveEffectAssertions(plan: AcceptancePlan): AcceptancePlan {
  const causalAssertions = plan.assertions.filter((assertion) => assertion.correlation !== undefined);
  if (causalAssertions.length === 0) return plan;
  const causalActions = new Set(
    (plan.causes ?? [])
      .filter((cause) => causalAssertions.some((assertion) => assertion.correlation?.causeId === cause.causeId))
      .map((cause) => cause.action),
  );
  return {
    ...plan,
    assertions: plan.assertions.filter((assertion) => assertion.correlation === undefined),
    causes: [],
    ...(plan.httpProbes === undefined
      ? {}
      : { httpProbes: plan.httpProbes.filter((probe) => !causalActions.has(probe.probeId)) }),
  };
}

export interface AcceptanceDriveInput {
  readonly orgId: string;
  readonly projectId: string;
  /** rv-6: the run's integration node — binds a driver to THIS run's release. */
  readonly integrationNodeId: string;
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
  /** The exact in-17 delivery binding set the live release was attached with. */
  readonly deliveryRunId?: string;
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
  /** rv-9: content-addressed evidence captured from the drive (empty when no capture store/artifact). */
  readonly evidenceLinkRefs: readonly EvidenceLinkRef[];
}

export interface AcceptanceRunResult {
  readonly runId: string;
  readonly requiredVerdictCount: number;
  readonly passedVerdictCount: number;
  /** The context hash every behavior verdict in this run was recorded under (rv-17 flake window). */
  readonly runtimeBehaviorContextHash: Digest;
  readonly behaviors: readonly AcceptanceBehaviorResult[];
}
