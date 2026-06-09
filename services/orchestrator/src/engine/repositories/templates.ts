// Tanren-native templating (wave 1) — the `templates` registry store (migration
// 0015) on the `Repositories` seam. CRUD + a capability query + the status
// lifecycle transitions later waves drive (validate → validated, expire →
// degraded). Pure SQL + row mapping, in the seam shape: every method takes the
// caller's `QueryClient` (the org-scope carrier) + `ActorRef`, so under RLS an
// org-scoped client sees only that org's rows PLUS the cross-org `official`
// catalogue (the templates RLS policy's read-side exception), and an off-scope
// client sees ZERO private rows — byte-identical to the inline `.query` sites the
// seam standardizes.
//
// The parsed `TemplateManifestV1` is persisted verbatim into the `manifest`
// jsonb; `channel` is mirrored out of the manifest into its own column so the
// scheduler + selection filter without parsing the jsonb. This store is the
// durable WRITE/READ surface; it never validates a repo or runs a gate (the
// validation harness — a later wave — produces the manifest's validationProof).

import type pg from "pg";
import { randomUUID } from "node:crypto";
import type { ActorRef } from "../state/actor.js";
import {
  type TemplateChannel,
  TemplateManifestV1,
  type TemplateManifestV1 as TemplateManifest,
  manifestToJson,
} from "../templates/manifest.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

/** The registry lifecycle tier of a template row (templates_status_check). */
export type TemplateStatus = "draft" | "validated" | "degraded" | "official";

/** A `templates` row, in domain shape (manifest parsed back through the schema). */
export interface Template {
  id: string;
  orgId: string;
  repoRef: string;
  manifest: TemplateManifest;
  status: TemplateStatus;
  channel: TemplateChannel;
}

/** The fields a register supplies; `id`/`channel`/timestamps are derived/managed. */
export interface RegisterTemplateInput {
  orgId: string;
  repoRef: string;
  // The parsed manifest — its `channel` is mirrored into the column, and its
  // `validationProof` (null when unvalidated) governs the initial status.
  manifest: TemplateManifest;
  // The initial lifecycle tier. Defaults to `draft` (unvalidated); the creation
  // flow registers `draft`, the validation harness later flips it to `validated`.
  status?: TemplateStatus;
}

/** The capability predicate a selection query filters on (templating-system.md §3). */
export interface TemplateCapabilityQuery {
  // Match templates whose manifest declares this runtime (e.g. "node", "cargo").
  runtime?: string;
  // Match templates whose manifest declares this package manager.
  packageManager?: string;
  // Match templates whose manifest declares this framework.
  framework?: string;
  // Match templates whose manifest declares this deploy target.
  deployTarget?: string;
  // Restrict to a maintenance channel (`lts` | `nightly`).
  channel?: TemplateChannel;
  // Restrict to these lifecycle tiers (e.g. ["validated","official"] for a
  // selection that only seeds from proven templates). Empty/absent ⇒ all tiers.
  statuses?: ReadonlyArray<TemplateStatus>;
}

interface TemplateRow {
  id: string;
  org_id: string;
  repo_ref: string;
  manifest: unknown;
  status: string;
  channel: string;
}

function mapRow(row: TemplateRow): Template {
  // Parse the persisted jsonb back through the manifest schema — a malformed or
  // legacy-shaped row fails LOUDLY here rather than handing a half-typed object
  // to selection (no silent degrade).
  const manifest = TemplateManifestV1.parse(row.manifest);
  return {
    id: row.id,
    orgId: row.org_id,
    repoRef: row.repo_ref,
    manifest,
    status: row.status as TemplateStatus,
    channel: row.channel as TemplateChannel,
  };
}

const COLUMNS = "id, org_id, repo_ref, manifest, status, channel";

export const TemplateStore = {
  /**
   * Register a template: persist the repo ref + the parsed manifest (verbatim
   * jsonb) + the mirrored channel under the owning org. The initial status
   * defaults to `draft` (unvalidated); the validation harness later transitions
   * it via {@link updateStatus}. Returns the persisted row.
   */
  async create(client: QueryClient, input: RegisterTemplateInput, _actor: ActorRef): Promise<Template> {
    const id = `template_${randomUUID()}`;
    const result = await client.query<TemplateRow>(
      `INSERT INTO templates (id, org_id, repo_ref, manifest, status, channel, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, now())
       RETURNING ${COLUMNS}`,
      [
        id,
        input.orgId,
        input.repoRef,
        JSON.stringify(manifestToJson(input.manifest)),
        input.status ?? "draft",
        input.manifest.channel,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`templates create returned no row for ${input.orgId}/${input.repoRef}`);
    }
    return mapRow(row);
  },

  /** Read one template by id, or undefined when absent/off-scope under RLS. */
  async get(client: QueryClient, id: string, _actor: ActorRef): Promise<Template | undefined> {
    const result = await client.query<TemplateRow>(`SELECT ${COLUMNS} FROM templates WHERE id = $1`, [id]);
    const row = result.rows[0];
    return row === undefined ? undefined : mapRow(row);
  },

  /**
   * List the templates the caller's scope can see, newest first. Under RLS an
   * org-scoped client sees its own templates PLUS the cross-org `official`
   * catalogue; an off-scope client sees only the official rows.
   */
  async list(client: QueryClient, _actor: ActorRef): Promise<Template[]> {
    const result = await client.query<TemplateRow>(`SELECT ${COLUMNS} FROM templates ORDER BY created_at DESC`);
    return result.rows.map(mapRow);
  },

  /**
   * Query templates by CAPABILITY (templating-system.md §3): selection filters on
   * the manifest's runtime/pkg-mgr/framework/deploy-target + channel + status —
   * NOT on a stack string, so a never-seen stack is matched on what it can DO.
   * The capability predicates read out of the `manifest` jsonb; channel/status
   * read the mirrored columns. RLS still bounds the rows (own + official).
   */
  async listByCapabilities(client: QueryClient, query: TemplateCapabilityQuery, _actor: ActorRef): Promise<Template[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    const add = (clause: string, value: unknown): void => {
      params.push(value);
      clauses.push(clause.replace("$?", `$${params.length}`));
    };
    if (query.runtime !== undefined) add("manifest -> 'capabilities' ->> 'runtime' = $?", query.runtime);
    if (query.packageManager !== undefined) {
      add("manifest -> 'capabilities' ->> 'packageManager' = $?", query.packageManager);
    }
    if (query.framework !== undefined) add("manifest -> 'capabilities' ->> 'framework' = $?", query.framework);
    if (query.deployTarget !== undefined) {
      add("manifest -> 'capabilities' ->> 'deployTarget' = $?", query.deployTarget);
    }
    if (query.channel !== undefined) add("channel = $?", query.channel);
    if (query.statuses !== undefined && query.statuses.length > 0) {
      add("status = ANY($?)", [...query.statuses]);
    }
    const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    const result = await client.query<TemplateRow>(
      `SELECT ${COLUMNS} FROM templates${where} ORDER BY created_at DESC`,
      params,
    );
    return result.rows.map(mapRow);
  },

  /**
   * Transition a template's lifecycle status (draft → validated → official, or
   * back to degraded). Re-mirrors the manifest's channel in case a re-validation
   * persisted a new manifest first. Returns the updated row, or undefined when
   * the id is absent/off-scope.
   */
  async updateStatus(
    client: QueryClient,
    id: string,
    status: TemplateStatus,
    _actor: ActorRef,
  ): Promise<Template | undefined> {
    const result = await client.query<TemplateRow>(
      `UPDATE templates SET status = $2, updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, status],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapRow(row);
  },

  /**
   * Persist a re-validated (or otherwise updated) manifest verbatim + re-mirror
   * its channel. The status is set explicitly by the caller (the validation
   * harness passes `validated`/`degraded`); this is the single write that keeps
   * the jsonb + the mirrored channel column in lock-step. Returns the updated
   * row, or undefined when the id is absent/off-scope.
   */
  async updateManifest(
    client: QueryClient,
    id: string,
    manifest: TemplateManifest,
    status: TemplateStatus,
    _actor: ActorRef,
  ): Promise<Template | undefined> {
    const result = await client.query<TemplateRow>(
      `UPDATE templates SET manifest = $2::jsonb, channel = $3, status = $4, updated_at = now()
       WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, JSON.stringify(manifestToJson(manifest)), manifest.channel, status],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapRow(row);
  },

  /**
   * Mark a template `degraded` — the maintenance flow's signal that its
   * validationProof expired or audits found unresolved P0/P1 (templating-system.md
   * §4). A convenience over {@link updateStatus} so the maintenance caller reads
   * intent-first. Returns the updated row, or undefined when absent/off-scope.
   */
  async markDegraded(client: QueryClient, id: string, actor: ActorRef): Promise<Template | undefined> {
    return this.updateStatus(client, id, "degraded", actor);
  },
} as const;
