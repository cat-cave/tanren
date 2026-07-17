import { Hono, type Context } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { MtlsPeerVerifier } from "../../engine/contracts/mtlsChannel.js";
import type { ResolutionJob, ResolutionStage } from "../../engine/contracts/resolutionStage.js";
import { ResolutionJobStore } from "../../engine/repositories/resolutionJobs.js";
import { verifyInternalPeer } from "./internalWriteShared.js";

const claimSchema = z.object({
  orgId: z.string().min(1),
  leaseOwner: z.string().min(1),
  leaseMs: z.number().int().positive().optional(),
});

const heartbeatSchema = claimSchema.extend({
  orgId: z.string().min(1),
});

const resolutionJobSchema = z
  .object({
    id: z.string().min(1),
    orgId: z.string().min(1),
    projectId: z.string().min(1),
    issueLoopId: z.string().min(1),
    contractId: z.string().min(1),
    releaseInstanceId: z.string().min(1).optional(),
    stage: z.enum(["baseline", "production", "counterfactual", "soak"]),
    state: z.string().min(1),
    leaseOwner: z.string().min(1),
    leaseExpiry: z.string().min(1),
    idempotencyKey: z.string().min(1),
    attempt: z.number().int().positive(),
    priorAttemptId: z.string().min(1).optional(),
  })
  .strict();

const reproduceSchema = z
  .object({
    job: resolutionJobSchema,
    context: z.unknown().optional(),
  })
  .strict();

export interface ResolutionJobRouteDeps {
  readonly pool: pg.Pool;
  readonly verifier: MtlsPeerVerifier;
  readonly store?: ResolutionJobStore;
  /** bh-8's mTLS-only operator/worker path; bh-6b owns durable walker dispatch. */
  readonly baselineStage?: ResolutionStage;
}

function trusted(verifier: MtlsPeerVerifier, c: Context): boolean {
  return verifyInternalPeer(verifier, c);
}

/** mTLS-only operational claim and heartbeat surface for the durable resolution queue. */
export function createInternalResolutionJobRoutes(deps: ResolutionJobRouteDeps): Hono {
  const store = deps.store ?? new ResolutionJobStore(deps.pool);
  const app = new Hono();

  app.post("/internal/resolution-jobs/claim", async (c) => {
    if (!trusted(deps.verifier, c)) return c.json({ error: "untrusted_peer" }, 401);
    const parsed = claimSchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) return c.json({ error: "invalid_resolution_job_claim", issues: parsed.error.issues }, 400);
    const job = await store.claimNext(parsed.data);
    return c.json({ job: job ?? null });
  });

  app.post("/internal/resolution-jobs/:id/heartbeat", async (c) => {
    if (!trusted(deps.verifier, c)) return c.json({ error: "untrusted_peer" }, 401);
    const id = c.req.param("id");
    if (id.length === 0) return c.json({ error: "invalid_resolution_job_id" }, 400);
    const parsed = heartbeatSchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) return c.json({ error: "invalid_resolution_job_heartbeat", issues: parsed.error.issues }, 400);
    const renewed = await store.heartbeat({ ...parsed.data, id });
    return c.json({ renewed });
  });

  app.post("/internal/resolution-jobs/:id/reproduce", async (c) => {
    if (!trusted(deps.verifier, c)) return c.json({ error: "untrusted_peer" }, 401);
    const parsed = reproduceSchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) return c.json({ error: "invalid_baseline_reproduction", issues: parsed.error.issues }, 400);
    const jobId = c.req.param("id");
    const job: ResolutionJob = parsed.data.job;
    if (jobId !== job.id) return c.json({ error: "resolution_job_id_mismatch" }, 400);
    if (job.stage !== "baseline") return c.json({ error: "resolution_job_not_baseline" }, 409);
    if (deps.baselineStage === undefined) return c.json({ error: "baseline_stage_unavailable" }, 503);
    const result = await deps.baselineStage.run(job, parsed.data.context);
    return c.json({ result });
  });

  return app;
}
