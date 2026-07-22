// spec CRUD routes scoped by org+project. Run trigger and spec
// dependency wiring delegate to `engine/workflow/projectSpec.ts`.

import { runWithOrgScope } from "@tanren/db";
import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import { SpecPriority } from "../../engine/state/spec.js";
import { pgRepositories } from "../../engine/contracts/repositories.js";
import type { ProjectSpecRow } from "../../engine/repositories/index.js";
import { systemActor } from "../../engine/state/actor.js";
import {
  createQueuedRunFromSpec,
  createSpec,
  ProjectAccessDeniedError,
  ProjectNotFoundError,
  requeueAttentionSpec,
  SpecDependenciesBlockedError,
  SpecNotInAttentionError,
  SpecNotRunnableError,
  SpecNotFoundError,
} from "../../engine/workflow/projectSpec.js";
import { cancelSpec } from "../../engine/workflow/cancelSpec.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg, actorIsOrgAdmin } from "../orgs/access.js";

interface SpecRoutesOptions {
  pool: pg.Pool;
}

const SpecCreateSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  dependsOn: z.array(z.string().min(1)).optional(),
  // Execution priority (autonomy-engine.md §1b); omitted ⇒ the `tbd` default the
  // DagWalker schedules last.
  priority: SpecPriority.optional(),
});

const SpecPatchSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  acceptanceCriteria: z.array(z.string().min(1)).min(1).optional(),
});

const RunInputSchema = z.object({
  trigger: z.enum(["cli", "dashboard", "api", "webhook"]).optional(),
  branch: z.string().min(1).optional(),
});

export function createSpecRoutes(options: SpecRoutesOptions) {
  const app = new Hono<ActorContextEnv>();

  app.get("/:orgId/projects/:projectId/specs", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    const projectId = c.req.param("projectId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    // RLS R2 cohort-3 (specs read): the spec-list query runs through the
    // org-scoped client so it executes inside `SET LOCAL app.current_org_id =
    // <orgId>` (org validated against the actor above). Inert in R1 — no
    // policies read the GUC — and behavior-identical to the pool path. The query
    // moves behind the `projectSpecs` repository; the scope still lives here.
    const rows = await runWithOrgScope(options.pool, orgId, (client) =>
      pgRepositories.projectSpecs.listForProject(client, projectId, systemActor),
    );
    return c.json({ specs: rows.map((row) => toSpecContract(row)) });
  });

  app.post("/:orgId/projects/:projectId/specs", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    const projectId = c.req.param("projectId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const parsed = SpecCreateSchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_spec", issues: parsed.error.issues }, 400);
    }
    try {
      const spec = await createSpec(options.pool, { projectId, ...parsed.data }, { ...actor, orgId });
      return c.json(spec, 201);
    } catch (error) {
      if (error instanceof ProjectNotFoundError) {
        return c.json({ error: "project_not_found", message: error.message }, 404);
      }
      if (error instanceof ProjectAccessDeniedError) {
        return c.json({ error: "project_access_denied", message: error.message }, 403);
      }
      if (error instanceof SpecNotFoundError) {
        return c.json({ error: "spec_dependency_not_found", message: error.message }, 404);
      }
      throw error;
    }
  });

  app.get("/:orgId/projects/:projectId/specs/:specId", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    const specId = c.req.param("specId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    // RLS R2 cohort-3 (specs read): the spec-detail query runs through the
    // org-scoped client (inert in R1; same row as the pool path). The query
    // moves behind the `projectSpecs` repository; the scope still lives here.
    const row = await runWithOrgScope(options.pool, orgId, (client) =>
      pgRepositories.projectSpecs.get(client, specId, systemActor),
    );
    if (row === undefined) {
      return c.json({ error: "spec_not_found" }, 404);
    }
    return c.json(toSpecContract(row));
  });

  app.patch("/:orgId/projects/:projectId/specs/:specId", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    const specId = c.req.param("specId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const parsed = SpecPatchSchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_spec_patch", issues: parsed.error.issues }, 400);
    }
    const data = parsed.data;
    const fragments: string[] = [];
    const params: unknown[] = [];
    if (data.title !== undefined) {
      params.push(data.title);
      fragments.push(`title = $${params.length}`);
    }
    if (data.description !== undefined) {
      params.push(data.description);
      fragments.push(`description = $${params.length}`);
    }
    if (data.acceptanceCriteria !== undefined) {
      params.push(JSON.stringify(data.acceptanceCriteria));
      fragments.push(`acceptance_criteria = $${params.length}::jsonb`);
    }
    if (fragments.length === 0) {
      return c.json({ error: "invalid_spec_patch", message: "no updatable fields supplied" }, 400);
    }
    // RLS R2 cohort-3 (specs write): the spec PATCH runs through the org-scoped
    // client so the UPDATE executes inside `SET LOCAL app.current_org_id =
    // <orgId>` (inert in R1; same committed row as the pool path). The dynamic
    // `SET <fragments> ... RETURNING spec_id` UPDATE moves behind the
    // `projectSpecs` repository; the route renders the fragments/params and the
    // store binds the spec id last, byte-identical to the inline query.
    const updated = await runWithOrgScope(options.pool, orgId, (client) =>
      pgRepositories.projectSpecs.patch(client, specId, { fragments, params }, systemActor),
    );
    if (!updated) {
      return c.json({ error: "spec_not_found" }, 404);
    }
    return c.json({ specId, patched: true });
  });

  app.post("/:orgId/projects/:projectId/specs/:specId/runs", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    const specId = c.req.param("specId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const parsed = RunInputSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "invalid_run", issues: parsed.error.issues }, 400);
    }
    try {
      const run = await createQueuedRunFromSpec(options.pool, { specId, ...parsed.data }, { ...actor, orgId });
      return c.json(run, 201);
    } catch (error) {
      if (error instanceof SpecNotFoundError) {
        return c.json({ error: "spec_not_found", message: error.message }, 404);
      }
      if (error instanceof ProjectAccessDeniedError) {
        return c.json({ error: "project_access_denied", message: error.message }, 403);
      }
      if (error instanceof SpecDependenciesBlockedError) {
        return c.json({ error: "spec_dependencies_blocked", message: error.message }, 409);
      }
      if (error instanceof SpecNotRunnableError) {
        return c.json({ error: "spec_not_runnable", message: error.message }, 409);
      }
      throw error;
    }
  });

  // The human-in-the-loop resolution of a `needs_attention` escalation (the operator
  // API gap a live run surfaced). When a spec exhausts its retry budget it parks
  // at the terminal `needs_attention` status, blocking its dependents — and there is no
  // AUTO exit (the escalation discipline: a human must DECIDE how to unblock it). Once
  // the operator has ADDRESSED the underlying blocker (e.g. fixed a platform bug) this
  // is the "addressed, proceed" action: it flips the spec `needs_attention → open` so
  // the autonomous DagWalker re-picks it up, resets its bounded re-enqueue budget, and
  // emits an actor-stamped `dag.spec.attention_resolved` audit event. A MUTATION, so it
  // is org-ADMIN scoped (mirrors the settings/config writes). A spec not parked at
  // `needs_attention` is a clean 409 — never a silent re-transition of a real state.
  app.post("/:orgId/projects/:projectId/specs/:specId/requeue", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    const specId = c.req.param("specId");
    if (!actorIsOrgAdmin(actor, orgId)) {
      return c.json({ error: "org_admin_required" }, 403);
    }
    try {
      const result = await requeueAttentionSpec(options.pool, { specId }, { ...actor, orgId });
      return c.json(result, 200);
    } catch (error) {
      if (error instanceof SpecNotFoundError) {
        return c.json({ error: "spec_not_found", message: error.message }, 404);
      }
      if (error instanceof SpecNotInAttentionError) {
        return c.json({ error: "spec_not_in_attention", message: error.message }, 409);
      }
      if (error instanceof ProjectAccessDeniedError) {
        return c.json({ error: "project_access_denied", message: error.message }, 403);
      }
      throw error;
    }
  });

  // The operator cancel-spec/cancel-run control (the §4 fix-soon leftover the
  // pre-run audit surfaced — a human-drivable control the operator API lacked). An
  // operator who decides a spec should NOT proceed (a mis-scoped spec, a dead-end run
  // burning credits) cancels it cleanly: the spec (and its active run) transitions to
  // the TERMINAL `cancelled` state, the DAG slot frees (the walker never re-enqueues a
  // cancelled spec), and the run's claimed runner is RELEASED (no leaked sandbox). A
  // dependent of a cancelled spec is NOT silently dropped — it parks at
  // `needs_attention` for a human DECISION (the escalation discipline). A MUTATION, so
  // it is org-ADMIN scoped (mirrors the requeue write). IDEMPOTENT: cancelling an
  // already-terminal spec is a 200 no-op (`cancelled: false`), never an error.
  app.post("/:orgId/projects/:projectId/specs/:specId/cancel", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    const specId = c.req.param("specId");
    if (!actorIsOrgAdmin(actor, orgId)) {
      return c.json({ error: "org_admin_required" }, 403);
    }
    try {
      const result = await cancelSpec(options.pool, { specId }, { ...actor, orgId });
      return c.json(result, 200);
    } catch (error) {
      if (error instanceof SpecNotFoundError) {
        return c.json({ error: "spec_not_found", message: error.message }, 404);
      }
      if (error instanceof ProjectAccessDeniedError) {
        return c.json({ error: "project_access_denied", message: error.message }, 403);
      }
      throw error;
    }
  });

  return app;
}

function toSpecContract(row: ProjectSpecRow) {
  // Codex H3 #8 — surface the four triage-routing PROVENANCE columns (Claude
  // RA2, migration 0025) as a `triageProvenance` block on the response, present
  // iff `parent_spec_id` is non-null (the sentinel that identifies a routed
  // spec). A non-routed spec (operator create / discovery accept / seed) omits
  // the block, matching the shape the workflow `SpecContract` uses. The check
  // treats null / undefined / "" as "no routing" so a legacy in-memory fixture
  // that hasn't been updated to seed the new columns still renders as
  // non-routed rather than emitting a broken block.
  const parentSpecId = row.parent_spec_id;
  const triageProvenance =
    parentSpecId === null || parentSpecId === undefined || parentSpecId === ""
      ? undefined
      : {
          parentSpecId,
          sourceFindingIds: parseStringArray(row.source_finding_ids),
          originTriageTaskId: row.origin_triage_task_id ?? "",
          originRunId: row.origin_run_id ?? "",
          ...(row.origin_issue_loop_id === null || row.origin_issue_loop_id === undefined
            ? {}
            : { originIssueLoopId: row.origin_issue_loop_id }),
        };
  return {
    specId: row.spec_id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    acceptanceCriteria: parseStringArray(row.acceptance_criteria),
    dependsOn: parseStringArray(row.depends_on),
    status: row.status,
    priority: row.priority,
    ...(triageProvenance !== undefined && { triageProvenance }),
  };
}

function parseStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((item): item is string => typeof item === "string");
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
    } catch {
      return [];
    }
  }
  return [];
}

function requireActor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) {
    throw new Error("actor missing on context");
  }
  return c.var.actor;
}
