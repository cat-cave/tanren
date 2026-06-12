// Environment management (environment-management.md §3 Layer 4 + §5 + §7 P3) — the
// `environments` registry store (migration 0001_environments_registry) on the
// `Repositories` seam, the env-layer counterpart of `TemplateStore`
// (engine/repositories/templates.ts). CRUD + a content-key lookup
// (`getByEnvKey`) + a capability query + the status lifecycle. Pure SQL + row
// mapping, in the seam shape: every method takes the caller's `QueryClient` (the
// org-scope carrier) + `ActorRef`, so under RLS an org-scoped client sees only that
// org's rows PLUS the cross-org `official` catalogue (the environments RLS policy's
// read-side exception, mirroring `templates`), and an off-scope client sees ZERO
// private rows.
//
// An environment is a VALIDATED, fast-booting runner image keyed by its CONTENT
// HASH (`env_key`). Resolution looks up an image BY env_key (`getByEnvKey`), so the
// (org_id, env_key) pair is UNIQUE — a re-register of the same content UPSERTs
// rather than duplicating. `capabilities`/`provenance`/`validationProof` are free
// jsonb (a stack-agnostic toolchain summary, the build provenance, and the
// negative-control proof P4 produces); `channel` + `status` are mirrored into their
// own columns so selection + the refresh scheduler filter without parsing jsonb.
// This store is the durable WRITE/READ surface; it never builds or validates an
// image (P4's harness produces the validationProof).

import type pg from "pg";
import { randomUUID } from "node:crypto";
import { oneOf } from "../data/pgRows.js";
import type { ActorRef } from "../state/actor.js";
import {
  EnvironmentCapabilities,
  EnvironmentChannel,
  EnvironmentProvenance,
  EnvironmentValidationProof,
  type EnvironmentCapabilities as Capabilities,
  type EnvironmentChannelValue,
  type EnvironmentProvenance as Provenance,
  type EnvironmentValidationProof as ValidationProof,
} from "../environments/manifest.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

/** The registry lifecycle tier of an environment row (environments_status_check). */
export const ENVIRONMENT_STATUSES = ["draft", "validated", "official"] as const;
export type EnvironmentStatus = (typeof ENVIRONMENT_STATUSES)[number];

/** An `environments` row, in domain shape (jsonb re-parsed through the schemas). */
export interface Environment {
  id: string;
  orgId: string;
  envKey: string;
  imageRef: string;
  capabilities: Capabilities;
  channel: EnvironmentChannelValue;
  status: EnvironmentStatus;
  provenance: Provenance;
  // The negative-control + positive-smoke proof, or null when unvalidated (P4
  // produces it). NULL is a LOUD first-class "not yet proven" state, never absent.
  validationProof: ValidationProof | null;
}

/** The fields a register supplies; `id`/timestamps are derived/managed. */
export interface RegisterEnvironmentInput {
  orgId: string;
  // The content key (computeEnvKey) this image is resolved by.
  envKey: string;
  // The registry image digest/ref a workspace seeds from on a match.
  imageRef: string;
  // The toolchain summary (stack-agnostic jsonb).
  capabilities: Capabilities;
  // The build provenance (base_digest, lockfile hashes, created_by_run_id).
  provenance: Provenance;
  // The maintenance channel; defaults to `lts`.
  channel?: EnvironmentChannelValue;
  // The initial lifecycle tier. Defaults to `draft` (unvalidated); P4's validation
  // harness later flips it to `validated`.
  status?: EnvironmentStatus;
  // The negative-control proof, when registering an already-validated env (P4);
  // absent/null ⇒ a draft env with no proof yet.
  validationProof?: ValidationProof | null;
}

/** The capability predicate the selection query filters on (toolchain summary). */
export interface EnvironmentCapabilityQuery {
  // Match environments whose `capabilities.tools` jsonb declares this tool (any
  // version) — e.g. "node", "python". The toolchain summary is the env's "what it
  // can DO", queried like the template registry's capabilities.
  tool?: string;
  // Match environments whose `capabilities.tools` declares this tool AT this exact
  // version (e.g. tool "node" + version "22"). Requires `tool` to be meaningful.
  version?: string;
  // Restrict to a maintenance channel (`lts` | `nightly`).
  channel?: EnvironmentChannelValue;
  // Restrict to these lifecycle tiers (e.g. ["validated","official"] so resolution
  // only seeds from PROVEN envs). Empty/absent ⇒ all tiers.
  statuses?: ReadonlyArray<EnvironmentStatus>;
}

interface EnvironmentRow {
  id: string;
  org_id: string;
  env_key: string;
  image_ref: string;
  capabilities: unknown;
  channel: string;
  status: string;
  provenance: unknown;
  validation_proof: unknown;
}

function mapRow(row: EnvironmentRow): Environment {
  // Re-parse the persisted jsonb through the schemas — a malformed/legacy-shaped
  // row fails LOUDLY here rather than handing a half-typed object to resolution
  // (no silent degrade; mirrors `TemplateStore.mapRow`).
  return {
    id: row.id,
    orgId: row.org_id,
    envKey: row.env_key,
    imageRef: row.image_ref,
    capabilities: EnvironmentCapabilities.parse(row.capabilities),
    channel: EnvironmentChannel.parse(row.channel),
    status: oneOf(row.status, ENVIRONMENT_STATUSES, "environments.status"),
    provenance: EnvironmentProvenance.parse(row.provenance),
    validationProof: row.validation_proof === null ? null : EnvironmentValidationProof.parse(row.validation_proof),
  };
}

const COLUMNS = "id, org_id, env_key, image_ref, capabilities, channel, status, provenance, validation_proof";

export const EnvironmentStore = {
  /**
   * Register (UPSERT) an environment: persist the content key + the resolved image
   * + the toolchain summary + provenance under the owning org. Keyed on
   * (org_id, env_key) — re-registering the SAME content UPDATES the row (the env
   * was rebuilt/re-validated) rather than duplicating. The initial status defaults
   * to `draft`; P4's harness later transitions it via {@link updateStatus}.
   */
  async create(client: QueryClient, input: RegisterEnvironmentInput, _actor: ActorRef): Promise<Environment> {
    const id = `env_${randomUUID()}`;
    const proof = input.validationProof ?? null;
    const result = await client.query<EnvironmentRow>(
      `INSERT INTO environments
         (id, org_id, env_key, image_ref, capabilities, channel, status, provenance, validation_proof, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, $9::jsonb, now())
       ON CONFLICT (org_id, env_key) DO UPDATE SET
         image_ref = EXCLUDED.image_ref,
         capabilities = EXCLUDED.capabilities,
         channel = EXCLUDED.channel,
         status = EXCLUDED.status,
         provenance = EXCLUDED.provenance,
         validation_proof = EXCLUDED.validation_proof,
         updated_at = now()
       RETURNING ${COLUMNS}`,
      [
        id,
        input.orgId,
        input.envKey,
        input.imageRef,
        JSON.stringify(input.capabilities),
        input.channel ?? "lts",
        input.status ?? "draft",
        JSON.stringify(input.provenance),
        proof === null ? null : JSON.stringify(proof),
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`environments create returned no row for ${input.orgId}/${input.envKey}`);
    }
    return mapRow(row);
  },

  /** Read one environment by id, or undefined when absent/off-scope under RLS. */
  async get(client: QueryClient, id: string, _actor: ActorRef): Promise<Environment | undefined> {
    const result = await client.query<EnvironmentRow>(`SELECT ${COLUMNS} FROM environments WHERE id = $1`, [id]);
    const row = result.rows[0];
    return row === undefined ? undefined : mapRow(row);
  },

  /**
   * Resolve an environment by its CONTENT KEY — the P3 resolution lookup. Under RLS
   * an org-scoped client matches its OWN env for this key PLUS a cross-org
   * `official` env with this key; an off-scope client matches only an official one.
   * When `statuses` is given (resolution passes ["validated","official"]) a DRAFT
   * env is skipped, so a never-validated env is never seeded. Returns the newest
   * match, or undefined on a NO-MATCH (resolution then falls back to the golden base).
   */
  async getByEnvKey(
    client: QueryClient,
    envKey: string,
    statuses: ReadonlyArray<EnvironmentStatus> | undefined,
    _actor: ActorRef,
  ): Promise<Environment | undefined> {
    const params: unknown[] = [envKey];
    let statusClause = "";
    if (statuses !== undefined && statuses.length > 0) {
      params.push([...statuses]);
      statusClause = ` AND status = ANY($${params.length})`;
    }
    const result = await client.query<EnvironmentRow>(
      `SELECT ${COLUMNS} FROM environments WHERE env_key = $1${statusClause} ORDER BY created_at DESC LIMIT 1`,
      params,
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapRow(row);
  },

  /**
   * List the environments the caller's scope can see, newest first. Under RLS an
   * org-scoped client sees its own envs PLUS the cross-org `official` catalogue; an
   * off-scope client sees only official rows.
   */
  async list(client: QueryClient, _actor: ActorRef): Promise<Environment[]> {
    const result = await client.query<EnvironmentRow>(`SELECT ${COLUMNS} FROM environments ORDER BY created_at DESC`);
    return result.rows.map(mapRow);
  },

  /**
   * Query environments by CAPABILITY (the toolchain summary): filter on
   * `capabilities.tools` (a declared tool, optionally at an exact version) + channel
   * + status — NOT on a stack string, so a never-seen toolchain is matched on what
   * it bakes. The capability predicates read out of the `capabilities` jsonb;
   * channel/status read the mirrored columns. RLS still bounds the rows (own +
   * official). Mirrors `TemplateStore.listByCapabilities`.
   */
  async listByCapabilities(
    client: QueryClient,
    query: EnvironmentCapabilityQuery,
    _actor: ActorRef,
  ): Promise<Environment[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    // Bind a value and return its 1-based placeholder index (`$n`) — each clause
    // composes its own SQL from the returned index, so a multi-param predicate (the
    // exact tool@version match) never has to guess at numbering.
    const bind = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    if (query.tool !== undefined && query.version !== undefined) {
      // Exact tool@version match against the `capabilities.tools` map: the tool key
      // (`->> $tool`) resolves to the given version. `jsonb ->> text` reads the
      // value at a key supplied as a bound param (no SQL injection of the tool name).
      clauses.push(`capabilities -> 'tools' ->> ${bind(query.tool)} = ${bind(query.version)}`);
    } else if (query.tool !== undefined) {
      // The tool is DECLARED at any version — the key EXISTS in the tools map.
      // `jsonb_exists` (the function form of the jsonb `?` operator) avoids any
      // ambiguity with a driver placeholder, with the key as a bound param.
      clauses.push(`jsonb_exists(capabilities -> 'tools', ${bind(query.tool)})`);
    }
    if (query.channel !== undefined) clauses.push(`channel = ${bind(query.channel)}`);
    if (query.statuses !== undefined && query.statuses.length > 0) {
      clauses.push(`status = ANY(${bind([...query.statuses])})`);
    }
    const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    const result = await client.query<EnvironmentRow>(
      `SELECT ${COLUMNS} FROM environments${where} ORDER BY created_at DESC`,
      params,
    );
    return result.rows.map(mapRow);
  },

  /**
   * Transition an environment's lifecycle status (draft → validated → official).
   * Returns the updated row, or undefined when the id is absent/off-scope.
   */
  async updateStatus(
    client: QueryClient,
    id: string,
    status: EnvironmentStatus,
    _actor: ActorRef,
  ): Promise<Environment | undefined> {
    const result = await client.query<EnvironmentRow>(
      `UPDATE environments SET status = $2, updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, status],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapRow(row);
  },
} as const;
