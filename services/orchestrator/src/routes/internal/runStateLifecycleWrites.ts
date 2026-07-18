// the control-plane RUN/SPEC/TASK LIFECYCLE write endpoints. The
// data-plane worker POSTs these over mTLS instead of writing `runs` / `specs` /
// `tasks` directly (migration 0035 drops its remaining write grants on those
// tables):
//
//   - POST /internal/set-run-status               — the non-finalize `UPDATE runs`
//   - POST /internal/set-run-pr-url               — `UPDATE runs SET pr_url`
//   - POST /internal/set-spec-status              — `UPDATE specs SET status`
//   - POST /internal/set-spec-metadata            — `UPDATE specs SET metadata` (intake provenance)
//   - POST /internal/append-spec-steering         — append steering note to spec description (v55 #59)
//   - POST /internal/supersede-queued-planner-task — cancel the vestigial plan task
//   - POST /internal/insert-task                  — INSERT one tasks row
//   - POST /internal/update-task                  — one named task transition
//
// Each authenticates the mTLS peer FIRST (401 before any DB work), then runs the
// SAME fixed, parameterized statement the worker ran in-process — the shared
// `runStateLifecycleSql` appliers are the single source of truth, so the persisted
// rows are byte-for-byte the direct path's. Every write runs inside
// `runWithOrgScope(pool, orgId, …)` under the CONTROL PLANE's DB access, so RLS
// admits exactly the run's own rows. Mounted on the internal mTLS listener only.

import { runWithOrgScope } from "@tanren/db";
import type { Context, Hono } from "hono";
import { z, ZodError } from "zod";
import {
  applyAppendSpecSteering,
  applyClearRunPercolationPending,
  applyInsertTask,
  applyMergeRunVerifiedAncestorSha,
  applySetRunAuthRef,
  applySetRunPercolationReexecId,
  applySetRunPrUrl,
  applySetRunSpeculativeBase,
  applySetRunStatus,
  applySetSpecMetadata,
  applySetSpecStatus,
  applySupersedeQueuedPlannerTask,
  applyUpdateTask,
  applyUpdateTaskWithEvent,
  terminalPairSchema,
} from "../../engine/worker/runStateLifecycleSql.js";
import { applyFinalizeLand } from "../../engine/merge/mergeAuthorityLandFinalizer.js";
import { verifyInternalPeer, type RunStateWriteRouteDeps } from "./internalWriteShared.js";
import { ancestorStackSchema } from "../../engine/dag/ancestorStack.js";
import { AuditEnvelope } from "../../engine/events/schemas/audit.js";
import { registerRunStateAtomicRoutes } from "./runStateAtomicWrites.js";

const setRunStatusSchema = z.object({
  runId: z.string().min(1),
  orgId: z.string().min(1),
  status: z.string().min(1),
  setStartedAt: z.boolean(),
  fromStatuses: z.array(z.string().min(1)).min(1),
});

const setRunPrUrlSchema = z.object({
  runId: z.string().min(1),
  orgId: z.string().min(1),
  prUrl: z.string().min(1),
});

const setRunAuthRefSchema = z.object({
  runId: z.string().min(1),
  orgId: z.string().min(1),
  authRef: z.string().min(1),
});

const finalizeLandSchema = z.object({
  orgId: z.string().min(1),
  runId: z.string().min(1),
  specId: z.string().min(1),
  projectId: z.string().min(1),
  taskId: z.string().min(1),
  prUrl: z.string().min(1),
  prNumber: z.number().int(),
  integration: z.enum(["direct_merge", "native_queue"]),
  mergeSha: z.string().min(1),
  // in-16: the authorizing decision id the transactional delivery-outbox row is FK-bound to.
  authorityDecisionId: z.string().min(1),
  auditEnvelope: AuditEnvelope,
});

const setSpecStatusSchema = z.object({
  specId: z.string().min(1),
  orgId: z.string().min(1),
  status: z.string().min(1),
  notFromStatuses: z.array(z.string().min(1)).optional(),
});

const setSpecMetadataSchema = z.object({
  specId: z.string().min(1),
  orgId: z.string().min(1),
  metadataJson: z.string(),
});

const appendSpecSteeringSchema = z.object({
  specId: z.string().min(1),
  orgId: z.string().min(1),
  steeringNote: z.string().min(1),
});

const setRunSpeculativeBaseSchema = z.object({
  runId: z.string().min(1),
  orgId: z.string().min(1),
  // jj-local (WS-B PR-9): the re-resolved ancestor stack is the sole jj-local base
  // source (written to `runs.ancestor_stack`). Empty when non-speculative (every
  // ancestor merged ⇒ the dependent re-bases onto default_branch).
  ancestorStack: ancestorStackSchema.optional(),
});

const setRunPercolationReexecIdSchema = z.object({
  runId: z.string().min(1),
  orgId: z.string().min(1),
  reexecRunId: z.string().min(1),
});

const clearRunPercolationPendingSchema = z.object({
  runId: z.string().min(1),
  orgId: z.string().min(1),
});

const mergeRunVerifiedAncestorShaSchema = z.object({
  runId: z.string().min(1),
  orgId: z.string().min(1),
  ancestorSpecId: z.string().min(1),
  entryJson: z.string(),
});

const supersedeSchema = z.object({
  runId: z.string().min(1),
  orgId: z.string().min(1),
});

const insertTaskSchema = z
  .object({
    taskId: z.string().min(1),
    runId: z.string().min(1).optional(),
    issueLoopId: z.string().min(1).optional(),
    orgId: z.string().min(1),
    kind: z.string().min(1),
    title: z.string().min(1),
    status: z.string().min(1),
    agentKind: z.string().min(1),
    cli: z.string().min(1),
    model: z.string().nullable(),
    parentTaskId: z.string().min(1).optional(),
    setStartedAt: z.boolean(),
    attempt: z.number().int().optional(),
  })
  .refine((value) => (value.runId === undefined) !== (value.issueLoopId === undefined), {
    message: "exactly one of runId and issueLoopId is required",
  });

const updateTaskSchema = z.object({
  taskId: z.string().min(1),
  orgId: z.string().min(1),
  transition: z.enum([
    "running",
    "running_attempt",
    "running_pending",
    "running_pending_clear_failure",
    "started",
    "done",
    "failed",
    "failed_with_kind",
    "failed_with_kind_if_running",
    "cancelled",
  ]),
  outcome: z.string().min(1).optional(),
  failureKind: z.string().min(1).optional(),
  attempt: z.number().int().optional(),
});

// Route shape for the ATOMIC terminal row + terminal event endpoint (task #39).
// The route enforces an EXPLICIT `task.orgId` (so the server can open
// `runWithOrgScope` deterministically — the worker resolved its org from the
// ambient per-job scope before posting). The pairing constraint itself is
// enforced by the shared `terminalPairSchema` (matched transition + event type),
// which also enforces the round-3 H-R3.1 (no-terminal-event-in-priorEvents)
// refinement and the H-R3.2 (idempotencyKey required) shape.
//
// `priorEvents` (audit finding D2 writer-seam extension) bundles pre-terminal
// observation events into the SAME transaction — see
// `UpdateTaskWithEventInput` in `contracts/runStateWriter.ts`. Round-3 H-R3.2:
// each entry REQUIRES a caller-supplied `idempotencyKey`; round-3 H-R3.1:
// terminal task/run event types are rejected (terminal-leak guard).
const priorEventRouteShape = z
  .object({
    runId: z.string().min(1),
    taskId: z.string().min(1).optional(),
    specId: z.string().min(1).optional(),
    projectId: z.string().min(1),
    // This prior write carries the exact tenant key the writer stamps.
    orgId: z.string().min(1),
    eventType: z.string().min(1),
    payload: z.record(z.string(), z.unknown()),
    idempotencyKey: z.string().min(1),
  })
  .strict();

const updateTaskWithEventRouteShape = z
  .object({
    task: z
      .object({
        taskId: z.string().min(1),
        orgId: z.string().min(1),
        transition: z.string().min(1),
        outcome: z.string().min(1).optional(),
        failureKind: z.string().min(1).optional(),
        attempt: z.number().int().optional(),
      })
      .strict(),
    event: z
      .object({
        runId: z.string().min(1).optional(),
        taskId: z.string().min(1).optional(),
        specId: z.string().min(1).optional(),
        projectId: z.string().min(1),
        // This terminal event carries the explicit tenant key the writer stamps.
        orgId: z.string().min(1),
        eventType: z.string().min(1),
        payload: z.record(z.string(), z.unknown()),
      })
      .strict(),
    // Audit finding D2: optional pre-terminal events bundle (see route header).
    priorEvents: z.array(priorEventRouteShape).optional(),
  })
  .strict();

/**
 * Register the lifecycle write endpoints on the internal write-routes app.
 * Each parses its body, authenticates the peer, and runs the shared applier under
 * the run's org scope. Returns 204 (no body) on success — the worker's seam
 * methods all return void.
 */
export function registerRunStateLifecycleRoutes(app: Hono, deps: RunStateWriteRouteDeps): void {
  const authnPeer = (c: Context): boolean => verifyInternalPeer(deps.verifier, c);

  app.post("/internal/set-run-status", async (c) => {
    if (!authnPeer(c)) {
      return c.json({ error: "untrusted_peer" }, 401);
    }
    const parsed = setRunStatusSchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_set_run_status", issues: parsed.error.issues }, 400);
    }
    await runWithOrgScope(deps.pool, parsed.data.orgId, (client) => applySetRunStatus(client, parsed.data));
    return c.body(null, 204);
  });

  app.post("/internal/set-run-pr-url", async (c) => {
    if (!authnPeer(c)) {
      return c.json({ error: "untrusted_peer" }, 401);
    }
    const parsed = setRunPrUrlSchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_set_run_pr_url", issues: parsed.error.issues }, 400);
    }
    await runWithOrgScope(deps.pool, parsed.data.orgId, (client) => applySetRunPrUrl(client, parsed.data));
    return c.body(null, 204);
  });

  app.post("/internal/set-run-auth-ref", async (c) => {
    if (!authnPeer(c)) {
      return c.json({ error: "untrusted_peer" }, 401);
    }
    const parsed = setRunAuthRefSchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_set_run_auth_ref", issues: parsed.error.issues }, 400);
    }
    await runWithOrgScope(deps.pool, parsed.data.orgId, (client) => applySetRunAuthRef(client, parsed.data));
    return c.body(null, 204);
  });

  // The §5 durable merge-LAND finalize: `merge.completed` + the guarded spec `merged`
  // flip in ONE org-scoped transaction. Returns `{ auditId }` (the run id) — the
  // worker's `finalizeLand` returns it as the land's durable handle.
  app.post("/internal/finalize-land", async (c) => {
    if (!authnPeer(c)) {
      return c.json({ error: "untrusted_peer" }, 401);
    }
    const parsed = finalizeLandSchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_finalize_land", issues: parsed.error.issues }, 400);
    }
    await runWithOrgScope(deps.pool, parsed.data.orgId, (client) => applyFinalizeLand(client, parsed.data));
    return c.json({ auditId: parsed.data.runId });
  });

  app.post("/internal/set-spec-status", async (c) => {
    if (!authnPeer(c)) {
      return c.json({ error: "untrusted_peer" }, 401);
    }
    const parsed = setSpecStatusSchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_set_spec_status", issues: parsed.error.issues }, 400);
    }
    await runWithOrgScope(deps.pool, parsed.data.orgId, (client) => applySetSpecStatus(client, parsed.data));
    return c.body(null, 204);
  });

  app.post("/internal/set-spec-metadata", async (c) => {
    if (!authnPeer(c)) {
      return c.json({ error: "untrusted_peer" }, 401);
    }
    const parsed = setSpecMetadataSchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_set_spec_metadata", issues: parsed.error.issues }, 400);
    }
    await runWithOrgScope(deps.pool, parsed.data.orgId, (client) => applySetSpecMetadata(client, parsed.data));
    return c.body(null, 204);
  });

  // v55 #59 plane-split fix: the merge-queue gate-fail-rework router previously ran a raw
  // `UPDATE specs SET description = ...` on the de-privileged data-plane pool, which
  // lacks `UPDATE ON specs` (migration 0000:919) and stranded reworked specs at
  // `needs_attention`. Routing the steering append through this control-plane endpoint
  // (mirrors `/internal/set-spec-status`'s plane-split) restores the writer path.
  app.post("/internal/append-spec-steering", async (c) => {
    if (!authnPeer(c)) {
      return c.json({ error: "untrusted_peer" }, 401);
    }
    const parsed = appendSpecSteeringSchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_append_spec_steering", issues: parsed.error.issues }, 400);
    }
    await runWithOrgScope(deps.pool, parsed.data.orgId, (client) => applyAppendSpecSteering(client, parsed.data));
    return c.body(null, 204);
  });

  app.post("/internal/set-run-speculative-base", async (c) => {
    if (!authnPeer(c)) {
      return c.json({ error: "untrusted_peer" }, 401);
    }
    const parsed = setRunSpeculativeBaseSchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_set_run_speculative_base", issues: parsed.error.issues }, 400);
    }
    await runWithOrgScope(deps.pool, parsed.data.orgId, (client) => applySetRunSpeculativeBase(client, parsed.data));
    return c.body(null, 204);
  });

  app.post("/internal/set-run-percolation-reexec-id", async (c) => {
    if (!authnPeer(c)) {
      return c.json({ error: "untrusted_peer" }, 401);
    }
    const parsed = setRunPercolationReexecIdSchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_set_run_percolation_reexec_id", issues: parsed.error.issues }, 400);
    }
    await runWithOrgScope(deps.pool, parsed.data.orgId, (client) =>
      applySetRunPercolationReexecId(client, parsed.data),
    );
    return c.body(null, 204);
  });

  app.post("/internal/clear-run-percolation-pending", async (c) => {
    if (!authnPeer(c)) {
      return c.json({ error: "untrusted_peer" }, 401);
    }
    const parsed = clearRunPercolationPendingSchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_clear_run_percolation_pending", issues: parsed.error.issues }, 400);
    }
    await runWithOrgScope(deps.pool, parsed.data.orgId, (client) =>
      applyClearRunPercolationPending(client, parsed.data),
    );
    return c.body(null, 204);
  });

  app.post("/internal/merge-run-verified-ancestor-sha", async (c) => {
    if (!authnPeer(c)) {
      return c.json({ error: "untrusted_peer" }, 401);
    }
    const parsed = mergeRunVerifiedAncestorShaSchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_merge_run_verified_ancestor_sha", issues: parsed.error.issues }, 400);
    }
    await runWithOrgScope(deps.pool, parsed.data.orgId, (client) =>
      applyMergeRunVerifiedAncestorSha(client, parsed.data),
    );
    return c.body(null, 204);
  });

  app.post("/internal/supersede-queued-planner-task", async (c) => {
    if (!authnPeer(c)) {
      return c.json({ error: "untrusted_peer" }, 401);
    }
    const parsed = supersedeSchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_supersede_queued_planner_task", issues: parsed.error.issues }, 400);
    }
    await runWithOrgScope(deps.pool, parsed.data.orgId, (client) =>
      applySupersedeQueuedPlannerTask(client, parsed.data.runId),
    );
    return c.body(null, 204);
  });

  app.post("/internal/insert-task", async (c) => {
    if (!authnPeer(c)) {
      return c.json({ error: "untrusted_peer" }, 401);
    }
    const parsed = insertTaskSchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_insert_task", issues: parsed.error.issues }, 400);
    }
    await runWithOrgScope(deps.pool, parsed.data.orgId, (client) => applyInsertTask(client, parsed.data));
    return c.body(null, 204);
  });

  app.post("/internal/update-task", async (c) => {
    if (!authnPeer(c)) {
      return c.json({ error: "untrusted_peer" }, 401);
    }
    const parsed = updateTaskSchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_update_task", issues: parsed.error.issues }, 400);
    }
    await runWithOrgScope(deps.pool, parsed.data.orgId, (client) => applyUpdateTask(client, parsed.data));
    return c.body(null, 204);
  });

  // The ATOMIC terminal row + terminal `task.*` event endpoint (task #39 —
  // critic-arc R2 NEW#1 / R3 BLOCKING). Mirrors `/internal/finalize-land`: the
  // row UPDATE + the event INSERT run in ONE org-scoped transaction so they
  // COMMIT (or rollback) TOGETHER, eliminating the row-`done`/no-`task.completed`
  // strand (autonomy-engine.md §1c single-finalize invariant). The pairing
  // constraint (`done` ↔ `task.completed`, `failed*` ↔ `task.failed`) is enforced
  // by `terminalPairSchema` BEFORE any DB I/O — a misuse 422s loudly. The event
  // PAYLOAD is parsed downstream by `PgEventStore.append` against the registry;
  // an invalid payload there throws a `ZodError` we surface as a 422 (mirrors
  // the pairing-misuse response).
  app.post("/internal/update-task-with-event", async (c) => {
    if (!authnPeer(c)) {
      return c.json({ error: "untrusted_peer" }, 401);
    }
    const routeParsed = updateTaskWithEventRouteShape.safeParse(await c.req.json().catch(() => {}));
    if (!routeParsed.success) {
      return c.json({ error: "invalid_update_task_with_event", issues: routeParsed.error.issues }, 400);
    }
    const pairParsed = terminalPairSchema.safeParse(routeParsed.data);
    if (!pairParsed.success) {
      return c.json({ error: "invalid_terminal_pair", issues: pairParsed.error.issues }, 422);
    }
    let outcome: Awaited<ReturnType<typeof applyUpdateTaskWithEvent>>;
    try {
      // The pairing-validated body is the seam's `UpdateTaskWithEventInput` —
      // the row-update shape matches; `event.payload` is the registry-typed
      // payload after the event store's downstream Zod parse (the cast at the
      // seam crosses the generic-payload boundary; the parse is the ground truth).
      outcome = await runWithOrgScope(deps.pool, routeParsed.data.task.orgId, (client) =>
        applyUpdateTaskWithEvent(client, routeParsed.data as Parameters<typeof applyUpdateTaskWithEvent>[1]),
      );
    } catch (error) {
      if (error instanceof ZodError) {
        return c.json({ error: "invalid_event_payload", issues: error.issues }, 422);
      }
      throw error;
    }
    // Task #40 Class B — RPC phantom-write idempotency. The applier's outcome
    // distinguishes a FRESH apply from an IDEMPOTENT retry (the partial unique
    // index `events_task_terminal_unique` deduped the event INSERT because the
    // original COMMIT already landed but its HTTP response was DROPPED en route).
    // The data plane uses 200 vs 204 to tell whether the original landed:
    //   - 204 No Content                      — this call wrote the row + event.
    //   - 200 { alreadyTerminal: true }       — original already landed; this is a retry.
    // Either way, the row + event are durable in their original/fresh form; the
    // data plane's `HttpRunStateWriter` returns the typed outcome to its caller
    // (the helpers swallow `alreadyTerminal: true` silently).
    if (outcome.alreadyTerminal) {
      return c.json({ alreadyTerminal: true }, 200);
    }
    return c.body(null, 204);
  });

  // Task #48 atomic-seam endpoints (RUN-LEVEL + SPEC-LEVEL mirrors) live in
  // `./runStateAtomicWrites.ts` to keep this function under the per-function
  // line cap; same `deps` thread through so the registration is uniform.
  registerRunStateAtomicRoutes(app, deps);
}
