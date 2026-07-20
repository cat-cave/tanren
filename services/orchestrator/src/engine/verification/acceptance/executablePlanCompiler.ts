/**
 * rv-2: the executable-plan compiler + typed assertion DSL. It turns an immutable
 * rv-1 behavior revision's parsed acceptance spec into the canonical
 * {@link ExecutableBehaviorPlanV1} — resolving every authored assertion into a
 * concrete typed {@link AssertionExpression} over the execution matrix, and
 * returning the deterministic {@link PlanCompileResult} the plan-load path runs.
 *
 * DETERMINISTIC: the same behavior revision + acceptance spec + compiler version
 * yields the same plan hash (the planId is the `plan.v1` domain hash of the whole
 * plan body). A re-compile is bit-identical.
 *
 * FAIL-CLOSED + EXHAUSTIVE: the assertion DSL switches over the ENTIRE
 * {@link ComparisonOperator} set with a `never` guard — a new operator is a
 * compile error, and an operator that somehow escapes the parser's enum throws
 * {@link PlanCompileError} rather than resolving to a silently-vacuous assertion.
 * An assertion whose observable binding is not present in the acceptance spec
 * (a temporal cursor/watermark, a causal trigger→effect binding, or a
 * non-numeric cardinality) is NOT guessed — it yields `needs_respec`, never a
 * plan that can only ever go inconclusive.
 */

import type { CanonicalBody, Digest } from "../../contracts/cas.js";
import type { BehaviorRevisionId, PersonaRevisionId, RevisionDigest } from "../../contracts/behaviorRevision.js";
import type {
  ActionStep,
  ArtifactPolicy,
  AssertionExpression,
  BehaviorVerificationPlanId,
  CapabilityFragmentRef,
  CleanupStep,
  ExecutableBehaviorPlanCanonical,
  ExecutableBehaviorPlanV1,
  FixtureStep,
  FlakePolicy,
  MissingCapabilityObligation,
  PlanCompileResult,
  PlanProvenance,
  RedactionClass,
  RequiredSurface,
  SourceSpan,
} from "../../contracts/runtimeVerificationPlan.js";
import { planHash } from "../../contracts/runtimeVerificationPlan.js";
import type { AcceptanceSpecAssertion, AcceptanceSpecV1 } from "./acceptanceSpec.js";
import { toExecutionMatrix } from "./acceptanceSpec.js";
import { capabilityMapKey } from "./fragments/verificationFragment.js";

/** Bumped whenever the compilation is not bit-compatible; part of the plan hash. */
export const EXECUTABLE_PLAN_COMPILER_VERSION = "rv2-executable-plan.v1";

/**
 * The default evidence posture a compiled plan carries until the behavior
 * revision authors its own. A deterministic, documented default — not a guess:
 * it retains a redacted trace/console/network bundle so a failing verdict is
 * always explainable.
 */
const DEFAULT_ARTIFACT_POLICY: ArtifactPolicy = {
  retainEvidence: true,
  evidenceKinds: ["trace", "console", "network"],
  retentionClass: "standard",
  maxBytesPerArtifact: 25_000_000,
  requireRedaction: true,
};

/** The default flake posture: no timeout, integer retry/stress counts, single required pass. */
const DEFAULT_FLAKE_POLICY: FlakePolicy = {
  retries: 0,
  stressRepetitions: 1,
  stablePassThreshold: 1,
};

/**
 * A parsed, id-consistent acceptance spec still could not be compiled into an
 * executable plan and the failure is not a re-spec obligation — surfaced typed,
 * never a silently-empty plan. Fail-closed.
 */
export class PlanCompileError extends Error {
  public override readonly name = "PlanCompileError";

  public constructor(
    public readonly behaviorRevisionId: string,
    public readonly reason: string,
  ) {
    super(`executable-plan compile failed for behavior revision ${behaviorRevisionId}: ${reason}`);
  }
}

export interface CompileExecutablePlanInput {
  readonly behaviorRevisionId: BehaviorRevisionId;
  readonly personaRevisionId: PersonaRevisionId;
  readonly behaviorRevisionHash: RevisionDigest;
  readonly spec: AcceptanceSpecV1;
  readonly forgeProvenanceIds?: readonly string[];
  /** rv-3: resolved capability fragment refs, keyed by `capabilityMapKey`. A cited
   * capability absent from this map is an unresolved obligation ⇒ `missing_fragments`
   * (never a silently-dropped step). Empty/omitted when the spec cites no capability. */
  readonly resolvedFragments?: ReadonlyMap<string, CapabilityFragmentRef>;
}

/** A cited capability compiled into one plan step, or an unresolved obligation. */
interface CompiledSteps {
  readonly fixtures: FixtureStep[];
  readonly actions: ActionStep[];
  readonly cleanup: CleanupStep[];
  readonly obligations: MissingCapabilityObligation[];
}

/** A synthetic, deterministic source span pointing at the stored acceptance spec. */
function citationSpan(index: number): SourceSpan {
  return {
    sourcePath: "behavior_revisions.acceptance",
    startLine: index + 1,
    startColumn: 1,
    endLine: index + 1,
    endColumn: 1,
  };
}

/** Resolve every cited capability against the resolution map, binding each into its
 * plan lane or recording a `missing_fragments` obligation (rv-3). */
function compileCitedCapabilities(
  spec: AcceptanceSpecV1,
  resolved: ReadonlyMap<string, CapabilityFragmentRef>,
): CompiledSteps {
  const fixtures: FixtureStep[] = [];
  const actions: ActionStep[] = [];
  const cleanup: CleanupStep[] = [];
  const obligations: MissingCapabilityObligation[] = [];
  spec.capabilities.forEach((citation, index) => {
    const ref = resolved.get(capabilityMapKey(citation.fragmentKind, citation.capabilityKey));
    if (ref === undefined) {
      obligations.push({
        capability: citation.capabilityKey,
        fragmentKind: citation.fragmentKind,
        reason: `no registered verification fragment for ${citation.fragmentKind}:${citation.capabilityKey}`,
      });
      return;
    }
    const step = {
      id: citation.stepId,
      capabilityFragmentRef: ref,
      params: citation.params,
      sourceSpan: citationSpan(index),
    };
    if (citation.stepKind === "fixture") fixtures.push(step);
    else if (citation.stepKind === "action") actions.push(step);
    else cleanup.push(step);
  });
  return { fixtures, actions, cleanup, obligations };
}

function asFiniteNumber(value: CanonicalBody): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The named predicate a scalar-predicate assertion evaluates — the authored predicate string or the operator name. */
function predicateLabel(operator: "satisfies_predicate" | "matches" | "contains", expected: CanonicalBody): string {
  if (operator !== "contains" && typeof expected === "string") return expected;
  return operator;
}

/** A resolved assertion, or a re-spec obligation when the spec lacks an observable binding. */
type AssertionResolution = { readonly ok: AssertionExpression } | { readonly respec: string };

/**
 * The typed assertion DSL. Resolves one authored assertion into a concrete
 * {@link AssertionExpression}. Exhaustive over {@link ComparisonOperator}: the
 * `never` guard makes an unhandled operator a compile error.
 */
function resolveAssertion(behaviorRevisionId: string, assertion: AcceptanceSpecAssertion): AssertionResolution {
  const base = {
    assertionId: assertion.assertionId,
    subject: assertion.subject,
    expected: assertion.expected,
    comparisonOperator: assertion.comparisonOperator,
    redactionClass: "none" as RedactionClass,
  };
  const operator = assertion.comparisonOperator;
  switch (operator) {
    case "equals":
    case "not_equals":
    case "responds_with":
      return { ok: { ...base, kind: "scalar_equality" } };
    case "less_than":
    case "less_than_or_equal":
      return { ok: { ...base, kind: "scalar_order", order: "ascending" } };
    case "greater_than":
    case "greater_than_or_equal":
      return { ok: { ...base, kind: "scalar_order", order: "descending" } };
    case "between":
      return { ok: { ...base, kind: "scalar_range", inclusive: true } };
    case "matches_schema":
      return { ok: { ...base, kind: "scalar_schema", schema: assertion.expected } };
    case "satisfies_predicate":
    case "matches":
    case "contains":
      return { ok: { ...base, kind: "scalar_predicate", predicate: predicateLabel(operator, assertion.expected) } };
    case "has_cardinality": {
      const cardinality = asFiniteNumber(assertion.expected);
      if (cardinality === undefined) {
        return { respec: `assertion ${assertion.assertionId}: has_cardinality expects a finite numeric cardinality` };
      }
      return { ok: { ...base, kind: "set_cardinality", cardinality } };
    }
    case "is_unique":
      return { ok: { ...base, kind: "set_uniqueness" } };
    case "exactly_once":
      return { ok: { ...base, kind: "set_exactly_once", expectedOccurrence: assertion.expected } };
    case "not_contains":
    case "has_no_effect":
      // A negative assertion: the observed set must genuinely LACK the forbidden effect.
      return { ok: { ...base, kind: "negative", forbiddenEffect: assertion.subject } };
    case "eventually":
      // A temporal-eventual assertion needs a persisted provider cursor + delivery
      // watermark the flat acceptance spec does not carry — never guessed.
      return {
        respec: `assertion ${assertion.assertionId}: '${operator}' needs a provider cursor + watermark absent from the acceptance spec — re-spec required`,
      };
    case "before":
    case "after":
      return {
        respec: `assertion ${assertion.assertionId}: temporal '${operator}' needs a provider cursor + watermark absent from the acceptance spec — re-spec required`,
      };
    case "causes": {
      // A causal for-every assertion binds a driven trigger to its effect. The
      // trigger is the correlated cause; the effect is the assertion subject.
      if (assertion.correlation === undefined) {
        return {
          respec: `assertion ${assertion.assertionId}: 'causes' needs a correlation binding its trigger→effect — none authored`,
        };
      }
      return {
        ok: { ...base, kind: "causal_for_every", trigger: assertion.correlation.causeId, effect: assertion.subject },
      };
    }
    default: {
      const exhaustive: never = operator;
      throw new PlanCompileError(behaviorRevisionId, `unknown comparison operator ${String(exhaustive)}`);
    }
  }
}

/**
 * Compile a behavior revision's parsed acceptance spec into the canonical
 * executable plan. The result is one of the three {@link PlanCompileResult}
 * shapes — `compiled` with a hashed plan, or `needs_respec` when an assertion's
 * observable binding is not present (never a silently-degraded plan).
 */
export function compileExecutableBehaviorPlan(input: CompileExecutablePlanInput): PlanCompileResult {
  const { spec } = input;
  const assertions: AssertionExpression[] = [];
  const respecReasons: string[] = [];
  for (const authored of spec.assertions) {
    const resolved = resolveAssertion(input.behaviorRevisionId, authored);
    if ("respec" in resolved) respecReasons.push(resolved.respec);
    else assertions.push(resolved.ok);
  }
  if (respecReasons.length > 0) return { kind: "needs_respec", reasons: respecReasons };

  // rv-3: bind cited verification-capability fragments into the plan lanes. An
  // unresolved citation is a `missing_fragments` obligation the caller resolves via
  // the registry / F2 authoring — never a silently-dropped step.
  const steps = compileCitedCapabilities(spec, input.resolvedFragments ?? new Map());
  if (steps.obligations.length > 0) return { kind: "missing_fragments", obligations: steps.obligations };

  const requiredSurfaces: readonly RequiredSurface[] =
    spec.requiredSurfaces.length > 0 ? spec.requiredSurfaces : spec.httpProbes.length > 0 ? ["api"] : [];

  const provenance: PlanProvenance = {
    compilerVersion: EXECUTABLE_PLAN_COMPILER_VERSION,
    behaviorRevisionHash: input.behaviorRevisionHash,
    forgeProvenanceIds: input.forgeProvenanceIds ?? [],
  };

  // The plan body WITHOUT its id — the id is the domain hash of exactly this body,
  // so it is deterministic and cannot circularly include itself.
  const planBody = {
    version: "v1" as const,
    behaviorRevisionId: input.behaviorRevisionId,
    personaRevisionId: input.personaRevisionId,
    requiredSurfaces,
    fixtures: steps.fixtures,
    actions: steps.actions,
    assertions,
    cleanup: steps.cleanup,
    examples: spec.examples.map((example) => ({ values: example.values, rowHash: example.rowHash as Digest })),
    executionMatrix: toExecutionMatrix(spec.executionMatrix),
    designCheckpoints: [] as const,
    artifactPolicy: DEFAULT_ARTIFACT_POLICY,
    flakePolicy: DEFAULT_FLAKE_POLICY,
    provenance,
  };

  const digest: Digest = planHash(planBody as unknown as ExecutableBehaviorPlanCanonical);
  const plan: ExecutableBehaviorPlanV1 = { planId: digest as unknown as BehaviorVerificationPlanId, ...planBody };
  return { kind: "compiled", plan, planHash: digest };
}
