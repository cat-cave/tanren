// Org-scoped fragment store (docs/roadmap/templating-system.md — F2). The
// per-fragment authoring DAG produces validated fragments and persists them here;
// `loadFragmentLibrary(orgId)` reads them out and assembles a unified library
// (bundled core fragments shadowed by org-scoped fragments with the same kind +
// label). Pure SQL + row mapping, in the seam shape: every method takes the
// caller's `QueryClient` (the org-scope carrier) + `ActorRef`, so under RLS an
// org-scoped client sees only that org's rows.
//
// A fragment row PERSISTS THE FRAGMENT'S TS SOURCE plus its declared `contract`
// (the same `FragmentContract` shape `engine/templates/fragments/types.ts`
// defines). The TS body is loaded + dynamically imported by the unified library
// loader at request time (a code-loaded fragment whose `default` export is the
// `Fragment` object the bundled fragments export). The contract is mirrored into
// jsonb so callers that don't load the body can still answer "does this fragment
// declare a testRunner / dbMigrationsDir / …?" queries.

import type pg from "pg";
import { z } from "zod";
import { oneOf } from "../data/pgRows.js";
import type { ActorRef } from "../state/actor.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

/** Fragment lifecycle tier. */
export const FRAGMENT_STATUSES = ["draft", "validated"] as const;
export type FragmentStatus = (typeof FRAGMENT_STATUSES)[number];

/** The declared `FragmentContract` mirrored into jsonb. Mirrors the type in
 * `engine/templates/fragments/types.ts` — must stay in lock-step (a fragment
 * whose body declares a contract field the schema rejects fails to register). */
export const FragmentContractSchema = z
  .object({
    testRunner: z.string().min(1).optional(),
    reportPath: z.string().min(1).optional(),
    dbMigrationsDir: z.string().min(1).optional(),
    ciTier2: z.string().min(1).optional(),
  })
  .strict();
export type FragmentContractShape = z.infer<typeof FragmentContractSchema>;

/** A fragment row in domain shape. */
export interface FragmentRow {
  fragmentId: string;
  orgId: string;
  kind: string;
  label: string;
  version: string;
  /** The TypeScript source code of the fragment module (default-exports the
   * `Fragment` value). */
  bodyTs: string;
  contract: FragmentContractShape;
  dependsOn: string[];
  status: FragmentStatus;
  createdAt: Date;
  validatedAt: Date | null;
}

/** Input for registering a new (or re-versioning a) fragment. */
export interface RegisterFragmentInput {
  orgId: string;
  kind: string;
  label: string;
  version: string;
  bodyTs: string;
  contract: FragmentContractShape;
  dependsOn?: readonly string[];
  status?: FragmentStatus;
}

interface RawFragmentRow {
  fragment_id: string;
  org_id: string;
  kind: string;
  label: string;
  version: string;
  body_ts: string;
  contract: unknown;
  depends_on: unknown;
  status: string;
  created_at: Date;
  validated_at: Date | null;
}

function mapRow(row: RawFragmentRow): FragmentRow {
  const dependsOn = Array.isArray(row.depends_on)
    ? (row.depends_on as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  return {
    fragmentId: row.fragment_id,
    orgId: row.org_id,
    kind: row.kind,
    label: row.label,
    version: row.version,
    bodyTs: row.body_ts,
    contract: FragmentContractSchema.parse(row.contract),
    dependsOn,
    status: oneOf(row.status, FRAGMENT_STATUSES, "fragments.status"),
    createdAt: row.created_at,
    validatedAt: row.validated_at,
  };
}

const COLUMNS =
  "fragment_id, org_id, kind, label, version, body_ts, contract, depends_on, status, created_at, validated_at";

function fragmentId(orgId: string, kind: string, label: string, version: string): string {
  return `${orgId}:${kind}-${label}:${version}`;
}

export const FragmentsStore = {
  /** Insert a new fragment row (org-scoped). Throws on a (org, kind, label,
   * version) unique conflict — re-author with a bumped version to publish a new
   * revision; the unified loader returns the HIGHEST validated version per
   * (org, kind, label). */
  async create(client: QueryClient, input: RegisterFragmentInput, _actor: ActorRef): Promise<FragmentRow> {
    const id = fragmentId(input.orgId, input.kind, input.label, input.version);
    const result = await client.query<RawFragmentRow>(
      `INSERT INTO fragments (fragment_id, org_id, kind, label, version, body_ts, contract, depends_on, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)
         RETURNING ${COLUMNS}`,
      [
        id,
        input.orgId,
        input.kind,
        input.label,
        input.version,
        input.bodyTs,
        JSON.stringify(input.contract),
        JSON.stringify(input.dependsOn ?? []),
        input.status ?? "draft",
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`FragmentsStore.create: insert returned no row for ${id}`);
    }
    return mapRow(row);
  },

  async get(client: QueryClient, id: string, _actor: ActorRef): Promise<FragmentRow | undefined> {
    const result = await client.query<RawFragmentRow>(`SELECT ${COLUMNS} FROM fragments WHERE fragment_id = $1`, [id]);
    const row = result.rows[0];
    return row === undefined ? undefined : mapRow(row);
  },

  /** Every fragment visible to the caller's scope, newest-version-first. RLS bounds
   * to the caller's org. */
  async list(client: QueryClient, _actor: ActorRef): Promise<FragmentRow[]> {
    const result = await client.query<RawFragmentRow>(
      `SELECT ${COLUMNS} FROM fragments ORDER BY org_id, kind, label, validated_at DESC NULLS LAST, version DESC`,
    );
    return result.rows.map(mapRow);
  },

  /** Latest VALIDATED fragments visible to the caller's scope. Used by the unified
   * library loader: bundled core fragments shadowed by org-scoped fragments with the
   * same (kind, label) — the latest validated version wins. */
  async listValidated(client: QueryClient, _actor: ActorRef): Promise<FragmentRow[]> {
    const result = await client.query<RawFragmentRow>(
      `SELECT DISTINCT ON (org_id, kind, label) ${COLUMNS}
         FROM fragments
         WHERE status = 'validated'
         ORDER BY org_id, kind, label, validated_at DESC NULLS LAST, version DESC`,
    );
    return result.rows.map(mapRow);
  },

  /** LIGHTWEIGHT prior-fragments projection for the F2 writer prompt (fix/f2-prompt-hardening).
   * Returns just `{fragmentId, kind, label}` per validated fragment visible to the
   * caller's org — the writer's "these worked before, follow the shape" hint needs no
   * body_ts, no contract, no dependsOn. RLS bounds visibility to the caller's org.
   *
   * Returns EMPTY when the org has no prior validated fragments — the writer prompt
   * then omits the prior-fragments section cleanly. */
  async listValidatedByOrg(
    client: QueryClient,
    _actor: ActorRef,
  ): Promise<Array<{ fragmentId: string; kind: string; label: string }>> {
    const result = await client.query<{ fragment_id: string; kind: string; label: string }>(
      `SELECT DISTINCT ON (kind, label) fragment_id, kind, label
         FROM fragments
         WHERE status = 'validated'
         ORDER BY kind, label, validated_at DESC NULLS LAST, version DESC`,
    );
    return result.rows.map((row) => ({ fragmentId: row.fragment_id, kind: row.kind, label: row.label }));
  },

  async markValidated(client: QueryClient, id: string, _actor: ActorRef): Promise<FragmentRow> {
    const result = await client.query<RawFragmentRow>(
      `UPDATE fragments SET status = 'validated', validated_at = now()
         WHERE fragment_id = $1
         RETURNING ${COLUMNS}`,
      [id],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`FragmentsStore.markValidated: no row for ${id}`);
    }
    return mapRow(row);
  },

  /** ATOMIC insert-as-validated (audit finding H2 — task #150). Inserts the
   * row with `status='validated'` + `validated_at=now()` in ONE query. Under
   * `runWithOrgScope` (which opens a transaction) the row is either fully
   * validated + visible to the unified loader OR nothing at all — no orphaned
   * draft the loader would silently ignore. Preferred over the two-step
   * `create` + `markValidated` pattern for the F2 authoring pipeline. */
  async createValidated(client: QueryClient, input: RegisterFragmentInput, _actor: ActorRef): Promise<FragmentRow> {
    const id = fragmentId(input.orgId, input.kind, input.label, input.version);
    const result = await client.query<RawFragmentRow>(
      `INSERT INTO fragments (fragment_id, org_id, kind, label, version, body_ts, contract, depends_on, status, validated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, 'validated', now())
         RETURNING ${COLUMNS}`,
      [
        id,
        input.orgId,
        input.kind,
        input.label,
        input.version,
        input.bodyTs,
        JSON.stringify(input.contract),
        JSON.stringify(input.dependsOn ?? []),
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`FragmentsStore.createValidated: insert returned no row for ${id}`);
    }
    return mapRow(row);
  },
};
