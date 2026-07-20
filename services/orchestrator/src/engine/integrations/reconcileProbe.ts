// in-11 — the reconcile OBSERVATION seam.
//
// The durable reconciliation saga reconciles a project's DESIRED integration
// state against the ACTUAL external state. Observing that actual external state
// is the one operation that can genuinely FAIL TO CONFIRM (a provider API 504, an
// ambiguous response, a health the observer could not determine). That
// unconfirmable case is the whole reason the saga exists: it must fail-close to
// `state_unknown` rather than ever assume success on an unconfirmable state.
//
// `ReconcileProbe` is that observation, behind a contract so a live provider probe
// slots in as another impl (adapters over contracts, per the working rules) without
// touching the saga. The production impl (`RecordedStateReconcileProbe`) reconciles
// against the durably RECORDED external observation — the immutable
// `integration_resource_snapshots` other lifecycle nodes write — and returns
// `unconfirmable` when that recorded observation is genuinely ambiguous
// (`health = 'unknown'`), so the saga halts for attention instead of advancing.

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { IntegrationReconciliationPhase } from "../contracts/integrationStateWriter.js";

/** The reconcile inputs the observation reasons over — pinned lineage + prior progress. */
export interface ReconcileContext {
  readonly orgId: string;
  readonly projectId: string;
  readonly requirementId: string;
  readonly phase: IntegrationReconciliationPhase;
  readonly attempt: number;
  readonly bindingId: string | null;
  readonly bindingGeneration: number | null;
  /** The capability node's desired-state hash (the reconciliation's request_fingerprint). */
  readonly desiredStateHash: string;
}

/**
 * The four observation outcomes the saga interprets:
 *
 *   - `converged`     — the actual external state was CONFIRMED to match the desired
 *                       state (the reconcile reached its fixed point).
 *   - `progressing`   — the actual state was confirmed but is NOT YET the desired
 *                       state; `signal` is the STABLE identity of the observed state so
 *                       the saga can tell real forward motion (a changed signal) from a
 *                       genuine stall (an identical signal), never a wall-clock/counter.
 *   - `unconfirmable` — the external state could NOT be confirmed (provider 504 /
 *                       ambiguous / undeterminable health). The saga fail-closes to
 *                       `state_unknown`; it NEVER treats this as success.
 *   - `failed`        — the external state was confirmed to be a DEFINITE, terminal
 *                       failure (distinct from ambiguous): a human decision is needed.
 */
export type ReconcileObservation =
  | { readonly kind: "converged"; readonly observedStateHash: string; readonly observedState: Record<string, unknown> }
  | {
      readonly kind: "progressing";
      readonly signal: string;
      readonly magnitude?: number;
      readonly observedState: Record<string, unknown>;
    }
  | { readonly kind: "unconfirmable"; readonly classification: string; readonly observedState: Record<string, unknown> }
  | { readonly kind: "failed"; readonly classification: string; readonly observedState: Record<string, unknown> };

/** The observation contract. A thrown error is treated by the saga as `unconfirmable`. */
export interface ReconcileProbe {
  observe(context: ReconcileContext): Promise<ReconcileObservation>;
}

/** One recorded external-resource observation row the probe interprets. */
export interface RecordedSnapshotRow {
  observed_state_hash: string;
  health: string;
  provider_cursor: string | null;
  provider_etag: string | null;
  sanitized_snapshot: unknown;
}

/**
 * The production probe. It reconciles the desired state against the durably RECORDED
 * external observation for the requirement — the newest `integration_resource_snapshots`
 * row (the immutable, org-scoped observation the provider-observation lifecycle writes):
 *
 *   - `healthy`  → CONVERGED (the external resource is present and healthy).
 *   - `degraded` / `missing` → PROGRESSING (present-but-not-ready / not-yet-provisioned);
 *     the signal folds the observed hash + provider cursor/etag so genuine provisioning
 *     motion reads as progress and a true stall reads as an identical signal.
 *   - `unknown`  → UNCONFIRMABLE — the provider was reached but its state could not be
 *     determined (the 504/ambiguous analog). Fail-close to `state_unknown`.
 *   - NO snapshot yet → PROGRESSING with a stable `unobserved` signal: the observation
 *     may still arrive, so this retries rather than terminating; it is fail-closed
 *     because a persistently unobservable reconcile converges to a stall the saga
 *     escalates for attention — it NEVER auto-advances without a confirmed observation.
 *
 * A live provider probe is a future `ReconcileProbe` impl; nothing else changes.
 */
export class RecordedStateReconcileProbe implements ReconcileProbe {
  constructor(private readonly pool: pg.Pool) {}

  async observe(context: ReconcileContext): Promise<ReconcileObservation> {
    return runWithOrgScope(this.pool, context.orgId, async (client) => {
      const result = await client.query<RecordedSnapshotRow>(
        `SELECT observed_state_hash, health, provider_cursor, provider_etag, sanitized_snapshot
           FROM integration_resource_snapshots
          WHERE org_id = $1 AND project_id = $2 AND requirement_id = $3
          ORDER BY last_seen_at DESC, id DESC
          LIMIT 1`,
        [context.orgId, context.projectId, context.requirementId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        return {
          kind: "progressing",
          signal: "unobserved",
          observedState: { observed: "none" },
        };
      }
      return interpretSnapshot(row);
    });
  }
}

/** Map a recorded resource snapshot's health onto a reconcile observation. */
export function interpretSnapshot(row: RecordedSnapshotRow): ReconcileObservation {
  const observedState: Record<string, unknown> = {
    observedStateHash: row.observed_state_hash,
    health: row.health,
    ...(row.provider_cursor === null ? {} : { providerCursor: row.provider_cursor }),
    ...(row.provider_etag === null ? {} : { providerEtag: row.provider_etag }),
  };
  const stateIdentity = `${row.observed_state_hash}:${row.provider_cursor ?? ""}:${row.provider_etag ?? ""}`;
  switch (row.health) {
    case "healthy":
      return { kind: "converged", observedStateHash: row.observed_state_hash, observedState };
    case "degraded":
      return { kind: "progressing", signal: `degraded:${stateIdentity}`, observedState };
    case "missing":
      return { kind: "progressing", signal: `missing:${stateIdentity}`, observedState };
    case "unknown":
      return { kind: "unconfirmable", classification: "provider_observation_unknown", observedState };
    default:
      // A health outside the recorded vocabulary cannot be reasoned about → unconfirmable.
      return { kind: "unconfirmable", classification: `unrecognized_health:${row.health}`, observedState };
  }
}
