import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import { z } from "zod";
import {
  GovernanceFragmentDraftSchema,
  validateGovernanceFragment,
  type GovernanceFragmentSpec,
  type ValidatedGovernanceFragment,
} from "./model.js";

const StatusSchema = z.literal("validated");
const RowSchema = z
  .object({
    id: z.string().min(1),
    fragment_id: z.string().min(1),
    version: z.string().min(1),
    depends_on: z.unknown(),
    body: z.unknown(),
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    status: StatusSchema,
  })
  .strict();

export interface GovernanceFragmentPersistenceStore {
  createValidated(input: {
    readonly orgId: string;
    readonly createdBy: string;
    readonly fragment: ValidatedGovernanceFragment;
  }): Promise<{ readonly persistedId: string }>;
  deleteById(orgId: string, persistedId: string): Promise<void>;
  listValidated(orgId: string): Promise<readonly ValidatedGovernanceFragment[]>;
}

/** Org-scoped registry for declarative governance fragments. */
export class GovernanceFragmentStore implements GovernanceFragmentPersistenceStore {
  constructor(private readonly pool: pg.Pool) {}

  async createValidated(input: {
    readonly orgId: string;
    readonly createdBy: string;
    readonly fragment: ValidatedGovernanceFragment;
  }): Promise<{ readonly persistedId: string }> {
    const fragment = validateGovernanceFragment(input.fragment.draft);
    const id = persistedId(fragment.draft.spec);
    return runWithOrgScope(this.pool, input.orgId, async (client) => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO governance_fragments
           (org_id, id, fragment_id, version, depends_on, body, digest, status, created_by, validated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, 'validated', $8, now())
         RETURNING id`,
        [
          input.orgId,
          id,
          fragment.draft.spec.fragmentId,
          fragment.draft.spec.version,
          JSON.stringify(fragment.draft.spec.dependsOn),
          JSON.stringify(fragment.draft),
          fragment.fragmentDigest,
          input.createdBy,
        ],
      );
      if (result.rows[0] === undefined) throw new Error(`governance fragment insert returned no row for ${id}`);
      return { persistedId: id };
    });
  }

  async deleteById(orgId: string, id: string): Promise<void> {
    await runWithOrgScope(this.pool, orgId, async (client) => {
      await client.query(`DELETE FROM governance_fragments WHERE org_id = $1 AND id = $2`, [orgId, id]);
    });
  }

  async listValidated(orgId: string): Promise<readonly ValidatedGovernanceFragment[]> {
    return runWithOrgScope(this.pool, orgId, async (client) => {
      const result = await client.query(
        `SELECT id, fragment_id, version, depends_on, body, digest, status
           FROM governance_fragments
          WHERE org_id = $1 AND status = 'validated'
          ORDER BY fragment_id, version`,
        [orgId],
      );
      return result.rows.map((row) => decodeRow(row));
    });
  }
}

function decodeRow(input: unknown): ValidatedGovernanceFragment {
  const row = RowSchema.parse(input);
  const draft = GovernanceFragmentDraftSchema.parse(row.body);
  if (
    persistedId(draft.spec) !== row.id ||
    draft.spec.fragmentId !== row.fragment_id ||
    draft.spec.version !== row.version
  ) {
    throw new Error(`stored governance fragment identity is inconsistent: ${row.id}`);
  }
  if (JSON.stringify(draft.spec.dependsOn) !== JSON.stringify(z.array(z.string()).parse(row.depends_on))) {
    throw new Error(`stored governance fragment dependencies are inconsistent: ${row.id}`);
  }
  const validated = validateGovernanceFragment(draft);
  if (validated.fragmentDigest !== row.digest)
    throw new Error(`stored governance fragment digest is inconsistent: ${row.id}`);
  return validated;
}

export function persistedId(spec: GovernanceFragmentSpec): string {
  return `${spec.fragmentId}@${spec.version}`;
}
