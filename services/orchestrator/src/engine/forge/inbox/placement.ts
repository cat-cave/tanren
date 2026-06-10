// Project-placement resolver for routable candidates (autonomy-loop Loop 6 —
// never silent-stall a routable feature request). Shared by the intake pipeline
// (push/report) and the ingest engine (poller/webhook). An org-scoped feature
// request can be triaged
// `auto_routable` yet arrive with `projectId: null` (a default/org-scoped source).
// The auto-route guard (`candidate.projectId !== null`) would then silently drop it
// in the inbox — triaged-as-routable but never a spec. That silent stall is the
// gap. This resolver decides placement BEFORE auto-route:
//
//   • exactly ONE project in the org → PLACE the candidate there (the unambiguous
//     "the org's single project" case) and let auto-route commit the spec.
//   • zero OR many projects → AMBIGUOUS: a human must choose. Surface it LOUD
//     (needs_attention), never a silent inbox pass-through.
//
// Reads are org-scoped under RLS (`runWithOrgScope`) so the project list is bounded
// to the candidate's tenant.

import type pg from "pg";
import { runWithOrgScope } from "@tanren/db";
import { systemActor } from "../../state/actor.js";
import { ProjectStore } from "../../repositories/index.js";

// Why an ambiguous placement can't be auto-resolved: the org has no project to
// place into, or more than one (a human must choose which).
export type PlacementAmbiguityReason = "no_project" | "multiple_projects";

export type PlacementResolution =
  | { kind: "placed"; projectId: string }
  // Ambiguous: the org has 0 or >1 projects, so an autonomous placement can't pick
  // one. The candidate must escalate to a human (needs_attention), not stall.
  | { kind: "needs_attention"; reason: PlacementAmbiguityReason; projectCount: number };

/**
 * Resolve which project a project-less, routable candidate belongs to. Lists the
 * org's projects (org-scoped under RLS); a single project is the unambiguous
 * placement, anything else is a needs_attention escalation (loud), never a silent
 * inbox-stall. Pure decision — the caller performs the placement write / escalation.
 */
export async function resolveProjectPlacement(pool: pg.Pool, orgId: string): Promise<PlacementResolution> {
  const projects = await runWithOrgScope(pool, orgId, (client) => ProjectStore.listForOrg(client, orgId, systemActor));
  if (projects.length === 1) {
    return { kind: "placed", projectId: projects[0]!.projectId };
  }
  return {
    kind: "needs_attention",
    reason: projects.length === 0 ? "no_project" : "multiple_projects",
    projectCount: projects.length,
  };
}
