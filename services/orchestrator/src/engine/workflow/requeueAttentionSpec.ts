// The human-in-the-loop resolution of a `needs_attention` escalation (the operator
// API gap a live run surfaced). When a spec exhausts its bounded re-enqueue
// budget (the NEVER-STRAND reconciler) or hits a genuinely irreconcilable merge
// conflict, it parks at the terminal `needs_attention` status — freeing the DAG slot
// but blocking its dependents. There is no AUTO exit: a human must DECIDE how to
// unblock it (the escalation discipline). This module is that decision's write path:
// once the operator has ADDRESSED the underlying blocker they call `requeue`, which
//
//   1. ATOMICALLY flips the spec `needs_attention → open` (guarded so ONLY a parked
//      spec flips — a running/merged/open spec is a clean no-op-or-error, never a
//      silent re-transition), so the autonomous DagWalker re-picks it up;
//   2. emits a loud, actor-stamped `dag.spec.attention_resolved` audit event (the
//      "addressed, proceed" counterpart to `dag.spec.needs_attention`); and
//   3. wakes the DagWalker for the project (a re-opened spec has no run-terminal
//      notification to re-trigger the walker, so we notify the DAG channel directly).
//
// The `dag.spec.attention_resolved` event also marks the budget-reset boundary for the
// merge-conflict re-plan cap: the conflict resolver counts only the re-plan-routed
// events AFTER the most recent resolution, so an operator-requeued spec genuinely
// re-runs the full retry budget rather than immediately re-escalating.

import { getSystemPool, notifyDagChanged, runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import { PgEventStore } from "../eventStore.js";
import { ProjectAccessDeniedError, SpecNotFoundError } from "./projectSpecErrors.js";

/** The only status from which the operator-resolution requeue may re-enter the DAG. */
const RESOLVABLE_FROM_STATUS = "needs_attention";

/**
 * Raised when an operator tries to resolve a `needs_attention` escalation (the
 * `requeue` endpoint) on a spec that is NOT parked at `needs_attention`. A clean
 * no-op-or-error: never silently transition a running/merged/open spec out of its
 * real state — the resolution action only applies to a parked one. (It lives here,
 * with its sole producer, to keep `projectSpecErrors.ts` under the class cap; it is
 * re-exported from `projectSpec.ts` so callers import it from the one place.)
 */
export class SpecNotInAttentionError extends Error {
  constructor(
    readonly specId: string,
    readonly status: string,
  ) {
    super(`spec ${specId} is not parked at needs_attention (status ${status}); nothing to resolve`);
    this.name = "SpecNotInAttentionError";
  }
}

/** The subsystem that had parked the spec, mirrored onto the resolution event. */
type AttentionSource = "strand" | "merge_conflict";

export interface RequeueAttentionResult {
  specId: string;
  projectId: string;
  /** The status the spec now holds — always the canonical re-entry status `open`. */
  status: "open";
  /** Which subsystem had parked the spec (read from the latest needs_attention event). */
  fromSource: AttentionSource;
}

/**
 * Resolve a `needs_attention` escalation and re-queue the spec. Org-scoped under RLS
 * (the actor MUST carry the project's org). The flip is a single guarded UPDATE: a
 * spec not parked at `needs_attention` matches zero rows ⇒ a typed
 * `SpecNotInAttentionError` (a clean 409 at the route), never a silent transition.
 */
export async function requeueAttentionSpec(
  pool: pg.Pool,
  input: { specId: string },
  actor: ActorContext,
): Promise<RequeueAttentionResult> {
  const orgId = actor.orgId;
  if (orgId === undefined || orgId === null) {
    // The route's org-admin gate guarantees an org-carrying actor; defend the seam.
    throw new ProjectAccessDeniedError(input.specId);
  }
  return runWithOrgScope(pool, orgId, async (client) => {
    // Load the spec under the org scope (RLS: a spec in another org is invisible →
    // SpecNotFoundError, not a leak).
    const specRow = await client.query<{ project_id: string; status: string }>(
      "SELECT project_id, status FROM specs WHERE spec_id = $1",
      [input.specId],
    );
    const found = specRow.rows[0];
    if (found === undefined) {
      throw new SpecNotFoundError(input.specId);
    }
    if (found.status !== RESOLVABLE_FROM_STATUS) {
      // Only `needs_attention → open` is the operator-resolution transition (the spec
      // state machine permits exactly that one exit). Any other current status
      // (running/merged/open/…) is rejected — never silently re-flipped.
      throw new SpecNotInAttentionError(input.specId, found.status);
    }
    const projectId = found.project_id;

    // ATOMIC guarded flip: re-check `status = 'needs_attention'` IN the same UPDATE so a
    // concurrent resolution (two operators racing) flips exactly once — the loser
    // matches zero rows and re-raises the typed error (idempotent, no double-emit).
    const flip = await client.query<{ spec_id: string }>(
      "UPDATE specs SET status = 'open' WHERE spec_id = $1 AND status = 'needs_attention' RETURNING spec_id",
      [input.specId],
    );
    if (flip.rowCount === 0) {
      throw new SpecNotInAttentionError(input.specId, found.status);
    }

    const fromSource = await readLatestAttentionSource(projectId, input.specId);

    // The actor-stamped resolution audit event (non-secret: spec id + enum label +
    // user id). Through the org-scoped event store (the same seam every spec event uses).
    // orgId is the actor's (validated non-null above) — events.org_id is NOT NULL
    // (v68 fix; AppendEventInput requires explicit orgId rather than the prior
    // derive-from-project subquery).
    await new PgEventStore(client).append({
      specId: input.specId,
      projectId,
      orgId,
      eventType: "dag.spec.attention_resolved",
      payload: { specId: input.specId, fromSource, resolvedBy: actor.userId },
    });

    // Wake the DagWalker: a re-opened spec has no run-terminal notification to re-trigger
    // the walker, so notify the DAG channel directly (rides this tx's COMMIT).
    await notifyDagChanged(client, projectId);

    return { specId: input.specId, projectId, status: "open", fromSource };
  });
}

/**
 * Read the `source` of the spec's most recent `dag.spec.needs_attention` event so the
 * resolution event names which subsystem it answers. The `events` table is REVOKED for
 * the de-privileged data-plane role (0031), so this SELECT runs on the BYPASSRLS system
 * pool when wired — still org-scoped on top (the caller's `runWithOrgScope` already set
 * `app.current_org_id`; the system pool widens only the ROLE, not the tenant). Defaults
 * to `strand` when no escalation event is found (e.g. a manually-parked spec) — the
 * common §2c source — so the audit is never blank.
 */
async function readLatestAttentionSource(projectId: string, specId: string): Promise<AttentionSource> {
  const readPool = getSystemPool();
  if (readPool === undefined || readPool === null) {
    // No system pool wired (in-process / test): the caller's org-scoped client below
    // can read events directly. Fall through to the default — the source is advisory
    // (the resolution stands regardless), so a missing read never blocks the requeue.
    return "strand";
  }
  // The org GUC is already set by the enclosing runWithOrgScope on the dataplane
  // connection, but the system pool is a DIFFERENT connection; re-resolve + re-scope it
  // so the read stays org-scoped on the widened role.
  const orgRow = await readPool.query<{ org_id: string | null }>("SELECT org_id FROM projects WHERE project_id = $1", [
    projectId,
  ]);
  const orgId = orgRow.rows[0]?.org_id ?? null;
  if (orgId === null) return "strand";
  return runWithOrgScope(readPool, orgId, async (scoped) => {
    const result = await scoped.query<{ payload: unknown }>(
      `SELECT payload FROM events
        WHERE spec_id = $1 AND event_type = 'dag.spec.needs_attention'
        ORDER BY id DESC LIMIT 1`,
      [specId],
    );
    const payload = result.rows[0]?.payload;
    const source = (payload as { source?: unknown } | undefined)?.source;
    return source === "merge_conflict" ? "merge_conflict" : "strand";
  });
}
