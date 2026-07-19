/**
 * rv-2: the STORED acceptance-spec parser + consistency gate. A behavior
 * revision's `behavior_revisions.acceptance` (a jsonb Record authored by the spec
 * pipeline) is validated here into a typed {@link AcceptanceSpecV1} before the
 * rv-2 executable-plan compiler resolves it into concrete assertion expressions.
 *
 * FAIL-CLOSED OR LOUD: a malformed/unparseable spec, a duplicate probe or
 * assertion id, an assertion that references no declared http probe, or a
 * correlation that references an undeclared cause throws
 * {@link MalformedAcceptanceSpecError}. It NEVER silently drops an assertion,
 * fabricates one, or degrades to an empty plan — parsing is the earliest place a
 * bad spec is caught, before a preview deploy + acceptance run is paid for.
 *
 * This is a leaf module (schema + pure validation only) so both the rv-2 compiler
 * and the rv-6 loader import it without a cycle.
 */

import { z } from "zod";
import type { CanonicalBody } from "../../contracts/cas.js";
import type { ComparisonOperator, ExecutionMatrix } from "../../contracts/runtimeVerificationPlan.js";

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
]) satisfies z.ZodType<ComparisonOperator>;
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

export type AcceptanceSpecV1 = z.infer<typeof acceptanceSpecSchema>;
export type AcceptanceSpecAssertion = AcceptanceSpecV1["assertions"][number];

export function toExecutionMatrix(raw: AcceptanceSpecV1["executionMatrix"]): ExecutionMatrix {
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

function firstIssue(behaviorRevisionId: string, error: z.ZodError): MalformedAcceptanceSpecError {
  const issue = error.issues[0];
  const path = issue === undefined || issue.path.length === 0 ? "<root>" : issue.path.join(".");
  const message = issue === undefined ? "invalid acceptance spec" : issue.message;
  return new MalformedAcceptanceSpecError(behaviorRevisionId, `${path}: ${message}`);
}

/**
 * Parse + fully validate a stored acceptance spec. Every consistency failure is
 * caught here — the compiler never receives a spec with duplicate ids, a dangling
 * probe reference, an undeclared correlation cause, or no observable surface.
 */
export function parseAcceptanceSpec(behaviorRevisionId: string, acceptance: unknown): AcceptanceSpecV1 {
  const parsed = acceptanceSpecSchema.safeParse(acceptance);
  if (!parsed.success) throw firstIssue(behaviorRevisionId, parsed.error);
  const spec = parsed.data;

  const declaredProbeIds = new Set<string>();
  for (const probe of spec.httpProbes) {
    if (declaredProbeIds.has(probe.probeId)) {
      throw new MalformedAcceptanceSpecError(behaviorRevisionId, `duplicate probe id ${probe.probeId}`);
    }
    declaredProbeIds.add(probe.probeId);
  }

  const declaredCauseIds = new Set<string>();
  for (const cause of spec.causes) {
    if (declaredCauseIds.has(cause.causeId)) {
      throw new MalformedAcceptanceSpecError(behaviorRevisionId, `duplicate cause id ${cause.causeId}`);
    }
    declaredCauseIds.add(cause.causeId);
  }

  // Fail EARLY on a duplicate assertion id — before a preview deploy + acceptance
  // run is paid for. A duplicate is otherwise only caught late by the verdict
  // store's count-evidence guard (assertVerdictCountEvidence), after the spend.
  const declaredAssertionIds = new Set<string>();
  for (const assertion of spec.assertions) {
    if (declaredAssertionIds.has(assertion.assertionId)) {
      throw new MalformedAcceptanceSpecError(behaviorRevisionId, `duplicate assertion id ${assertion.assertionId}`);
    }
    declaredAssertionIds.add(assertion.assertionId);
  }

  for (const assertion of spec.assertions) {
    if (assertion.correlation === undefined) {
      // A direct-observation assertion must reference a declared http probe via
      // its `<probeId>.<selector>` subject so the shipped api driver can observe it.
      const dot = assertion.subject.indexOf(".");
      const probeId = dot > 0 ? assertion.subject.slice(0, dot) : "";
      if (probeId === "" || !declaredProbeIds.has(probeId)) {
        throw new MalformedAcceptanceSpecError(
          behaviorRevisionId,
          `assertion ${assertion.assertionId} subject "${assertion.subject}" references no declared http probe`,
        );
      }
      continue;
    }
    // A correlated (rv-12 causal) assertion must reference a declared cause; a
    // dangling correlation would otherwise compile to an assertion that can never
    // execute against a driven cause (fail closed, not silently inconclusive).
    if (!declaredCauseIds.has(assertion.correlation.causeId)) {
      throw new MalformedAcceptanceSpecError(
        behaviorRevisionId,
        `assertion ${assertion.assertionId} correlation references undeclared cause ${assertion.correlation.causeId}`,
      );
    }
  }

  const hasSurface = spec.requiredSurfaces.length > 0 || spec.httpProbes.length > 0 || spec.causes.length > 0;
  if (!hasSurface) {
    throw new MalformedAcceptanceSpecError(
      behaviorRevisionId,
      "spec declares no required surface, http probe, or cause",
    );
  }

  return spec;
}
