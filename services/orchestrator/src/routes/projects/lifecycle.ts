// The project LIFECYCLE surface (apex.md "missing endpoint → add it"): the
// supported way an operator PAUSES a project and resumes it later.
//
//   POST /:orgId/projects/:projectId/archive
//     → { projectId, lifecycle: "archived", cancelledRuns }
//       Flip the project to `archived` and STOP its compute: every in-flight run
//       (queued | running) is cancelled (the same terminal flip the percolation
//       supersede path uses). An archived project is dormant — the autonomous
//       DagWalker and the strand reconciler both read `projects.lifecycle` and
//       skip it — so its DAG never advances until it is unarchived. The specs
//       themselves are NOT terminally cancelled: they stay as-is so an unarchive
//       can resume them.
//   POST /:orgId/projects/:projectId/unarchive
//     → { projectId, lifecycle: "active", cancelledRuns: 0 }
//       Flip back to `active`. The walker resumes on its next tick and the strand
//       reconciler re-enqueues the active specs that lost their runs at archive.
//
// Both mutations are org-ADMIN (they change the project's autonomy posture) and run
// org-scoped under RLS: the lifecycle flip + the run cancel happen inside a single
// `runWithOrgScope` transaction, so an unauthorized cross-org id matches zero rows
// (rendered as 404) rather than mutating another tenant's project.

import { runWithOrgScope } from "@tanren/db";
import type { Context } from "hono";
import type pg from "pg";
import type { ProjectLifecycle } from "../../engine/repositories/index.js";

// Re-export the dependency-UPGRADE handler (environment-management.md §4.5/§7 P1) — a
// sibling project POST-action handler in `upgrade.ts`. Surfacing it through this module
// keeps the project route file (`index.ts`) under its per-file dependency cap: it imports
// all the project-action handlers (archive/unarchive/upgrade) from one module.
export { handleProjectUpgrade } from "./upgrade.js";

/** The shape both archive + unarchive return. */
export interface LifecycleView {
  projectId: string;
  lifecycle: ProjectLifecycle;
  /** How many in-flight runs THIS call cancelled (always 0 for unarchive). */
  cancelledRuns: number;
}

/**
 * Flip the project's lifecycle and (on archive) cancel its in-flight runs, all in
 * one org-scoped transaction. Returns `undefined` when the project is not in the
 * path org (or does not exist) — the RLS-scoped UPDATE matched zero rows.
 */
async function setLifecycleCascade(
  pool: pg.Pool,
  orgId: string,
  projectId: string,
  target: ProjectLifecycle,
): Promise<LifecycleView | { conflict: ProjectLifecycle } | undefined> {
  return runWithOrgScope(
    pool,
    orgId,
    async (client): Promise<LifecycleView | { conflict: ProjectLifecycle } | undefined> => {
      const expected: ProjectLifecycle = target === "archived" ? "active" : "archived";
      const updated = await client.query(
        "UPDATE projects SET lifecycle = $1 WHERE project_id = $2 AND lifecycle = $3 RETURNING project_id",
        [target, projectId, expected],
      );
      if (updated.rowCount === 0) {
        const current = await client.query<{ lifecycle: ProjectLifecycle }>(
          "SELECT lifecycle FROM projects WHERE project_id = $1",
          [projectId],
        );
        return current.rows[0] === undefined ? undefined : { conflict: current.rows[0].lifecycle };
      }
      let cancelledRuns = 0;
      if (target === "archived") {
        const cancelled = await client.query(
          `UPDATE runs SET status = 'cancelled', outcome = 'cancelled', ended_at = now()
          WHERE project_id = $1 AND status IN ('queued', 'running')
        RETURNING run_id`,
          [projectId],
        );
        cancelledRuns = cancelled.rowCount ?? 0;
      }
      return { projectId, lifecycle: target, cancelledRuns };
    },
  );
}

/** POST archive handler. */
export async function handleProjectArchive(
  c: Context,
  pool: pg.Pool,
  orgId: string,
  projectId: string,
): Promise<Response> {
  const view = await setLifecycleCascade(pool, orgId, projectId, "archived");
  if (view === undefined) {
    return c.json({ error: "project_not_found" }, 404);
  }
  if ("conflict" in view) {
    return c.json(
      { error: "project_lifecycle_conflict", currentLifecycle: view.conflict, expectedLifecycle: "active" },
      409,
    );
  }
  return c.json(view);
}

/** POST unarchive handler. */
export async function handleProjectUnarchive(
  c: Context,
  pool: pg.Pool,
  orgId: string,
  projectId: string,
): Promise<Response> {
  const view = await setLifecycleCascade(pool, orgId, projectId, "active");
  if (view === undefined) {
    return c.json({ error: "project_not_found" }, 404);
  }
  if ("conflict" in view) {
    return c.json(
      { error: "project_lifecycle_conflict", currentLifecycle: view.conflict, expectedLifecycle: "archived" },
      409,
    );
  }
  return c.json(view);
}
