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
  applyResumePausedRunAtomic,
  applyUpdateSpecWithEvent,
  resumePausedRunPairSchema,
  runPairSchema,
  specPairSchema,
} from "../../engine/worker/runStateLifecycleSql.js";
import { applyRecordDraftPrCreated } from "../../engine/merge/draftPrCreatedAtomic.js";
import {
  applyRecoveryOwnedSettleAtomic,
  applyRecoveryParkAtomic,
  recoveryOwnedSettleInputSchema,
  recoveryOwnedSettlementFailed,
  recoveryParkingFailed,
  recoveryParkInputSchema,
} from "../../engine/worker/recoveryParkAtomic.js";
import {
  applyRecoveryPreparationAtomic,
  readRecoveryPreparationAtomic,
  recoveryPreparationFailure,
  recoveryPreparationInputSchema,
} from "../../engine/worker/recoveryPreparationAtomic.js";
import { verifyInternalPeer, type RunStateWriteRouteDeps } from "./internalWriteShared.js";

// apex v86: post-PR-open atomic block (github.pr.created + merge_queue + merge.scheduled).
const recordDraftPrCreatedSchema = z
  .object({
    orgId: z.string().min(1),
    runId: z.string().min(1),
    specId: z.string().min(1),
    projectId: z.string().min(1),
    repoUrl: z.string().min(1),
    branch: z.string().min(1),
    baseBranch: z.string().min(1),
    prUrl: z.string().min(1),
    prNumber: z.number().int(),
  })
  .strict();

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
        // v68 fix: AppendEventInput now carries an explicit orgId — accept it on
        // the route shape so HttpRunStateWriter's payload doesn't trip strict.
        orgId: z.string().optional(),
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
        // v68 fix: AppendEventInput now carries explicit orgId.
        orgId: z.string().optional(),
        eventType: z.string().min(1),
        payload: z.record(z.string(), z.unknown()),
      })
      .strict(),
  })
  .strict();

/** Register the task #48 atomic-seam endpoints + the apex-v86 draft-PR atomic
 * endpoint on the internal write app. Called from `registerRunStateLifecycleRoutes`. */
export function registerRunStateAtomicRoutes(app: Hono, deps: RunStateWriteRouteDeps): void {
  const authnPeer = (c: Context): boolean => verifyInternalPeer(deps.verifier, c);

  const preparationRoute = (readOnly: boolean) => async (c: Context) => {
    if (!authnPeer(c)) return c.json({ error: "untrusted_peer" }, 401);
    const parsed = recoveryPreparationInputSchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) return c.json({ error: "invalid_recovery_preparation", issues: parsed.error.issues }, 400);
    try {
      const outcome = await runWithOrgScope(deps.pool, parsed.data.orgId, (client) =>
        readOnly
          ? readRecoveryPreparationAtomic(client, parsed.data)
          : applyRecoveryPreparationAtomic(client, parsed.data),
      );
      return c.json(outcome, 200);
    } catch (error) {
      return c.json(recoveryPreparationFailure("write_failed", String(error)), 200);
    }
  };
  app.post("/internal/prepare-recovery", preparationRoute(false));
  app.post("/internal/read-recovery-preparation", preparationRoute(true));

  // Recovery park authority: exact ownership readback + spec park + ordered
  // events + queue dequeue all run on ONE org-scoped transaction. Expected
  // precondition failures and write/commit uncertainty are typed 200 outcomes
  // so the remote writer can retain/re-drive rather than infer success.
  app.post("/internal/park-recovery-and-dequeue", async (c) => {
    if (!authnPeer(c)) {
      return c.json({ error: "untrusted_peer" }, 401);
    }
    const parsed = recoveryParkInputSchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_recovery_park", issues: parsed.error.issues }, 400);
    }
    try {
      const outcome = await runWithOrgScope(deps.pool, parsed.data.orgId, (client) =>
        applyRecoveryParkAtomic(client, parsed.data),
      );
      return c.json(outcome, 200);
    } catch {
      return c.json(recoveryParkingFailed("write_failed"), 200);
    }
  });

  // Successful recovery authority: exact active successor verification, the
  // canonical dequeue event, and exact old-candidate retirement share one
  // transaction. A transport retry reads the committed queue row and dedupes.
  app.post("/internal/settle-owned-recovery-and-dequeue", async (c) => {
    if (!authnPeer(c)) return c.json({ error: "untrusted_peer" }, 401);
    const parsed = recoveryOwnedSettleInputSchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_owned_recovery_settle", issues: parsed.error.issues }, 400);
    }
    try {
      const outcome = await runWithOrgScope(deps.pool, parsed.data.orgId, (client) =>
        applyRecoveryOwnedSettleAtomic(client, parsed.data),
      );
      return c.json(outcome, 200);
    } catch {
      return c.json(recoveryOwnedSettlementFailed("write_failed"), 200);
    }
  });

  // apex v86: ATOMIC post-PR-open writes under the control plane's events grant.
  // Response: 200 `{ created: boolean }` (merge_queue INSERT outcome).
  app.post("/internal/record-draft-pr-created", async (c) => {
    if (!authnPeer(c)) {
      return c.json({ error: "untrusted_peer" }, 401);
    }
    const parsed = recordDraftPrCreatedSchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_record_draft_pr_created", issues: parsed.error.issues }, 400);
    }
    try {
      const outcome = await runWithOrgScope(deps.pool, parsed.data.orgId, (client) =>
        applyRecordDraftPrCreated(client, parsed.data),
      );
      return c.json(outcome, 200);
    } catch (error) {
      if (error instanceof ZodError) {
        return c.json({ error: "invalid_event_payload", issues: error.issues }, 422);
      }
      throw error;
    }
  });

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
    // Always return 200 with the full outcome JSON — the 204 fresh-apply path
    // would drop specId/projectId, silently disabling the Site C parkStrandedSpecRemote
    // never-strand safety net (`result.specId !== undefined && result.specId !== ""`
    // is false on every 204 body). PR #676 audit caught this regression on the
    // default-remote-writes deployment path; the fix is to always include the
    // outcome's specId/projectId so the caller can drive the spec-park follow-on.
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

  // Audit finding #3 — the WINDOW-PAUSE RESUME atomic endpoint. ALL FOUR
  // writes (run finalize + run.resumed + spec flip + dag.spec.redriven) land
  // in ONE org-scoped transaction. Always returns 200 with the full outcome
  // JSON (matching the finalize-run-with-event endpoint's discipline) so the
  // caller can drive any follow-on writes.
  app.post("/internal/resume-paused-run-atomic", async (c) => {
    if (!authnPeer(c)) {
      return c.json({ error: "untrusted_peer" }, 401);
    }
    const routeParsed = resumePausedRunAtomicRouteShape.safeParse(await c.req.json().catch(() => {}));
    if (!routeParsed.success) {
      return c.json({ error: "invalid_resume_paused_run_atomic", issues: routeParsed.error.issues }, 400);
    }
    const pairParsed = resumePausedRunPairSchema.safeParse(routeParsed.data);
    if (!pairParsed.success) {
      return c.json({ error: "invalid_resume_paused_run_pair", issues: pairParsed.error.issues }, 422);
    }
    let outcome: Awaited<ReturnType<typeof applyResumePausedRunAtomic>>;
    try {
      outcome = await runWithOrgScope(deps.pool, routeParsed.data.finalize.orgId, (client) =>
        applyResumePausedRunAtomic(client, routeParsed.data as Parameters<typeof applyResumePausedRunAtomic>[1]),
      );
    } catch (error) {
      if (error instanceof ZodError) {
        return c.json({ error: "invalid_event_payload", issues: error.issues }, 422);
      }
      throw error;
    }
    return c.json(outcome, 200);
  });
}

// Route shape for the WINDOW-PAUSE RESUME atomic endpoint (audit finding #3).
// Same shape conventions as the other endpoints — the pair-schema enforces
// the narrower paused→halted + in_flight→open semantics.
const resumePausedRunAtomicRouteShape = z
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
    resumedEvent: z
      .object({
        runId: z.string().min(1).optional(),
        taskId: z.string().min(1).optional(),
        specId: z.string().optional(),
        projectId: z.string(),
        // v68 fix: AppendEventInput now carries explicit orgId.
        orgId: z.string().optional(),
        eventType: z.string().min(1),
        payload: z.record(z.string(), z.unknown()),
      })
      .strict(),
    spec: z
      .object({
        specId: z.string().min(1),
        orgId: z.string().min(1),
        status: z.string().min(1),
        notFromStatuses: z.array(z.string().min(1)).optional(),
      })
      .strict(),
    redrivenEvent: z
      .object({
        runId: z.string().min(1).optional(),
        taskId: z.string().min(1).optional(),
        specId: z.string().min(1).optional(),
        projectId: z.string().min(1),
        // v68 fix: AppendEventInput now carries explicit orgId.
        orgId: z.string().optional(),
        eventType: z.string().min(1),
        payload: z.record(z.string(), z.unknown()),
      })
      .strict(),
  })
  .strict();
