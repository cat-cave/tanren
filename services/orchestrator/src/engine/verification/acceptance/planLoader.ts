/**
 * rv-6 A2: the acceptance-plan LOADER. It compiles a behavior revision's STORED
 * acceptance spec (`behavior_revisions.acceptance`, a jsonb Record authored by
 * the spec pipeline) into the executable {@link AcceptancePlan} the rv-11
 * orchestrator runs.
 *
 * FAITHFUL OR LOUD: every stored assertion becomes a real plan assertion with
 * its exact subject / operator / expected (and rv-12 correlation). A malformed
 * or unparseable spec throws {@link MalformedAcceptanceSpecError} — it NEVER
 * silently drops an assertion, fabricates one, or degrades to an empty plan.
 * Every non-causal assertion must reference a declared HTTP probe, so the
 * compiled plan is genuinely executable by the shipped api driver rather than
 * compiling to a shape that can only ever go inconclusive.
 */

import { z } from "zod";
import { domainHash, type CanonicalBody, type Digest } from "../../contracts/cas.js";
import type { BehaviorRevision } from "../../contracts/behaviorRevision.js";
import type { ExecutionMatrix, RequiredSurface } from "../../contracts/runtimeVerificationPlan.js";
import type { AcceptanceAssertion, AcceptancePlan, HttpProbeSpec } from "./orchestrator.js";
import type { CauseSpec } from "./causalCorrelation.js";

export class MalformedAcceptanceSpecError extends Error {
  public override readonly name = "MalformedAcceptanceSpecError";

  public constructor(
    public readonly behaviorRevisionId: string,
    public readonly reason: string,
  ) {
    super(`malformed acceptance spec for behavior revision ${behaviorRevisionId}: ${reason}`);
  }
}

const surface = z.enum(["browser", "api", "cli", "package", "app_channel", "external_integration", "mobile"]);
const comparisonOperator = z.enum([
  "equals",
  "not_equals",
  "less_than",
  "less_than_or_equal",
  "greater_than",
  "greater_than_or_equal",
  "between",
  "matches_schema",
  "satisfies_predicate",
  "contains",
  "not_contains",
  "has_cardinality",
  "is_unique",
  "exactly_once",
  "eventually",
  "before",
  "after",
  "causes",
  "responds_with",
  "matches",
  "has_no_effect",
]);
const canonical: z.ZodType<CanonicalBody> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number(), z.string(), z.array(canonical), z.record(z.string(), canonical)]),
);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);

const correlationSchema = z.object({
  causeId: z.string().min(1),
  observer: z.string().min(1),
  provider: z.string().min(1),
  requireCorrelationId: z.boolean(),
});
const httpProbeSchema = z.object({
  probeId: z.string().min(1),
  method: z.string().min(1),
  path: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
  body: canonical.optional(),
});
const assertionSchema = z.object({
  assertionId: z.string().min(1),
  subject: z.string().min(1),
  comparisonOperator,
  expected: canonical,
  correlation: correlationSchema.optional(),
});
const causeSchema = z.object({
  causeId: z.string().min(1),
  surface,
  action: z.string().min(1),
});
const exampleSchema = z.object({
  values: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])),
  rowHash: digest,
});
const matrixSchema = z
  .object({
    browser: z.array(z.string()).optional(),
    viewport: z.array(z.string()).optional(),
    locale: z.array(z.string()).optional(),
    theme: z.array(z.string()).optional(),
    motion: z.array(z.string()).optional(),
    contrast: z.array(z.string()).optional(),
    device: z.array(z.string()).optional(),
  })
  .default({});

const visualVerificationSchema = z.object({
  required: z.boolean(),
  accessibilityStandard: z.string().min(1).optional(),
});

const acceptanceSpecSchema = z.object({
  version: z.literal("v1").optional(),
  requiredSurfaces: z.array(surface).default([]),
  httpProbes: z.array(httpProbeSchema).default([]),
  assertions: z.array(assertionSchema).min(1),
  fixtures: z.array(z.unknown()).default([]),
  examples: z.array(exampleSchema).default([]),
  executionMatrix: matrixSchema,
  causes: z.array(causeSchema).default([]),
  // rv-13 A4: an OPTIONAL rendered-visual requirement — when `required`, the behavior
  // demands a passing ds-4 design-render verdict on top of its functional assertions.
  visualVerification: visualVerificationSchema.optional(),
});

type AcceptanceSpecV1 = z.infer<typeof acceptanceSpecSchema>;

function toExecutionMatrix(raw: AcceptanceSpecV1["executionMatrix"]): ExecutionMatrix {
  return {
    browser: raw.browser ?? [],
    viewport: raw.viewport ?? [],
    locale: raw.locale ?? [],
    theme: raw.theme ?? [],
    motion: raw.motion ?? [],
    contrast: raw.contrast ?? [],
    device: raw.device ?? [],
  };
}

function toAssertion(raw: AcceptanceSpecV1["assertions"][number]): AcceptanceAssertion {
  return {
    assertionId: raw.assertionId,
    subject: raw.subject,
    comparisonOperator: raw.comparisonOperator,
    expected: raw.expected,
    ...(raw.correlation === undefined ? {} : { correlation: raw.correlation }),
  };
}

function firstIssue(behaviorRevisionId: string, error: z.ZodError): MalformedAcceptanceSpecError {
  const issue = error.issues[0];
  const path = issue === undefined || issue.path.length === 0 ? "<root>" : issue.path.join(".");
  const message = issue === undefined ? "invalid acceptance spec" : issue.message;
  return new MalformedAcceptanceSpecError(behaviorRevisionId, `${path}: ${message}`);
}

/**
 * Compile one behavior revision's stored acceptance spec into an executable
 * plan. Throws {@link MalformedAcceptanceSpecError} on any parse/consistency
 * failure — the caller must never receive a partially-dropped or empty plan.
 */
export function compileAcceptancePlan(revision: Pick<BehaviorRevision, "id" | "acceptance">): AcceptancePlan {
  const parsed = acceptanceSpecSchema.safeParse(revision.acceptance);
  if (!parsed.success) throw firstIssue(revision.id, parsed.error);
  const spec = parsed.data;

  const httpProbes: readonly HttpProbeSpec[] = spec.httpProbes.map((probe) => ({
    probeId: probe.probeId,
    method: probe.method,
    path: probe.path,
    ...(probe.headers === undefined ? {} : { headers: probe.headers }),
    ...(probe.body === undefined ? {} : { body: probe.body }),
  }));

  const probeIds = new Set(httpProbes.map((probe) => probe.probeId));
  const declaredProbeIds = new Set<string>();
  for (const probe of spec.httpProbes) {
    if (declaredProbeIds.has(probe.probeId)) {
      throw new MalformedAcceptanceSpecError(revision.id, `duplicate probe id ${probe.probeId}`);
    }
    declaredProbeIds.add(probe.probeId);
  }

  for (const assertion of spec.assertions) {
    if (assertion.correlation !== undefined) continue;
    const dot = assertion.subject.indexOf(".");
    const probeId = dot > 0 ? assertion.subject.slice(0, dot) : "";
    if (probeId === "" || !probeIds.has(probeId)) {
      throw new MalformedAcceptanceSpecError(
        revision.id,
        `assertion ${assertion.assertionId} subject "${assertion.subject}" references no declared http probe`,
      );
    }
  }

  const requiredSurfaces: readonly RequiredSurface[] =
    spec.requiredSurfaces.length > 0 ? spec.requiredSurfaces : httpProbes.length > 0 ? ["api"] : [];
  if (requiredSurfaces.length === 0 && spec.causes.length === 0) {
    throw new MalformedAcceptanceSpecError(revision.id, "spec declares no required surface, http probe, or cause");
  }

  const causes = spec.causes as readonly CauseSpec[];
  const planId = domainHash("plan.v1", {
    behaviorRevisionId: revision.id,
    assertionIds: spec.assertions.map((assertion) => assertion.assertionId),
  });

  return {
    planId,
    behaviorRevisionId: revision.id,
    requiredSurfaces,
    assertions: spec.assertions.map(toAssertion),
    fixtures: spec.fixtures,
    examples: spec.examples.map((example) => ({ values: example.values, rowHash: example.rowHash as Digest })),
    executionMatrix: toExecutionMatrix(spec.executionMatrix),
    causes,
    httpProbes,
    ...(spec.visualVerification === undefined ? {} : { visualVerification: spec.visualVerification }),
  };
}
