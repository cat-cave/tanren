/**
 * rv-6 A2: the acceptance-plan LOADER — the narrow view the rv-11 orchestrator
 * runs. It parses a behavior revision's STORED acceptance spec
 * (`behavior_revisions.acceptance`), compiles it through the rv-2
 * {@link compileExecutableBehaviorPlan} into the canonical
 * {@link ExecutableBehaviorPlanV1}, and projects that typed plan into the narrow
 * {@link AcceptancePlan}. The narrow assertions are DERIVED from the rv-2 typed
 * {@link AssertionExpression}s (their exact subject / operator / expected), so the
 * plan the orchestrator executes IS the compiler's output — the correlation
 * binding (rv-12) is joined back from the spec by assertion id.
 *
 * FAITHFUL OR LOUD: a malformed/unparseable spec throws
 * {@link MalformedAcceptanceSpecError}; a spec that compiles to `needs_respec`
 * (an assertion whose observable binding is not authored) throws
 * {@link AcceptancePlanNotExecutableError}. It NEVER silently drops an assertion,
 * fabricates one, or degrades to an empty / always-passing plan.
 */

import { parseDigest } from "../../contracts/cas.js";
import { parseBehaviorRevisionId, parsePersonaRevisionId } from "../../contracts/behaviorRevision.js";
import type { AssertionExpression, ExecutableBehaviorPlanV1 } from "../../contracts/runtimeVerificationPlan.js";
import type { AcceptanceAssertion, AcceptancePlan, HttpProbeSpec, PlanCapabilityFragment } from "./orchestrator.js";
import type { CauseSpec, EffectCorrelation } from "./causalCorrelation.js";
import { parseAcceptanceSpec, type AcceptanceSpecV1 } from "./acceptanceSpec.js";
import { compileExecutableBehaviorPlan } from "./executablePlanCompiler.js";

export { MalformedAcceptanceSpecError } from "./acceptanceSpec.js";

/**
 * A behavior revision parsed + id-consistent, yet its compiled plan is not
 * runnable (it needs a re-spec, or a fragment its assertions require is missing).
 * Surfaced typed at the load boundary so a run never proceeds on a plan that can
 * only ever go inconclusive. Fail-closed.
 */
export class AcceptancePlanNotExecutableError extends Error {
  public override readonly name = "AcceptancePlanNotExecutableError";

  public constructor(
    public readonly behaviorRevisionId: string,
    public readonly reason: string,
  ) {
    super(`behavior revision ${behaviorRevisionId} did not compile to an executable plan: ${reason}`);
  }
}

/** The behavior-revision fields the compiler needs to mint a canonical, provenance-real plan. */
export interface CompileAcceptancePlanRevision {
  readonly id: string;
  readonly personaRevisionId: string;
  readonly behaviorRevisionHash: string;
  readonly acceptance: unknown;
}

/** Project one bound capability step into the narrow `PlanCapabilityFragment` shape. */
function projectStep(step: {
  readonly id: string;
  readonly capabilityFragmentRef: ExecutableBehaviorPlanV1["fixtures"][number]["capabilityFragmentRef"];
  readonly params: ExecutableBehaviorPlanV1["fixtures"][number]["params"];
}): Omit<PlanCapabilityFragment, "stepKind"> {
  return { stepId: step.id, capabilityFragmentRef: step.capabilityFragmentRef, params: step.params };
}

/** Project the canonical typed plan + its source spec into the orchestrator's narrow view. */
export function toAcceptancePlan(plan: ExecutableBehaviorPlanV1, spec: AcceptanceSpecV1): AcceptancePlan {
  const correlationById = new Map<string, EffectCorrelation>();
  for (const authored of spec.assertions) {
    if (authored.correlation !== undefined) correlationById.set(authored.assertionId, authored.correlation);
  }

  const assertions: readonly AcceptanceAssertion[] = plan.assertions.map((expr: AssertionExpression) => {
    const correlation = correlationById.get(expr.assertionId);
    return {
      assertionId: expr.assertionId,
      subject: expr.subject,
      comparisonOperator: expr.comparisonOperator,
      expected: expr.expected,
      ...(correlation === undefined ? {} : { correlation }),
    };
  });

  const httpProbes: readonly HttpProbeSpec[] = spec.httpProbes.map((probe) => ({
    probeId: probe.probeId,
    method: probe.method,
    path: probe.path,
    ...(probe.headers === undefined ? {} : { headers: probe.headers }),
    ...(probe.body === undefined ? {} : { body: probe.body }),
  }));

  // rv-3: surface the resolved capability fragment refs (fixture/action/cleanup
  // steps) so a downstream runtime can drive them from their registry version.
  const capabilityFragments: readonly PlanCapabilityFragment[] = [
    ...plan.fixtures.map((step) => ({ stepKind: "fixture" as const, ...projectStep(step) })),
    ...plan.actions.map((step) => ({ stepKind: "action" as const, ...projectStep(step) })),
    ...plan.cleanup.map((step) => ({ stepKind: "cleanup" as const, ...projectStep(step) })),
  ];

  return {
    planId: plan.planId,
    behaviorRevisionId: plan.behaviorRevisionId,
    requiredSurfaces: plan.requiredSurfaces,
    assertions,
    fixtures: spec.fixtures,
    ...(capabilityFragments.length === 0 ? {} : { capabilityFragments }),
    examples: plan.examples.map((example) => ({ values: example.values, rowHash: example.rowHash })),
    executionMatrix: plan.executionMatrix,
    causes: spec.causes as readonly CauseSpec[],
    httpProbes,
    ...(spec.visualVerification === undefined ? {} : { visualVerification: spec.visualVerification }),
  };
}

/**
 * Compile one behavior revision's stored acceptance spec into the narrow
 * executable plan the orchestrator runs. Throws {@link MalformedAcceptanceSpecError}
 * on a parse/consistency failure and {@link AcceptancePlanNotExecutableError} on a
 * `needs_respec` / `missing_fragments` compile outcome — the caller never receives
 * a partially-dropped, empty, or always-passing plan.
 */
export function compileAcceptancePlan(revision: CompileAcceptancePlanRevision): AcceptancePlan {
  const spec = parseAcceptanceSpec(revision.id, revision.acceptance);
  const result = compileExecutableBehaviorPlan({
    behaviorRevisionId: parseBehaviorRevisionId(revision.id),
    personaRevisionId: parsePersonaRevisionId(revision.personaRevisionId),
    behaviorRevisionHash: parseDigest(revision.behaviorRevisionHash),
    spec,
  });
  if (result.kind === "needs_respec") {
    throw new AcceptancePlanNotExecutableError(revision.id, `needs re-spec: ${result.reasons.join("; ")}`);
  }
  if (result.kind === "missing_fragments") {
    const missing = result.obligations.map((obligation) => obligation.capability).join(", ");
    throw new AcceptancePlanNotExecutableError(revision.id, `missing fragments: ${missing}`);
  }
  return toAcceptancePlan(result.plan, spec);
}
