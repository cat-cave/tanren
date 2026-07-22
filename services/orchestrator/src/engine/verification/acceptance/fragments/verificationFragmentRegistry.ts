// rv-3 — the verification-fragment REGISTRY ASSEMBLY + the registry-backed plan
// compile. This is the PRODUCTION consumer: it wires the family binding onto the
// shared SP-2 kernel and threads capability RESOLUTION + F2-ON-MISSING into the real
// plan-compile path (`PgAcceptancePlanLoader.compileAndBindAcceptancePlan`).
//
// The resolve → F2-on-missing call graph:
//   1. dedupe the spec's cited capabilities into unique `(kind, capability)` specs;
//   2. `store.resolveByCapability` each — a hit binds the concrete version ref;
//   3. a MISS with NO authoring seam → HALT LOUD (`VerificationFragmentAuthoringFailedError`);
//   4. a MISS with an authoring seam → run the shared kernel (writer→validate,
//      fixed-point convergent, no retry cap); a `failedIds` result → HALT LOUD; a
//      success registers + versions the fragment (in the kernel's atomic persistence)
//      and binds the validated ref;
//   5. the rv-2 compiler binds every resolved ref into the plan lanes; the durable
//      `verification_plan_fragments` binding is recorded. A still-unresolved capability
//      is NEVER a silently-dropped step — the compiler returns `missing_fragments` and
//      the loader throws.

import { createAuthoringKernel } from "../../../authoring/authoringKernelRunner.js";
import type {
  AuthoringAuthorer,
  AuthoringEvents,
  AuthoringFamilyBinding,
  AuthoringKernel,
  AuthoringKernelResult,
  AuthoringPersistence,
} from "../../../contracts/authoringKernel.js";
import { parseDigest } from "../../../contracts/cas.js";
import { parseBehaviorRevisionId, parsePersonaRevisionId } from "../../../contracts/behaviorRevision.js";
import type { CapabilityFragmentRef } from "../../../contracts/runtimeVerificationPlan.js";
import type {
  VerificationFragmentStore,
  PlanFragmentBinding,
} from "../../../repositories/verificationFragmentStore.js";
import type { AcceptancePlan } from "../orchestrator.js";
import type { AcceptanceEventSink } from "../eventSink.js";
import {
  AcceptancePlanNotExecutableError,
  toAcceptancePlan,
  type CompileAcceptancePlanRevision,
} from "../planLoader.js";
import { parseAcceptanceSpec } from "../acceptanceSpec.js";
import { compileExecutableBehaviorPlan } from "../executablePlanCompiler.js";
import {
  capabilityMapKey,
  toCapabilityFragmentRef,
  verificationFragmentUnitId,
  parseVerificationFragmentAuthoringContext,
  type ValidatedVerificationFragment,
  type VerificationCapabilityCitation,
  type VerificationFragmentDraftV1,
  type VerificationFragmentSpecV1,
} from "./verificationFragment.js";
import { verificationFragmentSignatures } from "./verificationFragmentAuthorer.js";
import {
  buildVerificationFragmentBatchCompose,
  buildVerificationFragmentValidator,
} from "./verificationFragmentValidation.js";
import type { VerificationFragmentAuthoringEvent } from "./verificationFragmentEvents.js";

type Binding = AuthoringFamilyBinding<
  VerificationFragmentSpecV1,
  VerificationFragmentDraftV1,
  ValidatedVerificationFragment,
  VerificationFragmentAuthoringEvent
>;

type Kernel = AuthoringKernel<
  VerificationFragmentSpecV1,
  VerificationFragmentDraftV1,
  ValidatedVerificationFragment,
  VerificationFragmentAuthoringEvent
>;

/** Loud halt when the F2 loop cannot produce a valid fragment for every missing
 * capability — or when a capability is missing and NO authoring seam exists. NEVER a
 * silent skip or a vacuous plan. Mirrors `DesignFragmentAuthoringFailedError`. */
export class VerificationFragmentAuthoringFailedError extends Error {
  public override readonly name = "VerificationFragmentAuthoringFailedError";
  public constructor(
    public readonly failedIds: readonly string[],
    public readonly failureReasons: Readonly<Record<string, string>> = {},
  ) {
    super(`verification fragment authoring failed for: ${failedIds.join(", ") || "<none>"}`);
  }
}

/** The production loader always supplies the canonical event sink. A missing sink
 * at an emit point is a wiring defect, never permission to silently erase facts. */
export class VerificationFragmentEventSinkRequiredError extends Error {
  public override readonly name = "VerificationFragmentEventSinkRequiredError";

  public constructor() {
    super("verification fragment event sink is required when emitting lifecycle events");
  }
}

/** The dependencies a live F2 authoring run is built with. */
export interface VerificationFragmentAuthoringDeps {
  /** The writer seam — production wires the provider answerer (real LLM); tests inject
   * a deterministic fixture through the SAME seam. */
  readonly authorer: AuthoringAuthorer<VerificationFragmentSpecV1, VerificationFragmentDraftV1>;
  /** The org-scoped registry store (atomic persist + retract + present listing). */
  readonly store: VerificationFragmentStore;
  /** The frozen `behavior.fragment.*` event factory + EventStore sink. */
  readonly events: AuthoringEvents<
    VerificationFragmentSpecV1,
    VerificationFragmentDraftV1,
    ValidatedVerificationFragment,
    VerificationFragmentAuthoringEvent
  >;
  /** The shared kernel (default: a fresh `createAuthoringKernel`). */
  readonly kernel?: Kernel;
}

/** Build the per-run family binding (closes over the resolved context so the atomic
 * persistence + RLS-scoped retract carry the org/project). */
export function buildVerificationFragmentAuthoringBinding(
  deps: VerificationFragmentAuthoringDeps,
  context: { readonly orgId: string; readonly projectId: string; readonly createdBy: string },
): Binding {
  const persistence: AuthoringPersistence<
    VerificationFragmentSpecV1,
    VerificationFragmentDraftV1,
    ValidatedVerificationFragment
  > = {
    async createValidated(input): Promise<{ persistedId: string }> {
      return deps.store.createValidated({
        orgId: context.orgId,
        projectId: context.projectId,
        createdBy: context.createdBy,
        fragment: input.validated,
      });
    },
    async deleteById(persistedId): Promise<void> {
      await deps.store.deleteById(context.orgId, persistedId);
    },
  };
  return {
    familyId: "rv-3",
    unitId: verificationFragmentUnitId,
    authorer: deps.authorer,
    validator: buildVerificationFragmentValidator(),
    persistence,
    batchCompose: buildVerificationFragmentBatchCompose({
      loadPresent: () => deps.store.listPresent(context.orgId, context.projectId),
    }),
    signatures: verificationFragmentSignatures,
    events: deps.events,
  };
}

/** Author every missing capability through the shared kernel. */
export async function runVerificationFragmentAuthoring(input: {
  readonly missing: readonly VerificationFragmentSpecV1[];
  readonly context: unknown;
  readonly deps: VerificationFragmentAuthoringDeps;
}): Promise<AuthoringKernelResult<ValidatedVerificationFragment>> {
  const context = parseVerificationFragmentAuthoringContext(input.context);
  const binding = buildVerificationFragmentAuthoringBinding(input.deps, {
    orgId: context.orgId,
    projectId: context.projectId,
    createdBy: context.createdBy,
  });
  const kernel =
    input.deps.kernel ??
    createAuthoringKernel<
      VerificationFragmentSpecV1,
      VerificationFragmentDraftV1,
      ValidatedVerificationFragment,
      VerificationFragmentAuthoringEvent
    >();
  return kernel.run({ missing: input.missing, context }, binding);
}

/** Dedupe cited capabilities into unique `(kind, capability, surface)` authoring specs. */
function uniqueSpecs(capabilities: readonly VerificationCapabilityCitation[]): VerificationFragmentSpecV1[] {
  const seen = new Set<string>();
  const specs: VerificationFragmentSpecV1[] = [];
  for (const citation of capabilities) {
    const key = capabilityMapKey(citation.fragmentKind, citation.capabilityKey);
    if (seen.has(key)) continue;
    seen.add(key);
    specs.push({
      capabilityKey: citation.capabilityKey,
      fragmentKind: citation.fragmentKind,
      surface: citation.surface,
    });
  }
  return specs;
}

/** The optional F2 authoring seam a caller enables to author missing capabilities. */
export interface PlanCapabilityAuthoring {
  readonly deps: VerificationFragmentAuthoringDeps;
  readonly createdBy?: string;
}

/** Resolve every cited capability against the registry, F2-authoring the missing set
 * (fail-closed). Returns the resolution map the rv-2 compiler binds into the plan. */
export async function resolvePlanCapabilities(input: {
  readonly orgId: string;
  readonly projectId: string;
  readonly behaviorRevisionId: string;
  readonly capabilities: readonly VerificationCapabilityCitation[];
  readonly store: VerificationFragmentStore;
  readonly events: AcceptanceEventSink;
  readonly authoring?: PlanCapabilityAuthoring;
}): Promise<ReadonlyMap<string, CapabilityFragmentRef>> {
  const resolved = new Map<string, CapabilityFragmentRef>();
  const specs = uniqueSpecs(input.capabilities);
  if (specs.length === 0) return resolved;

  const missing: VerificationFragmentSpecV1[] = [];
  for (const spec of specs) {
    const ref = await input.store.resolveByCapability({
      orgId: input.orgId,
      projectId: input.projectId,
      capabilityKey: spec.capabilityKey,
      fragmentKind: spec.fragmentKind,
    });
    if (ref === undefined) missing.push(spec);
    else resolved.set(capabilityMapKey(spec.fragmentKind, spec.capabilityKey), ref);
  }
  if (missing.length === 0) return resolved;
  if (input.events === undefined) throw new VerificationFragmentEventSinkRequiredError();

  // These are durable facts about the exact missing capability set, before any
  // authoring can change it. An append failure aborts resolution: observability
  // must not report an authored fragment without its missing predecessor.
  for (const spec of missing) {
    await input.events.append({
      orgId: input.orgId,
      projectId: input.projectId,
      eventType: "behavior.fragment.missing",
      payload: { behaviorRevisionId: input.behaviorRevisionId, capability: spec.fragmentKind },
    });
  }

  // Missing capabilities — fail-closed if no authoring seam, else F2-author them.
  if (input.authoring === undefined) {
    throw new VerificationFragmentAuthoringFailedError(missing.map((spec) => verificationFragmentUnitId(spec)));
  }

  const createdBy = input.authoring.createdBy ?? "tanren.rv3";
  const result = await runVerificationFragmentAuthoring({
    missing,
    context: {
      orgId: input.orgId,
      projectId: input.projectId,
      behaviorRevisionId: input.behaviorRevisionId,
      createdBy,
    },
    deps: input.authoring.deps,
  });
  if (result.failedIds.length > 0) {
    throw new VerificationFragmentAuthoringFailedError(result.failedIds, result.failureReasons);
  }
  for (const validated of result.validated) {
    resolved.set(capabilityMapKey(validated.fragmentKind, validated.capabilityKey), toCapabilityFragmentRef(validated));
  }
  // Defense-in-depth: every missing capability MUST now resolve (never a silent gap).
  const stillMissing = missing.filter((spec) => !resolved.has(capabilityMapKey(spec.fragmentKind, spec.capabilityKey)));
  if (stillMissing.length > 0) {
    throw new VerificationFragmentAuthoringFailedError(stillMissing.map((spec) => verificationFragmentUnitId(spec)));
  }
  return resolved;
}

/** Compile one behavior revision's stored acceptance spec into the narrow executable
 * plan, RESOLVING every cited verification-capability fragment from the registry (or
 * F2-authoring it, fail-closed) and BINDING the resolved refs into the plan +
 * recording the durable `verification_plan_fragments` binding. The registry-backed
 * async analog of `compileAcceptancePlan`. */
export async function compileAndBindAcceptancePlan(input: {
  readonly revision: CompileAcceptancePlanRevision;
  readonly orgId: string;
  readonly projectId: string;
  readonly store: VerificationFragmentStore;
  /** Required: compilation lifecycle facts must never silently disappear. */
  readonly events: AcceptanceEventSink;
  readonly authoring?: PlanCapabilityAuthoring;
}): Promise<AcceptancePlan> {
  if (input.events === undefined) throw new VerificationFragmentEventSinkRequiredError();
  const { revision } = input;
  await input.events.append({
    orgId: input.orgId,
    projectId: input.projectId,
    eventType: "behavior.contract.compilation_started",
    payload: { behaviorRevisionId: revision.id, behaviorRevisionHash: revision.behaviorRevisionHash },
  });

  let spec: ReturnType<typeof parseAcceptanceSpec>;
  try {
    spec = parseAcceptanceSpec(revision.id, revision.acceptance);
  } catch (error) {
    await input.events.append({
      orgId: input.orgId,
      projectId: input.projectId,
      eventType: "behavior.contract.rejected",
      payload: {
        behaviorRevisionId: revision.id,
        behaviorRevisionHash: revision.behaviorRevisionHash,
        reason: eventReason(error),
      },
    });
    throw error;
  }

  const resolvedFragments = await resolvePlanCapabilities({
    orgId: input.orgId,
    projectId: input.projectId,
    behaviorRevisionId: revision.id,
    capabilities: spec.capabilities,
    store: input.store,
    events: input.events,
    ...(input.authoring === undefined ? {} : { authoring: input.authoring }),
  });

  const result = compileExecutableBehaviorPlan({
    behaviorRevisionId: parseBehaviorRevisionId(revision.id),
    personaRevisionId: parsePersonaRevisionId(revision.personaRevisionId),
    behaviorRevisionHash: parseDigest(revision.behaviorRevisionHash),
    spec,
    resolvedFragments,
  });
  if (result.kind === "needs_respec") {
    const reason = eventReason(result.reasons.join("; "));
    await input.events.append({
      orgId: input.orgId,
      projectId: input.projectId,
      eventType: "behavior.respec.requested",
      payload: { behaviorRevisionId: revision.id, reason },
    });
    throw new AcceptancePlanNotExecutableError(revision.id, `needs re-spec: ${result.reasons.join("; ")}`);
  }
  if (result.kind === "missing_fragments") {
    // Fail-closed: resolution/authoring already ran, so a residual obligation is a
    // real unresolved capability — never a silently-empty plan.
    const missing = result.obligations.map((obligation) => obligation.capability).join(", ");
    throw new AcceptancePlanNotExecutableError(revision.id, `missing fragments: ${missing}`);
  }

  if (result.plan.assertions.length === 0) {
    const reason = "compiled plan has no assertions";
    await input.events.append({
      orgId: input.orgId,
      projectId: input.projectId,
      eventType: "behavior.contract.rejected",
      payload: { behaviorRevisionId: revision.id, behaviorRevisionHash: revision.behaviorRevisionHash, reason },
    });
    throw new AcceptancePlanNotExecutableError(revision.id, reason);
  }

  // Bind the resolved fragments into the plan durably (idempotent upsert).
  const bindings: PlanFragmentBinding[] = [...result.plan.fixtures, ...result.plan.actions, ...result.plan.cleanup].map(
    (step) => ({
      stepId: step.id,
      fragmentVersionId: step.capabilityFragmentRef.fragmentVersionId,
      sourceSpan: step.sourceSpan,
    }),
  );
  if (bindings.length > 0) {
    await input.store.bindPlan({
      orgId: input.orgId,
      projectId: input.projectId,
      planId: result.plan.planId,
      behaviorRevisionId: revision.id,
      compilerVersion: result.plan.provenance.compilerVersion,
      planHash: result.planHash,
      status: "compiled",
      planJson: result.plan,
      unresolvedCapabilities: [],
      provenance: result.plan.provenance,
      bindings,
    });
  }

  await input.events.append({
    orgId: input.orgId,
    projectId: input.projectId,
    eventType: "behavior.contract.compiled",
    payload: {
      behaviorRevisionId: revision.id,
      behaviorRevisionHash: revision.behaviorRevisionHash,
      planHash: result.planHash,
      assertionCount: result.plan.assertions.length,
      surfaceKinds: [...result.plan.requiredSurfaces],
    },
  });

  return toAcceptancePlan(result.plan, spec);
}

function eventReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const trimmed = raw.trim();
  return (trimmed.length === 0 ? "unclassified compilation failure" : trimmed).slice(0, 200);
}
