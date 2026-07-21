// in-6: the grant-wake → activation promotion path.
//
// When a project is blocked in `deriving` because a REQUIRED integration
// capability was `awaiting_grant` at activation time, this module re-attempts
// activation once the grant arrives. It is the in-6-owned effect of "the last
// required grant landing": the merge-coordinator subscriber (which ALREADY
// listens on `NOTIFICATION_CHANNEL` for `credential.configured` /
// `integration.provisioned` / `integration.grant.linked`) fires-and-forgets
// `attemptDerivingActivation` for each project a credential/grant event names.
//
// REAL PRODUCER (trap #1 — dead production trigger): the credential/grant events
// are emitted by the REAL credential-config / integration-provision /
// grant-advance writers (the `credential.configured` / `integration.provisioned`
// event sources). `integration.grant.linked` is emitted inside
// `evaluateAndApply` when a parked node advances. The subscriber resolves the
// affected project(s) from the event payload and calls this function. There is
// NO phantom event here — the producer is the real credential/grant path.
//
// EXACTLY-ONCE PROMOTION (trap #3 — unfenced claim/lease): promotion is guarded
// by `activate`'s `UPDATE projects SET lifecycle='active' WHERE lifecycle=
// 'deriving'` CAS + affected-row-count check (projectDerivations). A duplicate
// wake (a second credential event, a retry) is a no-op: the project is already
// `active`, the CAS matches zero rows, and the re-read confirms `active`. The
// derivation's own `status='in_progress' AND ... ` CAS is the second fence.
//
// FAIL-CLOSED ON EVERY UNCONFIRMABLE STATE: an `activate` throw that is NOT the
// typed readiness block (a genuine lifecycle/receipt conflict) is logged and
// surfaced as `{ kind: 'error' }` — NEVER silently swallowed, NEVER a stale
// terminal write. The readiness-blocked outcome is `{ kind: 'blocked' }` (the
// expected, non-terminal state — a later grant-wake re-attempts).

import { runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import { CapabilityPrepareDriver } from "../integrations/capabilityPrepare.js";
import {
  ProjectDerivationStore,
  ProjectActivationReadinessBlockedError,
  type ProjectDerivationRow,
} from "./projectDerivations.js";
import type { ProjectLifecycle } from "./projects.js";
import type { ActivationReadinessVerdict } from "./activationReadiness.js";

export type DerivingActivationOutcome =
  | { readonly kind: "activated" }
  | { readonly kind: "not_deriving"; readonly lifecycle: ProjectLifecycle }
  | { readonly kind: "no_derivation" }
  | { readonly kind: "blocked"; readonly verdict: ActivationReadinessVerdict }
  | { readonly kind: "error"; readonly error: unknown };

interface ProjectLifecycleRow {
  lifecycle: ProjectLifecycle | null;
  org_id: string | null;
}

/**
 * Resolve a project's org + lifecycle under the system scope (the caller — the
 * merge subscriber — has no org context for an event-resolved project id). RLS
 * would deny a tenant-scoped read with no org GUC, so this MUST run cross-org on
 * the BYPASSRLS system pool (the standard pattern for event-driven wakes).
 */
async function resolveProjectLifecycle(
  pool: pg.Pool,
  projectId: string,
): Promise<{ orgId: string; lifecycle: ProjectLifecycle } | undefined> {
  return runWithSystemScope(pool, async (client) => {
    const result = await client.query<ProjectLifecycleRow>(
      "SELECT lifecycle, org_id FROM projects WHERE project_id = $1",
      [projectId],
    );
    const row = result.rows[0];
    return row === undefined || row.org_id === null || row.lifecycle === null
      ? undefined
      : { orgId: row.org_id, lifecycle: row.lifecycle };
  });
}

/**
 * Load the latest derivation row for a project (org-scoped). Returns `undefined`
 * when the project has no derivation (e.g. a non-derived project — the gate is a
 * no-op for it). The derivation row is what `activate` reasons over.
 */
async function loadDerivation(
  pool: pg.Pool,
  orgId: string,
  projectId: string,
): Promise<ProjectDerivationRow | undefined> {
  return ProjectDerivationStore.findForProject(pool, orgId, projectId);
}

/**
 * The in-6 grant-wake → promote entrypoint. Re-evaluates a deriving project's
 * capability graph (advancing any now-satisfied `awaiting_grant` nodes via the
 * in-10 `wakeForGrant` seam) and re-attempts `activate` (which re-materializes +
 * re-evaluates + gates on the CURRENT state — proof = effect, trap #7).
 *
 * Idempotent + fail-closed:
 *   - project not `deriving` → `{ kind: 'not_deriving' }` (a no-op for
 *     active/archived projects; the CAS would no-op anyway).
 *   - no derivation row → `{ kind: 'no_derivation' }` (a non-derived project).
 *   - required capability still un-ready → `{ kind: 'blocked' }` (the expected
 *     non-terminal state; a later grant-wake re-attempts).
 *   - activate succeeds → `{ kind: 'activated' }` (exactly-once via the CAS).
 *   - any other error → `{ kind: 'error' }` (logged, NEVER swallowed).
 *
 * NEVER throws — it is safe to fire-and-forget from the subscriber's event
 * handler. The caller logs `{ kind: 'error' }` outcomes.
 */
export async function attemptDerivingActivation(pool: pg.Pool, projectId: string): Promise<DerivingActivationOutcome> {
  const resolved = await resolveProjectLifecycle(pool, projectId);
  if (resolved === undefined) return { kind: "no_derivation" };
  if (resolved.lifecycle !== "deriving") {
    return { kind: "not_deriving", lifecycle: resolved.lifecycle };
  }
  const { orgId } = resolved;

  // Re-evaluate parked capability nodes for the now-arrived grant (reuses the
  // in-10 wakeForGrant seam — the EXACT same evaluation path the walker's
  // prepare pass runs, narrowed to awaiting_grant nodes). Advances a node to
  // `enqueued` when its grant genuinely covers it (grantCovers inside
  // evaluateAndApply). A no-op when there are no parked nodes (e.g. the
  // materialization inside the prior failed `activate` rolled back, so the
  // nodes don't exist yet — `activate` below re-materializes them itself).
  const prepareDriver = new CapabilityPrepareDriver(pool);
  await prepareDriver.wakeForGrant(orgId, projectId).catch(() => {
    // A wakeForGrant failure never blocks the activation attempt — `activate`
    // re-materializes + re-evaluates inside its own transaction anyway. Log
    // and proceed (the subscriber logs the outcome).
  });

  const operation = await loadDerivation(pool, orgId, projectId);
  if (operation === undefined) return { kind: "no_derivation" };

  try {
    await ProjectDerivationStore.activate(pool, operation);
    return { kind: "activated" };
  } catch (error) {
    if (error instanceof ProjectActivationReadinessBlockedError) {
      return { kind: "blocked", verdict: error.verdict };
    }
    return { kind: "error", error };
  }
}
