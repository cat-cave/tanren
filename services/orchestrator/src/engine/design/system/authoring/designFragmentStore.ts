// ds-3 (F2D) — the org-scoped DESIGN-FRAGMENT store (`design_fragments`).
//
// Pure SQL + row mapping over the ds-3 registry table. Every method opens its own
// short `runWithOrgScope` transaction so the deny-by-default RLS policy (+ FORCE)
// applies: a write stamps the caller's org; a read under org B (or with no org GUC)
// sees ZERO of org A's rows. `createValidated` is ATOMIC (one INSERT, status
// `validated`); `deleteById` is the retract used when the post-authoring batch
// compose rejects. A corrupt persisted row surfaces as a typed parse error, never a
// silent default (decode is at the zod boundary — no `as Date` / `as Enum`).

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import { z } from "zod";
import {
  parseDesignFragmentSpec,
  type DesignArtifactFileV1,
  DesignArtifactFileV1 as DesignArtifactFileSchema,
} from "../designArtifactSchemas.js";
import { parseDesignFragmentDraft, type ValidatedDesignFragment } from "./designFragmentDraft.js";
import type { PresentDesignFragmentKey } from "./designFragmentSelector.js";

/** Input to atomically persist a validated design fragment. */
export interface CreateDesignFragmentInput {
  readonly orgId: string;
  readonly createdBy: string;
  readonly designSystemId?: string | null;
  readonly fragment: ValidatedDesignFragment;
}

/** A stored design-fragment row in domain shape. */
export interface DesignFragmentRow {
  readonly id: string;
  readonly orgId: string;
  readonly kind: string;
  readonly label: string;
  readonly phase: string;
  readonly version: string;
  readonly digest: string;
  readonly conformanceSuiteId: string;
  readonly files: readonly DesignArtifactFileV1[];
  readonly status: "draft" | "validated";
}

interface RawDesignFragmentRow {
  id: string;
  org_id: string;
  kind: string;
  label: string;
  phase: string;
  version: string;
  digest: string;
  conformance_suite_id: string;
  body: unknown;
  files: unknown;
  status: string;
}

const FilesArray = z.array(DesignArtifactFileSchema);
const StatusSchema = z.enum(["draft", "validated"]);

function mapRow(row: RawDesignFragmentRow): DesignFragmentRow {
  // Re-validate the persisted body through the schema (fail-closed) so a corrupt
  // row surfaces loud rather than reaching a composer as a partial fragment.
  parseDesignFragmentDraft(row.body);
  return {
    id: row.id,
    orgId: row.org_id,
    kind: row.kind,
    label: row.label,
    phase: row.phase,
    version: row.version,
    digest: row.digest,
    conformanceSuiteId: row.conformance_suite_id,
    files: FilesArray.parse(row.files),
    status: StatusSchema.parse(row.status),
  };
}

const COLUMNS = "id, org_id, kind, label, phase, version, digest, conformance_suite_id, body, files, status";

/** The atomic persist + retract seam the kernel binding depends on. `DesignFragmentStore`
 * is the live Postgres impl; tests inject an in-memory conformant fake. */
export interface DesignFragmentPersistenceStore {
  createValidated(input: CreateDesignFragmentInput): Promise<{ persistedId: string }>;
  deleteById(orgId: string, id: string): Promise<void>;
}

/** The org-scoped design-fragment registry store. */
export class DesignFragmentStore implements DesignFragmentPersistenceStore {
  constructor(private readonly pool: pg.Pool) {}

  /** ATOMIC insert-as-validated. Under `runWithOrgScope` (a transaction) the row is
   * either fully validated + visible OR nothing at all — no orphaned draft. Throws
   * on the (org, kind, label, version) unique conflict (surfaced by the kernel as a
   * terminal `persistence_failed` — never a silent overwrite). */
  async createValidated(input: CreateDesignFragmentInput): Promise<{ persistedId: string }> {
    const f = input.fragment;
    const spec = parseDesignFragmentSpec(f.spec);
    return runWithOrgScope(this.pool, input.orgId, async (client) => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO design_fragments
           (org_id, id, design_system_id, kind, label, phase, version, digest,
            target_capabilities, requires, provides, depends_on, conflicts, replaces,
            persona_refs, behavior_refs, conformance_suite_id, body, files, status,
            created_by, validated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                 $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb,
                 $15::jsonb, $16::jsonb, $17, $18::jsonb, $19::jsonb, 'validated',
                 $20, now())
         RETURNING id`,
        [
          input.orgId,
          f.fragmentReleaseId,
          input.designSystemId ?? null,
          spec.kind,
          spec.label,
          spec.phase,
          f.fragmentVersion,
          f.fragmentDigest,
          JSON.stringify(spec.targetCapabilities),
          JSON.stringify(spec.requires),
          JSON.stringify(spec.provides),
          JSON.stringify(spec.dependsOn),
          JSON.stringify(spec.conflicts),
          JSON.stringify(spec.replaces),
          JSON.stringify(spec.personaRefs),
          JSON.stringify(spec.behaviorRefs),
          spec.conformanceSuiteId,
          f.canonicalBody,
          JSON.stringify(f.files),
          input.createdBy,
        ],
      );
      const row = result.rows[0];
      if (row === undefined)
        throw new Error(`DesignFragmentStore.createValidated: insert returned no row for ${f.fragmentReleaseId}`);
      return { persistedId: row.id };
    });
  }

  /** Hard-delete a fragment row (the batch-reject RETRACT). Deleting an absent id
   * succeeds with 0 rows — the caller's retract loop is resilient to a missing row. */
  async deleteById(orgId: string, id: string): Promise<void> {
    await runWithOrgScope(this.pool, orgId, async (client) => {
      await client.query(`DELETE FROM design_fragments WHERE org_id = $1 AND id = $2`, [orgId, id]);
    });
  }

  /** Read one fragment row by id under the org scope, or undefined if absent. */
  async get(orgId: string, id: string): Promise<DesignFragmentRow | undefined> {
    return runWithOrgScope(this.pool, orgId, async (client) => {
      const result = await client.query<RawDesignFragmentRow>(
        `SELECT ${COLUMNS} FROM design_fragments WHERE org_id = $1 AND id = $2`,
        [orgId, id],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : mapRow(row);
    });
  }

  /** The org's PRESENT validated (kind, label) registry — the selector's input.
   * Explicit `WHERE org_id = $1` is belt-and-suspenders over RLS (a raw-pool caller
   * cannot collapse rows across tenants). */
  async listPresentByOrg(orgId: string): Promise<PresentDesignFragmentKey[]> {
    return runWithOrgScope(this.pool, orgId, async (client) => {
      const result = await client.query<{ kind: string; label: string }>(
        `SELECT DISTINCT kind, label FROM design_fragments
           WHERE status = 'validated' AND org_id = $1
           ORDER BY kind, label`,
        [orgId],
      );
      return result.rows.map((row) => ({ kind: row.kind, label: row.label }));
    });
  }

  /** The FILE bodies of the org's present validated fragments — the batch-compose
   * gate's cross-run collision defense (`loadPresentFiles`). A NEW authored fragment
   * whose file path collides (case-insensitively) with an EXISTING persisted fragment
   * is caught only when the gate composes the authored set AGAINST these files. Each
   * row's `files` is re-validated through the schema boundary (fail-closed — a corrupt
   * persisted row surfaces loud, never a partial/undefended set). Org-scoped under RLS
   * with an explicit `WHERE org_id = $1` belt over the policy. */
  async listPresentFilesByOrg(orgId: string): Promise<DesignArtifactFileV1[]> {
    return runWithOrgScope(this.pool, orgId, async (client) => {
      const result = await client.query<{ files: unknown }>(
        `SELECT files FROM design_fragments
           WHERE status = 'validated' AND org_id = $1
           ORDER BY id`,
        [orgId],
      );
      return result.rows.flatMap((row) => FilesArray.parse(row.files));
    });
  }
}
