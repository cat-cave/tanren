// Plane A data-access: the `org_integrations` registry store (migration 0051).
// CRUD + `getGrant(orgId, providerKind)` resolving the credential_ref + metadata
// the IntegrationProvisioner port runs under. Pure SQL + row mapping, in the
// Repositories seam shape: every method takes the caller's `QueryClient` (the
// org-scope carrier) + `ActorRef`, so under RLS an org-scoped client sees only
// that org's rows and an off-scope client sees ZERO — byte-identical to the inline
// `.query` sites the seam standardizes.
//
// The secret VALUE is never read here — `getGrant` returns the credential REF; the
// caller resolves it against the SecretStore.

import type pg from "pg";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { oneOf } from "../data/pgRows.js";
import type { ActorRef } from "../state/actor.js";
import type { OrgGrant } from "../contracts/integrationProvisioner.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

/** An `org_integrations` row, in domain shape. */
export interface OrgIntegration {
  id: string;
  orgId: string;
  providerKind: string;
  credentialRef: string;
  metadata: Record<string, unknown>;
  capabilities: string[];
  status: OrgIntegrationStatus;
}

export const ORG_INTEGRATION_STATUSES = ["linked", "provisioning", "error"] as const;
export type OrgIntegrationStatus = (typeof ORG_INTEGRATION_STATUSES)[number];

/** The fields an upsert supplies; `id`/timestamps are managed by the store/DB. */
export interface UpsertOrgIntegrationInput {
  orgId: string;
  providerKind: string;
  credentialRef: string;
  metadata?: Record<string, unknown>;
  capabilities?: string[];
  status?: OrgIntegrationStatus;
}

interface OrgIntegrationRow {
  id: string;
  org_id: string;
  provider_kind: string;
  credential_ref: string;
  metadata: unknown;
  capabilities: unknown;
  status: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  // jsonb metadata blob: a real object decodes verbatim, anything else (null/array/
  // scalar) defaults to `{}` — VALIDATED via zod, no unsafe narrow off `unknown`.
  return z.record(z.string(), z.unknown()).catch({}).parse(value);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function mapRow(row: OrgIntegrationRow): OrgIntegration {
  return {
    id: row.id,
    orgId: row.org_id,
    providerKind: row.provider_kind,
    credentialRef: row.credential_ref,
    metadata: asRecord(row.metadata),
    capabilities: asStringArray(row.capabilities),
    status: oneOf(row.status, ORG_INTEGRATION_STATUSES, "org_integrations.status"),
  };
}

const COLUMNS = "id, org_id, provider_kind, credential_ref, metadata, capabilities, status";

export const OrgIntegrationsStore = {
  /**
   * Upsert a grant keyed on (org_id, provider_kind) — re-linking a provider
   * updates the existing row rather than creating a duplicate (the unique index
   * backs the ON CONFLICT). Returns the persisted row.
   */
  async upsert(client: QueryClient, input: UpsertOrgIntegrationInput, _actor: ActorRef): Promise<OrgIntegration> {
    const result = await client.query<OrgIntegrationRow>(
      `INSERT INTO org_integrations (id, org_id, provider_kind, credential_ref, metadata, capabilities, status, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, now())
       ON CONFLICT (org_id, provider_kind) DO UPDATE SET
         credential_ref = EXCLUDED.credential_ref,
         metadata = EXCLUDED.metadata,
         capabilities = EXCLUDED.capabilities,
         status = EXCLUDED.status,
         updated_at = now()
       RETURNING ${COLUMNS}`,
      [
        randomUUID(),
        input.orgId,
        input.providerKind,
        input.credentialRef,
        JSON.stringify(input.metadata ?? {}),
        JSON.stringify(input.capabilities ?? []),
        input.status ?? "linked",
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`org_integrations upsert returned no row for (${input.orgId}, ${input.providerKind})`);
    }
    return mapRow(row);
  },

  /** List the org's integration grants, ordered by provider kind. */
  async list(client: QueryClient, orgId: string, _actor: ActorRef): Promise<OrgIntegration[]> {
    const result = await client.query<OrgIntegrationRow>(
      `SELECT ${COLUMNS} FROM org_integrations WHERE org_id = $1 ORDER BY provider_kind`,
      [orgId],
    );
    return result.rows.map(mapRow);
  },

  /** Read one grant by (org_id, provider_kind), or undefined when absent/off-scope. */
  async get(
    client: QueryClient,
    orgId: string,
    providerKind: string,
    _actor: ActorRef,
  ): Promise<OrgIntegration | undefined> {
    const result = await client.query<OrgIntegrationRow>(
      `SELECT ${COLUMNS} FROM org_integrations WHERE org_id = $1 AND provider_kind = $2`,
      [orgId, providerKind],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapRow(row);
  },

  /**
   * Resolve the org grant the IntegrationProvisioner port runs under: the
   * credential REF (never the value) + the non-secret metadata for (org_id,
   * provider_kind). Returns undefined when the org has no grant for that provider
   * (or the row is off-scope under RLS). The caller resolves `credentialRef`
   * against the SecretStore — this store never touches the secret value.
   */
  async getGrant(
    client: QueryClient,
    orgId: string,
    providerKind: string,
    actor: ActorRef,
  ): Promise<OrgGrant | undefined> {
    const integration = await this.get(client, orgId, providerKind, actor);
    if (integration === undefined) {
      return undefined;
    }
    return {
      providerKind: integration.providerKind,
      credentialRef: integration.credentialRef,
      metadata: integration.metadata,
    };
  },

  /** Delete a grant by (org_id, provider_kind). Returns true when a row matched. */
  async delete(client: QueryClient, orgId: string, providerKind: string, _actor: ActorRef): Promise<boolean> {
    const result = await client.query(
      "DELETE FROM org_integrations WHERE org_id = $1 AND provider_kind = $2 RETURNING id",
      [orgId, providerKind],
    );
    return (result.rowCount ?? 0) > 0;
  },
} as const;
