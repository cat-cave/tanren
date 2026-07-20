// Real-Postgres seed + read helpers for the in-11 reconciliation saga RLS proof.
// All INSERTs run through the superuser owner pool (RLS bypassed) to set up tenant
// state; the saga under test still runs as the non-superuser tanren_app role.

import type { Pool } from "pg";

export const DIGEST = `sha256:${"a".repeat(64)}`;
export const OBSERVED = `sha256:${"b".repeat(64)}`;

export async function seedOrg(pool: Pool, orgId: string): Promise<void> {
  await pool.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [orgId],
  );
}

export async function seedProject(pool: Pool, orgId: string, projectId: string, requirementId: string): Promise<void> {
  await pool.query(
    `INSERT INTO projects (project_id, name, repo_url, org_id)
     VALUES ($1, $1, 'https://example.com/reconcile.git', $2)`,
    [projectId, orgId],
  );
  await pool.query(
    `INSERT INTO integration_requirements
       (org_id, id, project_id, capability, plane, direction, desired_state,
        source_kind, source_revision_id, source_digest, policy_version, criticality)
     VALUES ($1, $2, $3, 'errors', 'product', 'outbound', '{}'::jsonb,
             'design_contract', $2, $4, 'policy-v1', 'release_required')`,
    [orgId, requirementId, projectId, DIGEST],
  );
}

export async function seedCapabilityNode(
  pool: Pool,
  orgId: string,
  projectId: string,
  requirementId: string,
  nodeId: string,
  desiredHash: string = DIGEST,
): Promise<void> {
  await pool.query(
    `INSERT INTO capability_nodes
       (org_id, id, project_id, requirement_id, environment, desired_state_hash, status, priority, generation)
     VALUES ($1, $2, $3, $4, 'test', $5, 'enqueued', 0, 1)`,
    [orgId, nodeId, projectId, requirementId, desiredHash],
  );
}

export async function seedReconciliation(
  pool: Pool,
  orgId: string,
  projectId: string,
  requirementId: string,
  reconciliationId: string,
  fingerprint: string = DIGEST,
): Promise<void> {
  await pool.query(
    `INSERT INTO integration_reconciliations
       (org_id, id, project_id, requirement_id, phase, idempotency_key, request_fingerprint)
     VALUES ($1, $2, $3, $4, 'discover', $2, $5)`,
    [orgId, reconciliationId, projectId, requirementId, fingerprint],
  );
}

export async function seedSnapshot(
  pool: Pool,
  orgId: string,
  projectId: string,
  requirementId: string,
  snapshotId: string,
  health: string,
  observedHash: string = OBSERVED,
): Promise<void> {
  await pool.query(
    `INSERT INTO integration_resource_snapshots
       (org_id, id, project_id, requirement_id, provider_kind, external_resource_id,
        observed_state_hash, sanitized_snapshot, health, last_seen_at)
     VALUES ($1, $2, $3, $4, 'sentry', $2, $5, '{}'::jsonb, $6, now())`,
    [orgId, snapshotId, projectId, requirementId, observedHash, health],
  );
}

/** A snapshot scoped to a specific binding generation (for the pinned-coordinate control). */
export async function seedSnapshotForGeneration(
  pool: Pool,
  orgId: string,
  projectId: string,
  requirementId: string,
  snapshotId: string,
  bindingId: string,
  bindingGeneration: number,
  observedHash: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO integration_resource_snapshots
       (org_id, id, project_id, requirement_id, binding_id, binding_generation, provider_kind,
        external_resource_id, observed_state_hash, sanitized_snapshot, health, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'slack', $2, $7, '{}'::jsonb, 'healthy', now())`,
    [orgId, snapshotId, projectId, requirementId, bindingId, bindingGeneration, observedHash],
  );
}

/** A reconciliation pinned to an exact binding generation (a later-phase reconcile). */
export async function seedBoundReconciliation(
  pool: Pool,
  orgId: string,
  projectId: string,
  requirementId: string,
  reconciliationId: string,
  bindingId: string,
  bindingGeneration: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO integration_reconciliations
       (org_id, id, project_id, requirement_id, binding_id, binding_generation,
        phase, idempotency_key, request_fingerprint)
     VALUES ($1, $2, $3, $4, $5, $6, 'reconcile', $2, $7)`,
    [orgId, reconciliationId, projectId, requirementId, bindingId, bindingGeneration, DIGEST],
  );
}

/**
 * Seed the full binding lineage (connection → auth generation → grant → grant generation
 * → binding → binding generations 1 AND 2) so a reconciliation can pin an exact generation.
 * Returns the binding id.
 */
export async function seedBindingLineage(
  pool: Pool,
  orgId: string,
  projectId: string,
  requirementId: string,
): Promise<string> {
  const conn = `conn_${projectId}`;
  const cred = `cred_${projectId}`;
  const grant = `grant_${projectId}`;
  const binding = `bind_${projectId}`;
  await pool.query(
    `INSERT INTO org_integration_connections
       (org_id, id, provider_kind, provider_principal_id, principal_kind, display_name,
        principal_metadata, health, status, current_auth_generation, owner_id)
     VALUES ($1, $2, 'slack', 'team-a', 'organization', 'team-a', '{}'::jsonb, 'healthy', 'active', 1, 'admin-a')`,
    [orgId, conn],
  );
  await pool.query(
    `INSERT INTO org_integration_connection_auth_generations
       (org_id, provider_kind, connection_id, generation, credential_ref, auth_kind, status)
     VALUES ($1, 'slack', $2, 1, $3, 'bot_token', 'active')`,
    [orgId, conn, cred],
  );
  await pool.query(
    `INSERT INTO org_integration_grants
       (org_id, id, provider_kind, connection_id, plane, environment, current_generation, status)
     VALUES ($1, $2, 'slack', $3, 'product', 'test', 1, 'active')`,
    [orgId, grant, conn],
  );
  await pool.query(
    `INSERT INTO org_integration_grant_generations
       (org_id, provider_kind, connection_id, grant_id, generation, capabilities, operations,
        provider_scopes, resource_constraints, policy_revision, consent_revision,
        consent_actor_id, consented_at, status)
     VALUES ($1, 'slack', $2, $3, 1, ARRAY['messaging']::text[], ARRAY['bind']::text[],
             ARRAY['chat:write']::text[], '{}'::jsonb, 'integration-catalog.v2', 'consent.test',
             'admin-a', now(), 'active')`,
    [orgId, conn, grant],
  );
  await pool.query(
    `INSERT INTO integration_bindings
       (org_id, id, project_id, requirement_id, environment, provider_kind, connection_id,
        current_generation, status, drift_state)
     VALUES ($1, $2, $3, $4, 'test', 'slack', $5, 2, 'ready', 'in_sync')`,
    [orgId, binding, projectId, requirementId, conn],
  );
  for (const generation of [1, 2]) {
    await pool.query(
      `INSERT INTO integration_binding_generations
         (org_id, project_id, requirement_id, environment, binding_id, generation, provider_kind,
          connection_id, auth_generation, grant_id, grant_generation, adapter_version,
          external_resource_id, external_resource_name, ownership, teardown_policy,
          desired_state_hash, status, drift_state)
       VALUES ($1, $2, $3, 'test', $4, $5, 'slack', $6, 1, $7, 1, 'slack.v1',
               'ext-res', 'general', 'created', 'delete', $8, 'ready', 'in_sync')`,
      [orgId, projectId, requirementId, binding, generation, conn, grant, DIGEST],
    );
  }
  return binding;
}

export async function recStatus(
  pool: Pool,
  orgId: string,
  id: string,
): Promise<{ status: string; failure_classification: string | null; progress_signature: string | null }> {
  const r = await pool.query<{
    status: string;
    failure_classification: string | null;
    progress_signature: string | null;
  }>(
    "SELECT status, failure_classification, progress_signature FROM integration_reconciliations WHERE org_id = $1 AND id = $2",
    [orgId, id],
  );
  return r.rows[0]!;
}

export async function recFull(
  pool: Pool,
  orgId: string,
  id: string,
): Promise<{ status: string; attempt: number; compensation_state: { attemptHistory: unknown[] } }> {
  const r = await pool.query<{ status: string; attempt: number; compensation_state: { attemptHistory: unknown[] } }>(
    "SELECT status, attempt, compensation_state FROM integration_reconciliations WHERE org_id = $1 AND id = $2",
    [orgId, id],
  );
  return r.rows[0]!;
}

export async function nodeStatus(pool: Pool, orgId: string, nodeId: string): Promise<string> {
  const r = await pool.query<{ status: string }>("SELECT status FROM capability_nodes WHERE org_id = $1 AND id = $2", [
    orgId,
    nodeId,
  ]);
  return r.rows[0]!.status;
}

export async function recEvents(pool: Pool, orgId: string, reconciliationId: string): Promise<string[]> {
  const r = await pool.query<{ event_type: string }>(
    "SELECT event_type FROM events WHERE org_id = $1 AND payload ->> 'reconciliationId' = $2 ORDER BY id",
    [orgId, reconciliationId],
  );
  return r.rows.map((row) => row.event_type);
}
