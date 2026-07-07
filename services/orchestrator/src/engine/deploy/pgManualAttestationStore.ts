// The Postgres-backed {@link ManualAttestationStore} — the DURABLE persistence tier
// the `manual_external` DeployAdapter writes its pending-manual-confirmation
// attestations into (Codex H3 Surface 7 finding #20). The pre-fix
// `InMemoryManualAttestationStore` was a process-local `Map`, so a restart lost every
// attestation; every `manual_external` `verify()` post-restart then threw "no
// recorded attestation" or (worse, under the #21 flow) silently succeeded on the
// rubber-stamped `attested` state. This store persists to the `manual_deploy_attestations`
// table (see `db/src/schemaDeploy.ts` + migration 0029) so the attestation SURVIVES a
// restart AND records the operator's confirmation-audit trail durably.
//
// SCOPING — org-scoped under RLS. Every read/write runs inside `runWithOrgScope`
// (the RLS 3a-style direct-org_id policy admits rows only when
// `app.current_org_id` matches). A caller that supplies the wrong org sees ZERO
// rows (the RLS deny-by-default, mirrored in `InMemoryManualAttestationStore` for
// parity). NO empty-on-missing-org silent fallback — a system-scoped
// {@link resolveRowOrg} lookup is used ONLY by `read` to bootstrap the org from
// the row's primary key (`deployment_id`) when the caller has none (the run
// watcher's verify pass), same pattern as `PgPostMergeIssueClaimStore`.
//
// IDEMPOTENCE — `record` UPSERTs on `deployment_id`. A re-record for a
// same-deployment retry preserves the confirmation trail on an already-confirmed
// row (the state check + `confirmed_at`/`confirmed_by` preservation is enforced
// by the SQL — never re-clears the audit trail).
//
// FAIL-CLOSED — a DB error PROPAGATES loud. A silently-swallowed store failure
// would defeat the very durability this store restores.

import { runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import type {
  ManualAttestationConfirmInput,
  ManualAttestationConfirmResult,
  ManualAttestationRecord,
  ManualAttestationRecordInput,
  ManualAttestationState,
  ManualAttestationStore,
  ManualExternalSurfaceKind,
} from "./manualAttestationStore.js";

/** The raw row shape as it lands off `pg` — every column NON-SECRET. */
interface ManualAttestationRow {
  deployment_id: string;
  org_id: string;
  project_id: string;
  app_id: string;
  source_repo: string;
  source_ref: string;
  url: string;
  surface_kind: string;
  state: string;
  recorded_at: Date;
  confirmed_at: Date | null;
  confirmed_by: string | null;
}

function assertSurfaceKind(value: string): ManualExternalSurfaceKind {
  if (value === "web_url" || value === "download") return value;
  throw new Error(
    `manual_deploy_attestations: unknown surface_kind '${value}' — schema check should have prevented this`,
  );
}

function assertState(value: string): ManualAttestationState {
  if (value === "pending_manual_confirmation" || value === "confirmed") return value;
  throw new Error(`manual_deploy_attestations: unknown state '${value}' — schema check should have prevented this`);
}

function rowToRecord(row: ManualAttestationRow): ManualAttestationRecord {
  return {
    deploymentId: row.deployment_id,
    orgId: row.org_id,
    projectId: row.project_id,
    appId: row.app_id,
    attestation: {
      url: row.url,
      surfaceKind: assertSurfaceKind(row.surface_kind),
      source: { repo: row.source_repo, ref: row.source_ref },
    },
    state: assertState(row.state),
    recordedAt: row.recorded_at,
    confirmedAt: row.confirmed_at,
    confirmedBy: row.confirmed_by,
  };
}

/**
 * The Postgres-backed manual-deploy attestation store. Wired into
 * `buildDeployAdapter` in production so `manual_external` deploys land in a
 * DURABLE row (Codex H3 #20). All reads/writes run under the row's org scope
 * (RLS deny-by-default).
 */
export class PgManualAttestationStore implements ManualAttestationStore {
  constructor(private readonly pool: pg.Pool) {}

  async record(input: ManualAttestationRecordInput): Promise<void> {
    await runWithOrgScope(this.pool, input.orgId, async (client) => {
      // UPSERT: a re-record for the same deploymentId preserves the confirmation
      // trail on an already-confirmed row (never re-clears `confirmed_at` /
      // `confirmed_by`), and DOES refresh the attested URL / source ref (a re-
      // deploy of the same merged commit may re-declare the target). The state
      // itself is preserved on the confirmed side — an idempotent re-record
      // never re-triggers a fresh confirmation cycle.
      await client.query(
        `INSERT INTO manual_deploy_attestations
           (deployment_id, org_id, project_id, app_id, source_repo, source_ref, url, surface_kind, state)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending_manual_confirmation')
         ON CONFLICT (deployment_id) DO UPDATE
           SET org_id = EXCLUDED.org_id,
               project_id = EXCLUDED.project_id,
               app_id = EXCLUDED.app_id,
               source_repo = EXCLUDED.source_repo,
               source_ref = EXCLUDED.source_ref,
               url = EXCLUDED.url,
               surface_kind = EXCLUDED.surface_kind
         `,
        [
          input.deploymentId,
          input.orgId,
          input.projectId,
          input.appId,
          input.attestation.source.repo,
          input.attestation.source.ref,
          input.attestation.url,
          input.attestation.surfaceKind,
        ],
      );
    });
  }

  async read(deploymentId: string): Promise<ManualAttestationRecord | undefined> {
    // Bootstrap the org from the row's primary key (system-scoped), then read
    // the row under that org's RLS scope. Mirrors `PgPostMergeIssueClaimStore`'s
    // `resolveRunOrg` — the caller only carries the deploymentId (the run-watcher
    // verify pass), so the org must be resolved from the row itself.
    const orgId = await this.resolveRowOrg(deploymentId);
    if (orgId === null) return undefined;
    return runWithOrgScope(this.pool, orgId, async (client) => {
      const result = await client.query<ManualAttestationRow>(
        `SELECT deployment_id, org_id, project_id, app_id, source_repo, source_ref, url,
                surface_kind, state, recorded_at, confirmed_at, confirmed_by
           FROM manual_deploy_attestations
          WHERE deployment_id = $1`,
        [deploymentId],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : rowToRecord(row);
    });
  }

  async confirm(input: ManualAttestationConfirmInput): Promise<ManualAttestationConfirmResult | undefined> {
    return runWithOrgScope(this.pool, input.orgId, async (client) => {
      // Idempotent flip: only a `pending_manual_confirmation` row flips (the
      // WHERE guard). An already-confirmed row is returned unchanged (the SELECT
      // fallback below), never re-writing the audit trail. A missing row is
      // reported as `undefined` (the route decides whether to 404). The
      // `freshlyConfirmed` discriminator on the return tells the caller which
      // arm ran — so the confirmation route emits `deploy.manual_confirmed`
      // ONLY on the fresh flip (no duplicate events on re-confirm).
      const updated = await client.query<ManualAttestationRow>(
        `UPDATE manual_deploy_attestations
            SET state = 'confirmed', confirmed_at = now(), confirmed_by = $2
          WHERE deployment_id = $1
            AND state = 'pending_manual_confirmation'
          RETURNING deployment_id, org_id, project_id, app_id, source_repo, source_ref, url,
                    surface_kind, state, recorded_at, confirmed_at, confirmed_by`,
        [input.deploymentId, input.confirmedBy],
      );
      const flipped = updated.rows[0];
      if (flipped !== undefined) return { record: rowToRecord(flipped), freshlyConfirmed: true };
      // Fall through: a same-org row that was ALREADY confirmed still round-trips
      // (idempotent — the operator hit the endpoint twice), so read the current
      // row under the same org scope and return it. If no row is visible the org
      // did not own it (or it never existed) → undefined (a 404 from the route).
      const existing = await client.query<ManualAttestationRow>(
        `SELECT deployment_id, org_id, project_id, app_id, source_repo, source_ref, url,
                surface_kind, state, recorded_at, confirmed_at, confirmed_by
           FROM manual_deploy_attestations
          WHERE deployment_id = $1`,
        [input.deploymentId],
      );
      const row = existing.rows[0];
      return row === undefined ? undefined : { record: rowToRecord(row), freshlyConfirmed: false };
    });
  }

  /** Resolve the row's org (system-scoped) so a bootstrap read can scope its own RLS txn. */
  private async resolveRowOrg(deploymentId: string): Promise<string | null> {
    return runWithSystemScope(this.pool, async (client) => {
      const result = await client.query<{ org_id: string }>(
        "SELECT org_id FROM manual_deploy_attestations WHERE deployment_id = $1",
        [deploymentId],
      );
      return result.rows[0]?.org_id ?? null;
    });
  }
}
