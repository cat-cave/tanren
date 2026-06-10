// the control-plane RUN/SPEC/TASK LIFECYCLE write endpoints. The
// data-plane worker POSTs these over mTLS instead of writing `runs` / `specs` /
// `tasks` directly (migration 0035 drops its remaining write grants on those
// tables):
//
//   - POST /internal/set-run-status               — the non-finalize `UPDATE runs`
//   - POST /internal/set-run-pr-url               — `UPDATE runs SET pr_url`
//   - POST /internal/set-spec-status              — `UPDATE specs SET status`
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
import { z } from "zod";
import {
  applyClearRunPercolationPending,
  applyInsertTask,
  applyMergeRunVerifiedAncestorSha,
  applySetRunPercolationReexecId,
  applySetRunPrUrl,
  applySetRunSpeculativeBase,
  applySetRunStatus,
  applySetSpecMetadata,
  applySetSpecStatus,
  applySupersedeQueuedPlannerTask,
  applyUpdateTask,
} from "../../engine/worker/runStateLifecycleSql.js";
import { verifyInternalPeer, type RunStateWriteRouteDeps } from "./internalWriteShared.js";
import { ancestorStackSchema } from "../../engine/dag/ancestorStack.js";

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

const setRunSpeculativeBaseSchema = z.object({
  runId: z.string().min(1),
  orgId: z.string().min(1),
  // Nullable: the §2c "ancestor-merged → non-speculative re-base" clears the base to
  // NULL (every ancestor merged ⇒ the dependent re-bases onto plain default_branch).
  speculativeBase: z.string().min(1).nullable(),
  // WS-A PR-1: the re-resolved ancestor stack (dual-written to `runs.ancestor_stack`).
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
    "cancelled",
  ]),
  outcome: z.string().min(1).optional(),
  failureKind: z.string().min(1).optional(),
  attempt: z.number().int().optional(),
});

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
}
