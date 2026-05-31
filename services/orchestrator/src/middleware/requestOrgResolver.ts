// RLS HTTP-route scoping: resolve the org a request addresses for the auth
// middleware, so EVERY authenticated route — not just `/orgs/:orgId/*` — runs
// under an established `app.current_org_id`.
//
// #181 taught the middleware to read the org from the request PATH (the
// `/orgs/:orgId/*` and `/orgs/.../projects/:projectId/*` segments). But the
// Phase-1 root API handlers are keyed by a RESOURCE id with no `orgs` segment —
// `POST /specs/:specId/runs`, `POST /runs/:runId/github/draft-pr`,
// `POST /runs/:runId/ci/poll`, `GET /runs/:runId` — so the actor resolved with
// NO org, no per-request scope was established, and the handler's tenant-table
// read returned RLS-empty (the live `spec_not_found` for a just-created spec).
//
// This module is the missing arm: given the request path, derive the addressed
// org from the RESOURCE id in the path (specs/runs/projects → its `org_id`),
// looked up on the BYPASSRLS `tanren_system` pool via `runWithSystemScope` (a
// pre-scope bootstrap read, exactly like actor-membership resolution). The auth
// middleware feeds the result into `resolveActorContext`, so the actor carries
// the right org, the per-request `runWithJobOrgId` scope is established, and the
// handler's `.query` self-scopes. The resolver NEVER widens access: the resolved
// org is still subject to the actor's membership check in `resolveActorContext`
// (a non-member resolves back to no org), and a missing/unknown resource yields
// `undefined` (the handler then 404s under its own scope, as before).

import { runWithSystemScope } from "@tanren/db";
import type pg from "pg";

/**
 * The path resource families that key a tenant row to its org. Each maps a path
 * marker segment (the one PRECEDING the id) to the table + column that carries
 * the id, so a single `runWithSystemScope` lookup resolves the org. The order is
 * most-specific first (a spec pins a single project+org; a project is broadest).
 */
const RESOURCE_LOOKUPS: ReadonlyArray<{
  /** The path segment that precedes the resource id (e.g. `specs` in `/specs/:specId`). */
  marker: string;
  /** The tenant table the id keys. */
  table: "specs" | "runs" | "projects";
  /** The id column on that table. */
  idColumn: "spec_id" | "run_id" | "project_id";
}> = [
  { marker: "specs", table: "specs", idColumn: "spec_id" },
  { marker: "runs", table: "runs", idColumn: "run_id" },
  { marker: "projects", table: "projects", idColumn: "project_id" },
];

/** The id immediately following `marker` in `path`, or `undefined` if absent. */
function pathSegmentAfter(path: string, marker: string): string | undefined {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  const index = segments.indexOf(marker);
  if (index === -1 || index + 1 >= segments.length) {
    return undefined;
  }
  return decodeURIComponent(segments[index + 1]!);
}

/**
 * Resolve the org the request path addresses by its RESOURCE id, or `undefined`
 * when the path carries no resolvable resource (or the resource is unknown). The
 * lookup runs on the BYPASSRLS system pool because it PRECEDES any org scope —
 * it is what discovers WHICH org to scope to. The first matching resource family
 * in the path wins (specs → runs → projects), which is the most-specific id the
 * route's handler will read.
 *
 * A `/orgs/:orgId/*` path is NOT resolved here — the middleware already derives
 * that org directly from the `orgs` path segment; this resolver is only consulted
 * for the resource-keyed root shapes where no `orgs` segment exists.
 */
export async function resolveRequestOrgFromResource(pool: pg.Pool, path: string): Promise<string | undefined> {
  for (const lookup of RESOURCE_LOOKUPS) {
    const resourceId = pathSegmentAfter(path, lookup.marker);
    if (resourceId === undefined) {
      continue;
    }
    const result = await runWithSystemScope(pool, (client) =>
      client.query<{ org_id: string | null }>(
        // The table + column are from the closed RESOURCE_LOOKUPS list (never the
        // request), so this interpolation cannot carry caller input; the id is a
        // bound parameter.
        `SELECT org_id FROM ${lookup.table} WHERE ${lookup.idColumn} = $1`,
        [resourceId],
      ),
    );
    const orgId = result.rows[0]?.org_id ?? null;
    if (orgId !== null) {
      return orgId;
    }
  }
  return undefined;
}
