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
// `integration_resource_snapshots` other lifecycle nodes write.
//
// TWO FAIL-CLOSED INVARIANTS (layer-2 audit):
//   1. A health flag is NEVER desired-state confirmation. Convergence requires the
//      snapshot's `observed_state_hash` to EXACTLY equal the reconciliation's desired
//      digest (`request_fingerprint`, threaded as `desiredStateHash`). A healthy but
//      drifted observation is PROGRESSING (a changed observed hash drives retry), not
//      converged — so a drifted/unconfirmed state can never ready the capability node.
//   2. The observation is scoped to the reconciliation's PINNED binding coordinate
//      (`bindingId` + `bindingGeneration`). A snapshot for a prior generation, a
//      sibling resource, or an unbound observation is NOT the confirmation of THIS
//      generation. No snapshot for the pinned coordinate → `unconfirmable`
//      (state_unknown), never "use the newest for the requirement".

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { IntegrationReconciliationPhase } from "../contracts/integrationStateWriter.js";

/** The reconcile inputs the observation reasons over — pinned lineage + desired digest. */
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
 *   - `converged`     — the actual external state was CONFIRMED to EXACTLY match the
 *                       desired state (observed digest === desired digest).
 *   - `progressing`   — the actual state was confirmed but is NOT YET (or no longer)
 *                       the desired state; `signal` is the STABLE identity of the
 *                       observed state so the saga can tell real forward motion (a
 *                       changed signal) from a genuine stall (an identical signal).
 *   - `unconfirmable` — the external state could NOT be confirmed (provider 504 /
 *                       ambiguous health / no observation for the pinned generation).
 *                       The saga fail-closes to `state_unknown`; NEVER treats as success.
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
 * external observation for the reconciliation's PINNED binding coordinate — the newest
 * `integration_resource_snapshots` row scoped to `(requirement, bindingId,
 * bindingGeneration)` (the immutable, org-scoped observation the provider-observation
 * lifecycle writes). No snapshot for that exact coordinate is `unconfirmable`
 * (fail-closed) — never the newest-for-requirement.
 *
 *   - `healthy` + observed hash === desired → CONVERGED.
 *   - `healthy` + observed hash ≠ desired    → PROGRESSING (drift; the observed hash
 *     is folded into the signal, so a resolving drift reads as progress and a stable
 *     drift eventually escalates to attention — it NEVER readies the node).
 *   - `degraded` / `missing` → PROGRESSING (present-but-not-ready / not-yet-provisioned).
 *   - `unknown` / unrecognized → UNCONFIRMABLE (the 504/ambiguous analog).
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
            AND binding_id IS NOT DISTINCT FROM $4
            AND binding_generation IS NOT DISTINCT FROM $5
          ORDER BY last_seen_at DESC, id DESC
          LIMIT 1`,
        [context.orgId, context.projectId, context.requirementId, context.bindingId, context.bindingGeneration],
      );
      const row = result.rows[0];
      if (row === undefined) {
        // No confirmed observation for the PINNED binding coordinate — the external
        // state is unconfirmable for this reconciliation; fail closed (never advance).
        return {
          kind: "unconfirmable",
          classification: "no_observation_for_pinned_generation",
          observedState: {
            requirementId: context.requirementId,
            bindingGeneration: context.bindingGeneration,
          },
        };
      }
      return interpretSnapshot(row, context.desiredStateHash);
    });
  }
}

/** Map a recorded resource snapshot's health onto a reconcile observation. */
export function interpretSnapshot(row: RecordedSnapshotRow, desiredStateHash: string): ReconcileObservation {
  const observedState: Record<string, unknown> = {
    observedStateHash: row.observed_state_hash,
    health: row.health,
    ...(row.provider_cursor === null ? {} : { providerCursor: row.provider_cursor }),
    ...(row.provider_etag === null ? {} : { providerEtag: row.provider_etag }),
  };
  const stateIdentity = `${row.observed_state_hash}:${row.provider_cursor ?? ""}:${row.provider_etag ?? ""}`;
  switch (row.health) {
    case "healthy":
      // A health flag is NOT desired-state confirmation. Only an EXACT observed==desired
      // digest match is convergence; a healthy-but-drifted observation keeps reconciling
      // (progress-based retry) and never readies the node.
      return row.observed_state_hash === desiredStateHash
        ? { kind: "converged", observedStateHash: row.observed_state_hash, observedState }
        : { kind: "progressing", signal: `drift:${stateIdentity}`, observedState };
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
