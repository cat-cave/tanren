// The LIVE wiring of the template-build SELF-RECOVERY seam (recovery.ts). Composes
// the four live touches `recoverStrandedTemplateBuild` needs from the real infra:
//
//   - loadSnapshot               → the SAME pg-backed DAG read model the build driver
//                                  polls convergence with (terminal-blocked specs).
//   - resetStrandedSpec          → an org-scoped guarded UPDATE that flips a
//                                  terminally-blocked spec (`halted`/`cancelled`/
//                                  `needs_attention`) back to `open` + emits a loud
//                                  `dag.spec.attention_resolved`-style record + wakes
//                                  the DagWalker (so the spec re-drives from scratch).
//   - priorRecoveryCount         → COUNT of prior `template.build.recovered` events for
//                                  the build project (the durable attempt counter that
//                                  BOUNDS the recovery — survives derives/restarts).
//   - hasPublishedValidatedTemplate → whether this build already published a validated
//                                  template (the succeeded-build short-circuit).
//
// This is the SINGLE construction site (`buildLiveTemplateBuildRecovery`) — `createFlow`
// wires it into `CreateTemplateDeps.recovery`. Every read/write is org-scoped (RLS),
// resolving the build project's org system-scoped first (the SAME bootstrap the walker
// read model uses to discover an org before any tenant work).

import { notifyDagChanged, runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import type { ActorContext } from "../../../auth/schemas.js";
import { PgDagReadModel } from "../../dag/walker.js";
import { PgEventStore } from "../../eventStore.js";
import { TemplateStore } from "../../repositories/templates.js";
import type { TemplateBuildRecoveryDeps } from "./recovery.js";

// The spec statuses the recovery resets back to `open` — the THREE terminal-blocked
// states the DAG read model classifies as `terminal_blocked` (a stranded
// strand-reconciler escalation, an operator/worker halt, or a cancellation). Resetting
// to `open` is the generic "requeue this stranded work" the recovery automates — the
// DagWalker then re-drives the spec from scratch with the current code.
const TERMINAL_BLOCKED_STATUSES = ["needs_attention", "halted", "cancelled"] as const;

/** Resolve a build project's org system-scoped (the walker read model's bootstrap). */
async function resolveProjectOrg(pool: pg.Pool, projectId: string): Promise<string | null> {
  return runWithSystemScope(pool, async (client) => {
    const result = await client.query<{ org_id: string | null }>("SELECT org_id FROM projects WHERE project_id = $1", [
      projectId,
    ]);
    return result.rows[0]?.org_id ?? null;
  });
}

// Build the LIVE `TemplateBuildRecoveryDeps` from the orchestrator pool + actor. The
// `maxAttempts` is the recovery cap (defaults inside `recoverStrandedTemplateBuild`).
export function buildLiveTemplateBuildRecovery(
  pool: pg.Pool,
  actor: ActorContext,
  options?: { maxAttempts?: number },
): TemplateBuildRecoveryDeps {
  const readModel = new PgDagReadModel(pool);
  return {
    loadSnapshot: (projectId) => readModel.loadSnapshot(projectId),
    resetStrandedSpec: (input) => resetStrandedSpec(pool, input),
    priorRecoveryCount: (projectId) => priorRecoveryCount(pool, projectId),
    hasPublishedValidatedTemplate: (projectId) => hasPublishedValidatedTemplate(pool, actor, projectId),
    events: new PgEventStore(pool),
    ...(options?.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
  };
}

// Flip ONE terminally-blocked spec back to `open` (re-drivable). Org-scoped; a single
// guarded UPDATE (`status IN (terminal-blocked set)`) so a spec NO LONGER blocked
// (a concurrent recovery) matches zero rows ⇒ returns false (skip), never a silent
// re-transition of a running/merged/open spec. On a real reset it emits the loud,
// durable `dag.spec.attention_resolved` record (the "addressed, proceed" counterpart,
// `resolvedBy: 'tanren-self-recovery'` — the autonomous requeue, mirroring the operator
// requeue) and wakes the DagWalker so the re-opened spec re-drives (a re-opened spec has
// no run-terminal notification to re-trigger the walker).
async function resetStrandedSpec(pool: pg.Pool, input: { projectId: string; specId: string }): Promise<boolean> {
  const orgId = await resolveProjectOrg(pool, input.projectId);
  if (orgId === null) return false;
  return runWithOrgScope(pool, orgId, async (client) => {
    const flip = await client.query<{ spec_id: string }>(
      `UPDATE specs SET status = 'open'
        WHERE spec_id = $1 AND project_id = $2 AND status = ANY($3)
        RETURNING spec_id`,
      [input.specId, input.projectId, [...TERMINAL_BLOCKED_STATUSES]],
    );
    if (flip.rowCount === 0) return false;

    // The autonomous "addressed, proceed" record — the self-recovery counterpart to the
    // operator's `dag.spec.attention_resolved`. `fromSource: strand` (the strand the
    // recovery cleared); `resolvedBy` names the self-recovery, never a human user id.
    await new PgEventStore(client).append({
      specId: input.specId,
      projectId: input.projectId,
      eventType: "dag.spec.attention_resolved",
      payload: { specId: input.specId, fromSource: "strand", resolvedBy: "tanren-self-recovery" },
    });

    // Wake the DagWalker: a re-opened spec has no run-terminal notification to re-trigger
    // it, so notify the DAG channel directly (rides this tx's COMMIT).
    await notifyDagChanged(client, input.projectId);
    return true;
  });
}

// COUNT prior `template.build.recovered` events for the build project — the durable
// attempt counter that bounds the recovery. Org-scoped (RLS); read off the event log,
// not an in-memory counter, so the bound survives across derives/restarts.
async function priorRecoveryCount(pool: pg.Pool, projectId: string): Promise<number> {
  const orgId = await resolveProjectOrg(pool, projectId);
  if (orgId === null) return 0;
  return runWithOrgScope(pool, orgId, async (client) => {
    const result = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM events
        WHERE project_id = $1 AND event_type = 'template.build.recovered'`,
      [projectId],
    );
    return Number(result.rows[0]?.count ?? "0");
  });
}

// Whether this build project already published a validated template — the succeeded-
// build short-circuit. Org-scoped under the actor (RLS bounds the template rows to the
// org's own + the official catalogue).
async function hasPublishedValidatedTemplate(pool: pg.Pool, actor: ActorContext, projectId: string): Promise<boolean> {
  const orgId = actor.orgId;
  if (orgId === undefined || orgId === null) return false;
  return runWithOrgScope(pool, orgId, async (client) => {
    const existing = await TemplateStore.findValidatedByBuildProject(client, projectId, { kind: "operator" });
    return existing !== undefined;
  });
}
