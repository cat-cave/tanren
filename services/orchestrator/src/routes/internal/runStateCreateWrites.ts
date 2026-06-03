// Plane-split (autonomy loops): the control-plane run/spec CREATE endpoints. The
// data-plane worker's AUTONOMY LOOPS — the DagWalker (enqueue a ready spec), the
// merge coordinator (re-execute a conflicting spec), and the intake (auto-route a
// new spec / re-run a routed spec) — POST these over mTLS instead of writing the
// `runs` / `specs` / `tasks` / `events` tables directly (migrations 0031/0035 drop
// the data plane's write grants on those tables):
//
//   - POST /internal/create-queued-run — the full atomic createQueuedRunFromSpec
//     transaction (INSERT runs + UPDATE specs + INSERT tasks + INSERT job_queue +
//     run.queued/task.queued events) — the DagWalker / merge-conflict-reexec / intake-rerun CREATE.
//   - POST /internal/create-spec       — the createSpec INSERT (the intake auto-route).
//
// Unlike the run EXECUTOR's `/internal/*` write endpoints (which UPDATE/finalize an
// EXISTING run), these CREATE rows. Each authenticates the mTLS peer FIRST (401
// before any DB work), then runs the SAME `createQueuedRunFromSpec` / `createSpec`
// the loop would have run in-process — the single source of truth for the write
// shape. The functions open their OWN `runWithOrgScope(actor.orgId)`, so the
// server-side write is byte-for-byte the direct path's, only now under the CONTROL
// PLANE's DB access. Mounted on the internal mTLS listener only.

import type { Context, Hono } from "hono";
import { z } from "zod";
import { ActorContextSchema } from "../../auth/schemas.js";
import { SpecPriority } from "../../engine/state/spec.js";
import { createQueuedRunFromSpec, createSpec } from "../../engine/workflow/projectSpec.js";
import { verifyInternalPeer, type RunStateWriteRouteDeps } from "./internalWriteShared.js";

const createSpecRunInputSchema = z.object({
  specId: z.string().min(1),
  trigger: z.string().optional(),
  branch: z.string().optional(),
  speculative: z
    .object({
      speculativeBase: z.string().min(1),
      integratedAncestorShas: z.record(z.string(), z.string()).optional(),
      verifiedAncestorShas: z.record(z.string(), z.string()).optional(),
      percolationPending: z.unknown().optional(),
    })
    .optional(),
});

const createQueuedRunSchema = z.object({
  input: createSpecRunInputSchema,
  actor: ActorContextSchema,
});

const createSpecInputSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  acceptanceCriteria: z.array(z.string()),
  dependsOn: z.array(z.string()).optional(),
  priority: SpecPriority.optional(),
});

const createSpecSchema = z.object({
  input: createSpecInputSchema,
  actor: ActorContextSchema,
});

/**
 * Register the autonomy-loop run/spec CREATE endpoints on the internal write-routes
 * app. Each parses its body, authenticates the peer, then runs the SAME
 * `createQueuedRunFromSpec` / `createSpec` the loop would have run — the function's
 * own `runWithOrgScope(actor.orgId)` scopes the multi-table write to the tenant.
 * Returns the created run/spec as JSON (the loop reads `runId` / `specId` off it).
 */
export function registerRunStateCreateRoutes(app: Hono, deps: RunStateWriteRouteDeps): void {
  const authnPeer = (c: Context): boolean => verifyInternalPeer(deps.verifier, c);

  app.post("/internal/create-queued-run", async (c) => {
    if (!authnPeer(c)) {
      return c.json({ error: "untrusted_peer" }, 401);
    }
    const parsed = createQueuedRunSchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_create_queued_run", issues: parsed.error.issues }, 400);
    }
    // The actor carries the org the loop resolved (system-scoped); the function
    // opens its OWN org-scoped tx from it — the SAME multi-table CREATE the loop ran.
    const run = await createQueuedRunFromSpec(deps.pool, parsed.data.input, parsed.data.actor);
    return c.json(run);
  });

  app.post("/internal/create-spec", async (c) => {
    if (!authnPeer(c)) {
      return c.json({ error: "untrusted_peer" }, 401);
    }
    const parsed = createSpecSchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_create_spec", issues: parsed.error.issues }, 400);
    }
    const spec = await createSpec(deps.pool, parsed.data.input, parsed.data.actor);
    return c.json(spec);
  });
}
