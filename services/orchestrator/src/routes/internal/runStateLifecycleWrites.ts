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
import type { Hono } from "hono";
import { z, ZodError } from "zod";
import {
  applyAppendSpecSteering,
  applyClearRunPercolationPending,
  applyInsertTask,
  applyMergeRunVerifiedAncestorSha,
  applyPrepareSpecForRecovery,
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
import { registerOrgScopedJsonPost, registerOrgScopedVoidPost } from "./runStateLifecycleRouteHelpers.js";
import { ancestorStackSchema } from "../../engine/dag/ancestorStack.js";
import { AuditEnvelope } from "../../engine/events/schemas/audit.js";
import { registerRunStateAtomicRoutes } from "./runStateAtomicWrites.js";

const setRunStatusSchema = z.object({
  runId: z.string().min(1),
  orgId: z.string().min(1),
  status: z.string().min(1),
  setStartedAt: z.boolean(),
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

// Target status is always `open` server-side — reject any peer-supplied reopenStatus.
const prepareSpecForRecoverySchema = z
  .object({
    specId: z.string().min(1),
    orgId: z.string().min(1),
    steeringNote: z.string().min(1),
  })
  .strict();

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

const insertTaskSchema = z.object({
  taskId: z.string().min(1),
  runId: z.string().min(1),
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
    // v68 fix: AppendEventInput now carries explicit orgId.
    orgId: z.string().optional(),
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
        // v68 fix: AppendEventInput now carries explicit orgId.
        orgId: z.string().optional(),
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
  registerOrgScopedVoidPost(
    app,
    deps,
    "/internal/set-run-status",
    setRunStatusSchema,
    "invalid_set_run_status",
    applySetRunStatus,
  );
  registerOrgScopedVoidPost(
    app,
    deps,
    "/internal/set-run-pr-url",
    setRunPrUrlSchema,
    "invalid_set_run_pr_url",
    applySetRunPrUrl,
  );
  registerOrgScopedVoidPost(
    app,
    deps,
    "/internal/set-run-auth-ref",
    setRunAuthRefSchema,
    "invalid_set_run_auth_ref",
    applySetRunAuthRef,
  );
  registerOrgScopedJsonPost(
    app,
    deps,
    "/internal/finalize-land",
    finalizeLandSchema,
    "invalid_finalize_land",
    async (client, data) => {
      await applyFinalizeLand(client, data);
      return { auditId: data.runId };
    },
  );
  registerOrgScopedVoidPost(
    app,
    deps,
    "/internal/set-spec-status",
    setSpecStatusSchema,
    "invalid_set_spec_status",
    applySetSpecStatus,
  );
  registerOrgScopedVoidPost(
    app,
    deps,
    "/internal/set-spec-metadata",
    setSpecMetadataSchema,
    "invalid_set_spec_metadata",
    applySetSpecMetadata,
  );
  registerOrgScopedVoidPost(
    app,
    deps,
    "/internal/append-spec-steering",
    appendSpecSteeringSchema,
    "invalid_append_spec_steering",
    applyAppendSpecSteering,
  );
  registerOrgScopedJsonPost(
    app,
    deps,
    "/internal/prepare-spec-for-recovery",
    prepareSpecForRecoverySchema,
    "invalid_prepare_spec_for_recovery",
    applyPrepareSpecForRecovery,
  );
  registerOrgScopedVoidPost(
    app,
    deps,
    "/internal/set-run-speculative-base",
    setRunSpeculativeBaseSchema,
    "invalid_set_run_speculative_base",
    applySetRunSpeculativeBase,
  );
  registerOrgScopedVoidPost(
    app,
    deps,
    "/internal/set-run-percolation-reexec-id",
    setRunPercolationReexecIdSchema,
    "invalid_set_run_percolation_reexec_id",
    applySetRunPercolationReexecId,
  );
  registerOrgScopedVoidPost(
    app,
    deps,
    "/internal/clear-run-percolation-pending",
    clearRunPercolationPendingSchema,
    "invalid_clear_run_percolation_pending",
    applyClearRunPercolationPending,
  );
  registerOrgScopedVoidPost(
    app,
    deps,
    "/internal/merge-run-verified-ancestor-sha",
    mergeRunVerifiedAncestorShaSchema,
    "invalid_merge_run_verified_ancestor_sha",
    applyMergeRunVerifiedAncestorSha,
  );

  registerOrgScopedVoidPost(
    app,
    deps,
    "/internal/supersede-queued-planner-task",
    supersedeSchema,
    "invalid_supersede_queued_planner_task",
    (client, data) => applySupersedeQueuedPlannerTask(client, data.runId),
  );
  registerOrgScopedVoidPost(
    app,
    deps,
    "/internal/insert-task",
    insertTaskSchema,
    "invalid_insert_task",
    applyInsertTask,
  );
  registerOrgScopedVoidPost(
    app,
    deps,
    "/internal/update-task",
    updateTaskSchema,
    "invalid_update_task",
    applyUpdateTask,
  );

  // ATOMIC terminal row + event (task #39): pairing + outcome status need a custom handler.
  app.post("/internal/update-task-with-event", async (c) => {
    if (!verifyInternalPeer(deps.verifier, c)) {
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
      outcome = await runWithOrgScope(deps.pool, routeParsed.data.task.orgId, (client) =>
        applyUpdateTaskWithEvent(client, routeParsed.data as Parameters<typeof applyUpdateTaskWithEvent>[1]),
      );
    } catch (error) {
      if (error instanceof ZodError) {
        return c.json({ error: "invalid_event_payload", issues: error.issues }, 422);
      }
      throw error;
    }
    if (outcome.alreadyTerminal) {
      return c.json({ alreadyTerminal: true }, 200);
    }
    return c.body(null, 204);
  });

  registerRunStateAtomicRoutes(app, deps);
}
