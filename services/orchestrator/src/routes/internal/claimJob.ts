// The control-plane CLAIM endpoint. `POST /internal/claim-job`
// runs the EXISTING atomic claim (`FOR UPDATE SKIP LOCKED` → CAS to `running`,
// via `JobQueue.claim`) and returns the claimed job — incl. its `org_id`
// threaded onto the queue row (R3b). The data-plane `worker` calls this over the
// mTLS channel instead of touching `job_queue` directly.
//
// CLAIM SEMANTICS ARE UNCHANGED: this is a thin transport wrapper around the
// same `claim()` the in-process worker used, so exactly-once is preserved — two
// concurrent callers get one job each, never the same job twice.
//
// AUTHN: every request must present a trusted, TLS-verified client cert. The
// route consults an injected {@link MtlsPeerVerifier}; an unverified caller gets
// 401 BEFORE any DB work. The endpoint lives ONLY on the internal mTLS listener
// (a separate HTTPS server from the public API), so it is never exposed on the
// plain-HTTP public surface.

import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import { PgJobQueue, type JobQueue } from "../../engine/contracts/jobQueue.js";
import type { MtlsPeerVerifier } from "../../engine/contracts/mtlsChannel.js";

const claimJobSchema = z.object({
  taskKind: z.string().min(1),
  runId: z.string().min(1).optional(),
  leaseMs: z.number().int().positive().optional(),
});

export interface ClaimJobRouteDeps {
  /** The control-plane pool the claim CAS runs on (the worker no longer holds one). */
  pool: pg.Pool;
  /**
   * The queue the endpoint claims through. Defaults to a {@link PgJobQueue} over
   * `pool` — i.e. the EXACT claim the in-process worker ran, only behind the
   * endpoint. Injectable so tests can drive the authn/transport layer over a
   * fake queue and the contention proof over a real `PgJobQueue`.
   */
  jobQueue?: JobQueue;
  /** Authenticates the inbound mTLS peer; an unverified caller is 401. */
  verifier: MtlsPeerVerifier;
}

/**
 * Build the internal claim route. Mounted on the mTLS-only internal listener.
 * The claim runs the SAME `JobQueue.claim` the worker ran (job_queue stays
 * OUTSIDE RLS and the claim spans tenants — the queue's own atomic CAS), so the
 * exactly-once guarantee and the org threading on the returned envelope are
 * preserved unchanged.
 */
export function createInternalClaimRoutes(deps: ClaimJobRouteDeps): Hono {
  const jobQueue = deps.jobQueue ?? new PgJobQueue(deps.pool);
  const app = new Hono();

  app.post("/internal/claim-job", async (c) => {
    // AUTHN FIRST: reject a caller that did not present a trusted mTLS client
    // cert before doing any DB work. `incoming.socket` is the TLS socket the
    // verifier reads the validated peer cert off of.
    const incoming = (c.env as { incoming?: { socket?: unknown } } | undefined)?.incoming;
    const peer = deps.verifier.verify({ headers: c.req.raw.headers, socket: incoming?.socket });
    if (peer === undefined) {
      return c.json({ error: "untrusted_peer" }, 401);
    }

    const parsed = claimJobSchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_claim_request", issues: parsed.error.issues }, 400);
    }

    const { taskKind, runId, leaseMs } = parsed.data;
    const claimOptions: { runId?: string; leaseMs?: number } = {};
    if (runId !== undefined) {
      claimOptions.runId = runId;
    }
    if (leaseMs !== undefined) {
      claimOptions.leaseMs = leaseMs;
    }
    // The SAME atomic CAS the in-process worker ran — only the transport moved.
    const job = await jobQueue.claim(taskKind, claimOptions);
    return c.json({ job: job ?? null });
  });

  return app;
}
