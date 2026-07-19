import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { CanonicalBody, Digest } from "../../engine/contracts/cas.js";
import type { MtlsPeerVerifier } from "../../engine/contracts/mtlsChannel.js";
import type {
  ComparisonOperator,
  ExecutionMatrix,
  RequiredSurface,
} from "../../engine/contracts/runtimeVerificationPlan.js";
import { PgFixtureLeaseAdapter } from "../../engine/verification/fixtureLease/index.js";
import {
  AcceptanceOrchestrator,
  PgAcceptanceEventSink,
  PgAcceptanceRunStore,
  type AcceptancePlan,
  type AcceptanceSurfaceDriver,
} from "../../engine/verification/acceptance/index.js";
import { verifyInternalPeer } from "./internalWriteShared.js";

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const surface = z.enum(["browser", "api", "cli", "package", "app_channel", "external_integration", "mobile"]);
const canonical: z.ZodType<CanonicalBody> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number(), z.string(), z.array(canonical), z.record(z.string(), canonical)]),
);

const assertionSchema = z.object({
  assertionId: z.string().min(1),
  subject: z.string().min(1),
  comparisonOperator: z.string().min(1),
  expected: canonical,
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
const planSchema = z.object({
  planId: z.string().min(1),
  behaviorRevisionId: z.string().min(1),
  requiredSurfaces: z.array(surface).min(1),
  assertions: z.array(assertionSchema),
  fixtures: z.array(z.unknown()).default([]),
  examples: z.array(exampleSchema).default([]),
  executionMatrix: matrixSchema,
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

function toPlan(raw: z.infer<typeof planSchema>): AcceptancePlan {
  return {
    planId: raw.planId,
    behaviorRevisionId: raw.behaviorRevisionId,
    requiredSurfaces: raw.requiredSurfaces as readonly RequiredSurface[],
    assertions: raw.assertions.map((assertion) => ({
      assertionId: assertion.assertionId,
      subject: assertion.subject,
      comparisonOperator: assertion.comparisonOperator as ComparisonOperator,
      expected: assertion.expected,
    })),
    fixtures: raw.fixtures,
    examples: raw.examples.map((example) => ({ values: example.values, rowHash: example.rowHash as Digest })),
    executionMatrix: toExecutionMatrix(raw.executionMatrix),
  };
}

export interface AcceptanceRunRouteDeps {
  readonly pool: pg.Pool;
  readonly verifier: MtlsPeerVerifier;
  /** rv-6 surface drivers; empty until a real driver lands (runs fail-closed). */
  readonly drivers?: readonly AcceptanceSurfaceDriver[];
}

/** mTLS-only surface to trigger an A1 acceptance run and read its recorded verdicts. */
export function createInternalAcceptanceRunRoutes(deps: AcceptanceRunRouteDeps): Hono {
  const store = new PgAcceptanceRunStore(deps.pool);
  const orchestrator = new AcceptanceOrchestrator({
    store,
    events: new PgAcceptanceEventSink(deps.pool),
    fixtureLease: new PgFixtureLeaseAdapter(deps.pool),
    ...(deps.drivers === undefined ? {} : { drivers: deps.drivers }),
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

  app.get("/internal/acceptance-runs/:orgId/:runId", async (c) => {
    if (!verifyInternalPeer(deps.verifier, c)) return c.json({ error: "untrusted_peer" }, 401);
    const orgId = c.req.param("orgId");
    const runId = c.req.param("runId");
    if (orgId.length === 0 || runId.length === 0) return c.json({ error: "invalid_acceptance_run_scope" }, 400);
    return c.json({ verdicts: await store.listVerdicts({ orgId, runId }) });
  });

  return app;
}
