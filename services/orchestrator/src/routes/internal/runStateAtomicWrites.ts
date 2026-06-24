// Task #48 (run/spec atomicity sweep) — the ATOMIC TERMINAL RUN finalize +
// terminal `run.*` event endpoint, AND the ATOMIC spec-status flip +
// matching `dag.spec.*` event endpoint. Split from
// `runStateLifecycleWrites.ts` to keep that file + its `register…` function
// under the architecture caps (500 lines / 220 lines per function); both
// endpoints share the same shape as `/internal/update-task-with-event` —
// authn → safeParse(routeShape) → safeParse(pairSchema) → applier under
// `runWithOrgScope`, with the 204-fresh / 200-outcome surface.

import { runWithOrgScope } from "@tanren/db";
import type { Context, Hono } from "hono";
import { z, ZodError } from "zod";
import {
  applyFinalizeRunWithEvent,
  applyUpdateSpecWithEvent,
  runPairSchema,
  specPairSchema,
} from "../../engine/worker/runStateLifecycleSql.js";
import { verifyInternalPeer, type RunStateWriteRouteDeps } from "./internalWriteShared.js";

// Route shape for the ATOMIC terminal RUN finalize + terminal event endpoint
// (task #48 — RUN-LEVEL mirror of /internal/update-task-with-event). The
// finalize side carries an EXPLICIT `orgId` (the worker has the run context);
// the event side allows EMPTY specId/projectId so the applier can source them
// from the runs row's RETURNING when the caller defers (Site C / D).
const finalizeRunWithEventRouteShape = z
  .object({
    finalize: z
      .object({
        runId: z.string().min(1),
        orgId: z.string().min(1),
        status: z.string().min(1),
        outcome: z.string().min(1),
        fromStatuses: z.array(z.string().min(1)),
      })
      .strict(),
    event: z
      .object({
        runId: z.string().min(1).optional(),
        taskId: z.string().min(1).optional(),
        specId: z.string().optional(),
        projectId: z.string(),
        eventType: z.string().min(1),
        payload: z.record(z.string(), z.unknown()),
      })
      .strict(),
  })
  .strict();

// Route shape for the ATOMIC spec-status flip + spec-disposition event endpoint
// (task #48 — SPEC-LEVEL mirror). Mirrors the run shape; the pairing
// constraint (status ↔ event) is enforced by `specPairSchema`.
const updateSpecWithEventRouteShape = z
  .object({
    spec: z
      .object({
        specId: z.string().min(1),
        orgId: z.string().min(1),
        status: z.string().min(1),
        notFromStatuses: z.array(z.string().min(1)).optional(),
      })
      .strict(),
    event: z
      .object({
        runId: z.string().min(1).optional(),
        taskId: z.string().min(1).optional(),
        specId: z.string().min(1).optional(),
        projectId: z.string().min(1),
        eventType: z.string().min(1),
        payload: z.record(z.string(), z.unknown()),
      })
      .strict(),
  })
  .strict();

/** Register the two task #48 atomic-seam endpoints on the internal write app.
 * Called from `registerRunStateLifecycleRoutes` so the same `deps` thread
 * through; split here to keep that function under the per-function line cap. */
export function registerRunStateAtomicRoutes(app: Hono, deps: RunStateWriteRouteDeps): void {
  const authnPeer = (c: Context): boolean => verifyInternalPeer(deps.verifier, c);

  // The ATOMIC terminal-RUN finalize + terminal `run.*` event endpoint (task #48
  // — RUN-LEVEL mirror). Row UPDATE + event INSERT in ONE org-scoped transaction.
  //
  // Response shape:
  //   - 204 No Content              — fresh apply (row + event landed).
  //   - 200 { ...outcome }          — row didn't move (`updated: false`) OR the
  //                                   event was deduped (`alreadyTerminal: true`).
  //                                   Body always includes the full outcome
  //                                   (the spec_id / project_id from the row's
  //                                   RETURNING, for the worker failure-path
  //                                   never-strand spec park follow-up).
  app.post("/internal/finalize-run-with-event", async (c) => {
    if (!authnPeer(c)) {
      return c.json({ error: "untrusted_peer" }, 401);
    }
    const routeParsed = finalizeRunWithEventRouteShape.safeParse(await c.req.json().catch(() => {}));
    if (!routeParsed.success) {
      return c.json({ error: "invalid_finalize_run_with_event", issues: routeParsed.error.issues }, 400);
    }
    const pairParsed = runPairSchema.safeParse(routeParsed.data);
    if (!pairParsed.success) {
      return c.json({ error: "invalid_run_pair", issues: pairParsed.error.issues }, 422);
    }
    let outcome: Awaited<ReturnType<typeof applyFinalizeRunWithEvent>>;
    try {
      outcome = await runWithOrgScope(deps.pool, routeParsed.data.finalize.orgId, (client) =>
        applyFinalizeRunWithEvent(client, routeParsed.data as Parameters<typeof applyFinalizeRunWithEvent>[1]),
      );
    } catch (error) {
      if (error instanceof ZodError) {
        return c.json({ error: "invalid_event_payload", issues: error.issues }, 422);
      }
      throw error;
    }
    if (outcome.updated && !outcome.alreadyTerminal) {
      return c.body(null, 204);
    }
    return c.json(outcome, 200);
  });

  // The ATOMIC spec-status flip + spec-disposition event endpoint (task #48 —
  // SPEC-LEVEL mirror). Recurring events on the spec side (no partial unique
  // index — Plan §3); the `flipped: false` outcome is the no-op signal the
  // caller respects (it suppresses the event emit).
  //
  // Response shape:
  //   - 204 No Content              — fresh flip + event landed.
  //   - 200 { flipped: false, ...} — guard bit (spec already terminal); no event.
  app.post("/internal/update-spec-with-event", async (c) => {
    if (!authnPeer(c)) {
      return c.json({ error: "untrusted_peer" }, 401);
    }
    const routeParsed = updateSpecWithEventRouteShape.safeParse(await c.req.json().catch(() => {}));
    if (!routeParsed.success) {
      return c.json({ error: "invalid_update_spec_with_event", issues: routeParsed.error.issues }, 400);
    }
    const pairParsed = specPairSchema.safeParse(routeParsed.data);
    if (!pairParsed.success) {
      return c.json({ error: "invalid_spec_pair", issues: pairParsed.error.issues }, 422);
    }
    let outcome: Awaited<ReturnType<typeof applyUpdateSpecWithEvent>>;
    try {
      outcome = await runWithOrgScope(deps.pool, routeParsed.data.spec.orgId, (client) =>
        applyUpdateSpecWithEvent(client, routeParsed.data as Parameters<typeof applyUpdateSpecWithEvent>[1]),
      );
    } catch (error) {
      if (error instanceof ZodError) {
        return c.json({ error: "invalid_event_payload", issues: error.issues }, 422);
      }
      throw error;
    }
    if (outcome.flipped) {
      return c.body(null, 204);
    }
    return c.json(outcome, 200);
  });
}
