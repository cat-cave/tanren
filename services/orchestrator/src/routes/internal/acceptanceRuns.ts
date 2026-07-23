import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { CanonicalBody, Digest } from "../../engine/contracts/cas.js";
import type { MtlsPeerVerifier } from "../../engine/contracts/mtlsChannel.js";
import type { ExecutionMatrix, RequiredSurface } from "../../engine/contracts/runtimeVerificationPlan.js";
import { PgFixtureLeaseAdapter } from "../../engine/verification/fixtureLease/index.js";
import {
  AcceptanceOrchestrator,
  BrowserAcceptanceSurfaceDriver,
  buildPodmanBrowserClickRunner,
  HttpAcceptanceSurfaceDriver,
  PgAcceptanceEventSink,
  PgAcceptancePlanLoader,
  PgAcceptanceRunStore,
  PgReleaseInstanceBaseUrlResolver,
  PgVerificationCaptureStore,
  type AcceptanceAssertion,
  type AcceptanceCauseDriver,
  type AcceptancePlan,
  type AcceptancePlanLoader,
  type AcceptanceSurfaceDriver,
  type CausalEffectReader,
  type CauseSpec,
  type ClickInteractionSpec,
  type HttpProbeSpec,
} from "../../engine/verification/acceptance/index.js";
import { PgCausalEffectReader } from "../../engine/verification/effectObserver/pgCausalEffectReader.js";
import { PgCasByteStore } from "../../engine/cas/pgCasByteStore.js";
import { verifyInternalPeer } from "./internalWriteShared.js";

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const surface = z.enum(["browser", "api", "cli", "package", "app_channel", "external_integration", "mobile"]);
// The full ComparisonOperator algebra — an UNKNOWN operator is rejected (400) at
// the boundary rather than silently falling through to a deepEqual default.
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

const correlationSchema = z.object({
  causeId: z.string().min(1),
  observer: z.string().min(1),
  provider: z.string().min(1),
  requireCorrelationId: z.boolean(),
});
const assertionSchema = z.object({
  assertionId: z.string().min(1),
  subject: z.string().min(1),
  comparisonOperator,
  expected: canonical,
  // rv-12: present ⇒ a causal cardinality assertion over correlated rv-8 effects.
  correlation: correlationSchema.optional(),
});
const causeSchema = z.object({
  causeId: z.string().min(1),
  surface,
  action: z.string().min(1),
});
// rv-6: the HTTP requests the api surface driver fires to observe subjects.
const httpProbeSchema = z.object({
  probeId: z.string().min(1),
  method: z.string().min(1),
  path: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
  body: canonical.optional(),
});
// rv-26.6: the interactive clicks the browser surface driver performs.
const clickInteractionSchema = z.object({
  interactionId: z.string().min(1),
  selector: z.string().min(1),
  clicks: z.number().int().positive(),
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
const planSchema = z
  .object({
    planId: z.string().min(1),
    behaviorRevisionId: z.string().min(1),
    // rv-12: a purely causal plan drives its causes (not surface drivers), so
    // requiredSurfaces may be empty when `causes` carry the work.
    requiredSurfaces: z.array(surface).default([]),
    assertions: z.array(assertionSchema),
    fixtures: z.array(z.unknown()).default([]),
    examples: z.array(exampleSchema).default([]),
    executionMatrix: matrixSchema,
    causes: z.array(causeSchema).default([]),
    httpProbes: z.array(httpProbeSchema).default([]),
    clickInteractions: z.array(clickInteractionSchema).default([]),
  })
  .refine((plan) => plan.requiredSurfaces.length > 0 || plan.causes.length > 0, {
    message: "a plan must declare at least one required surface or one cause",
  });
const executeSchema = z.object({
  orgId: z.string().min(1),
  projectId: z.string().min(1),
  integrationNodeId: z.string().min(1),
  environmentId: z.string().min(1),
  preparedHeadSha: z.string().min(1),
  jjTreeId: z.string().min(1),
  artifactDigest: digest,
  deploymentFingerprint: z.string().min(1),
  purpose: z
    .enum(["per_iteration", "pre_audit", "pre_merge", "release_periodic", "post_merge_production", "manual_canary"])
    .optional(),
  specId: z.string().min(1).optional(),
  externalRunId: z.string().min(1).optional(),
  runtimeBehaviorContextHash: digest.optional(),
  plans: z.array(planSchema).min(1),
});

// rv-6: run acceptance for stored behaviors — the plans are LOADED from each
// behavior revision's persisted acceptance spec, not supplied by the caller.
const executeBehaviorsSchema = z.object({
  orgId: z.string().min(1),
  projectId: z.string().min(1),
  integrationNodeId: z.string().min(1),
  environmentId: z.string().min(1),
  preparedHeadSha: z.string().min(1),
  jjTreeId: z.string().min(1),
  artifactDigest: digest,
  deploymentFingerprint: z.string().min(1),
  purpose: z
    .enum(["per_iteration", "pre_audit", "pre_merge", "release_periodic", "post_merge_production", "manual_canary"])
    .optional(),
  specId: z.string().min(1).optional(),
  externalRunId: z.string().min(1).optional(),
  runtimeBehaviorContextHash: digest.optional(),
  behaviorRevisionIds: z.array(z.string().min(1)).min(1),
});

function toExecutionMatrix(raw: z.infer<typeof matrixSchema>): ExecutionMatrix {
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

function toAssertion(raw: z.infer<typeof assertionSchema>): AcceptanceAssertion {
  return {
    assertionId: raw.assertionId,
    subject: raw.subject,
    comparisonOperator: raw.comparisonOperator,
    expected: raw.expected,
    ...(raw.correlation === undefined ? {} : { correlation: raw.correlation }),
  };
}

function toPlan(raw: z.infer<typeof planSchema>): AcceptancePlan {
  return {
    planId: raw.planId,
    behaviorRevisionId: raw.behaviorRevisionId,
    requiredSurfaces: raw.requiredSurfaces as readonly RequiredSurface[],
    assertions: raw.assertions.map(toAssertion),
    fixtures: raw.fixtures,
    examples: raw.examples.map((example) => ({ values: example.values, rowHash: example.rowHash as Digest })),
    executionMatrix: toExecutionMatrix(raw.executionMatrix),
    causes: raw.causes as readonly CauseSpec[],
    httpProbes: raw.httpProbes as readonly HttpProbeSpec[],
    clickInteractions: raw.clickInteractions as readonly ClickInteractionSpec[],
  };
}

export interface AcceptanceRunRouteDeps {
  readonly pool: pg.Pool;
  readonly verifier: MtlsPeerVerifier;
  /**
   * rv-6 surface drivers. Defaults to the concrete HTTP/api driver over the
   * project's deployed release-instance URL, so a prod run produces a REAL
   * behavior verdict instead of fail-closing on an empty registry.
   */
  readonly drivers?: readonly AcceptanceSurfaceDriver[];
  /** rv-12 cause drivers; empty ⇒ causal assertions fail closed (no cause fired). */
  readonly causeDrivers?: readonly AcceptanceCauseDriver[];
  /** rv-12 effect reader; defaults to the rv-8 Postgres evidence over deps.pool. */
  readonly effectReader?: CausalEffectReader;
  /** rv-6 plan loader; defaults to compiling stored `behavior_revisions.acceptance`. */
  readonly planLoader?: AcceptancePlanLoader;
}

/** mTLS-only surface to trigger an A1 acceptance run and read its recorded verdicts. */
export function createInternalAcceptanceRunRoutes(deps: AcceptanceRunRouteDeps): Hono {
  const store = new PgAcceptanceRunStore(deps.pool);
  // rv-6: replace the empty registry with the real HTTP/api driver so prod
  // acceptance runs observe the deployed product instead of going inconclusive.
  const drivers: readonly AcceptanceSurfaceDriver[] = deps.drivers ?? [
    new HttpAcceptanceSurfaceDriver({ resolveBaseUrl: new PgReleaseInstanceBaseUrlResolver(deps.pool) }),
    // rv-26.6: the interactive browser click driver, over the SAME deployed
    // release URL, driving REAL clicks in the containerized Playwright chromium. A
    // browser-surface plan's `<id>.clickCount` assertion observes a REAL confirmed count.
    new BrowserAcceptanceSurfaceDriver({
      resolveBaseUrl: new PgReleaseInstanceBaseUrlResolver(deps.pool),
      runner: buildPodmanBrowserClickRunner(),
      events: new PgAcceptanceEventSink(deps.pool),
    }),
  ];
  const planLoader: AcceptancePlanLoader = deps.planLoader ?? new PgAcceptancePlanLoader(deps.pool);
  // rv-9: content-addressed capture store over the SP-3 CAS byte store, so a real
  // prod acceptance run content-addresses its response/render captures into
  // verification_artifacts instead of discarding them.
  const renderCapture = new PgVerificationCaptureStore(deps.pool, new PgCasByteStore(deps.pool));
  const orchestrator = new AcceptanceOrchestrator({
    store,
    events: new PgAcceptanceEventSink(deps.pool),
    fixtureLease: new PgFixtureLeaseAdapter(deps.pool),
    drivers,
    renderCapture,
    ...(deps.causeDrivers === undefined ? {} : { causeDrivers: deps.causeDrivers }),
    effectReader: deps.effectReader ?? new PgCausalEffectReader(deps.pool),
  });
  const app = new Hono();

  app.post("/internal/acceptance-runs/execute", async (c) => {
    if (!verifyInternalPeer(deps.verifier, c)) return c.json({ error: "untrusted_peer" }, 401);
    const parsed = executeSchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) return c.json({ error: "invalid_acceptance_run", issues: parsed.error.issues }, 400);
    const result = await orchestrator.execute({
      orgId: parsed.data.orgId,
      projectId: parsed.data.projectId,
      integrationNodeId: parsed.data.integrationNodeId,
      environmentId: parsed.data.environmentId,
      preparedHeadSha: parsed.data.preparedHeadSha,
      jjTreeId: parsed.data.jjTreeId,
      artifactDigest: parsed.data.artifactDigest as Digest,
      deploymentFingerprint: parsed.data.deploymentFingerprint,
      ...(parsed.data.purpose === undefined ? {} : { purpose: parsed.data.purpose }),
      ...(parsed.data.specId === undefined ? {} : { specId: parsed.data.specId }),
      ...(parsed.data.externalRunId === undefined ? {} : { externalRunId: parsed.data.externalRunId }),
      ...(parsed.data.runtimeBehaviorContextHash === undefined
        ? {}
        : { runtimeBehaviorContextHash: parsed.data.runtimeBehaviorContextHash as Digest }),
      plans: parsed.data.plans.map(toPlan),
    });
    return c.json({ result }, 201);
  });

  app.post("/internal/acceptance-runs/execute-behaviors", async (c) => {
    if (!verifyInternalPeer(deps.verifier, c)) return c.json({ error: "untrusted_peer" }, 401);
    const parsed = executeBehaviorsSchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) return c.json({ error: "invalid_acceptance_run", issues: parsed.error.issues }, 400);
    let plans: readonly AcceptancePlan[];
    try {
      plans = await planLoader.loadPlans({
        orgId: parsed.data.orgId,
        behaviorRevisionIds: parsed.data.behaviorRevisionIds,
      });
    } catch (error) {
      // A missing revision or a malformed stored acceptance spec fails loud — the
      // run never proceeds on a fabricated or silently-empty plan.
      return c.json({ error: "acceptance_plan_load_failed", reason: (error as Error).message }, 422);
    }
    const result = await orchestrator.execute({
      orgId: parsed.data.orgId,
      projectId: parsed.data.projectId,
      integrationNodeId: parsed.data.integrationNodeId,
      environmentId: parsed.data.environmentId,
      preparedHeadSha: parsed.data.preparedHeadSha,
      jjTreeId: parsed.data.jjTreeId,
      artifactDigest: parsed.data.artifactDigest as Digest,
      deploymentFingerprint: parsed.data.deploymentFingerprint,
      ...(parsed.data.purpose === undefined ? {} : { purpose: parsed.data.purpose }),
      ...(parsed.data.specId === undefined ? {} : { specId: parsed.data.specId }),
      ...(parsed.data.externalRunId === undefined ? {} : { externalRunId: parsed.data.externalRunId }),
      ...(parsed.data.runtimeBehaviorContextHash === undefined
        ? {}
        : { runtimeBehaviorContextHash: parsed.data.runtimeBehaviorContextHash as Digest }),
      plans,
    });
    return c.json({ result }, 201);
  });

  app.get("/internal/acceptance-runs/:orgId/:runId", async (c) => {
    if (!verifyInternalPeer(deps.verifier, c)) return c.json({ error: "untrusted_peer" }, 401);
    const orgId = c.req.param("orgId");
    const runId = c.req.param("runId");
    if (orgId.length === 0 || runId.length === 0) return c.json({ error: "invalid_acceptance_run_scope" }, 400);
    return c.json({ verdicts: await store.listVerdicts({ orgId, runId }) });
  });

  return app;
}
