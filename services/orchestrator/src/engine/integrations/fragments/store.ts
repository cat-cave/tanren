import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import { z } from "zod";
import {
  IntegrationFragmentDraftSchema,
  persistedId,
  validateIntegrationFragment,
  type ValidatedIntegrationFragment,
} from "./model.js";

const RowSchema = z
  .object({
    id: z.string().min(1),
    capability: z.string().min(1),
    provider_kind: z.string().min(1),
    plane: z.enum(["control", "product"]),
    version: z.string().min(1),
    body: z.unknown(),
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    status: z.literal("validated"),
  })
  .strict();

export interface IntegrationFragmentPersistenceStore {
  createValidated(input: {
    readonly orgId: string;
    readonly createdBy: string;
    readonly fragment: ValidatedIntegrationFragment;
  }): Promise<{ readonly persistedId: string }>;
  deleteById(orgId: string, persistedId: string): Promise<void>;
  listValidated(orgId: string): Promise<readonly ValidatedIntegrationFragment[]>;
}

/** Org-scoped registry for declarative provider integration definitions. */
export class IntegrationFragmentStore implements IntegrationFragmentPersistenceStore {
  constructor(private readonly pool: pg.Pool) {}

  async createValidated(input: {
    readonly orgId: string;
    readonly createdBy: string;
    readonly fragment: ValidatedIntegrationFragment;
  }): Promise<{ readonly persistedId: string }> {
    const fragment = validateIntegrationFragment(input.fragment.draft);
    const id = persistedId(fragment.draft.spec);
    return runWithOrgScope(this.pool, input.orgId, async (client) => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO integration_fragments
           (org_id, id, capability, provider_kind, plane, version, body, digest, status, created_by, validated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, 'validated', $9, now())
         RETURNING id`,
        [
          input.orgId,
          id,
          fragment.draft.spec.capability,
          fragment.draft.spec.providerKind,
          fragment.draft.spec.plane,
          fragment.draft.spec.version,
          JSON.stringify(fragment.draft),
          fragment.fragmentDigest,
          input.createdBy,
        ],
      );
      if (result.rows[0] === undefined) throw new Error(`integration fragment insert returned no row for ${id}`);
      return { persistedId: id };
    });
  }

  async deleteById(orgId: string, id: string): Promise<void> {
    await runWithOrgScope(this.pool, orgId, async (client) => {
      await client.query(`DELETE FROM integration_fragments WHERE org_id = $1 AND id = $2`, [orgId, id]);
    });
  }

  async listValidated(orgId: string): Promise<readonly ValidatedIntegrationFragment[]> {
    return runWithOrgScope(this.pool, orgId, async (client) => {
      const result = await client.query(
        `SELECT id, capability, provider_kind, plane, version, body, digest, status
           FROM integration_fragments
          WHERE org_id = $1 AND status = 'validated'
          ORDER BY capability, provider_kind, version`,
        [orgId],
      );
      return result.rows.map((row) => decodeRow(row));
    });
  }
}

function decodeRow(input: unknown): ValidatedIntegrationFragment {
  const row = RowSchema.parse(input);
  const draft = IntegrationFragmentDraftSchema.parse(row.body);
  if (
    persistedId(draft.spec) !== row.id ||
    draft.spec.capability !== row.capability ||
    draft.spec.providerKind !== row.provider_kind ||
    draft.spec.plane !== row.plane ||
    draft.spec.version !== row.version
  ) {
    throw new Error(`stored integration fragment identity is inconsistent: ${row.id}`);
  }
  const validated = validateIntegrationFragment(draft);
  if (validated.fragmentDigest !== row.digest) {
    throw new Error(`stored integration fragment digest is inconsistent: ${row.id}`);
  }
  return validated;
}
