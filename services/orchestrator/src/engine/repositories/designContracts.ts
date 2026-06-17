// Tanren-native design subsystem (WS-D1) — the `design_contracts` store on the
// `Repositories` seam. The durable WRITE/READ surface for the first-class,
// versioned, org-scoped `DesignContract` entity (migration
// 0010_design_contracts). Pure SQL + row
// mapping in the seam shape: every method takes the caller's `QueryClient` (the
// org-scope carrier) + `ActorRef`, so under RLS an org-scoped client sees only
// that org's contracts and an off-scope client sees ZERO rows.
//
// A project's design contract is VERSIONED: each `create` mints the next version
// for the project (a design change is a new version, not an in-place overwrite —
// the never-discard posture, and what lets a later workstream re-propagate a
// design change). `getLatest` reads the head version a project builds against.
// The parsed `DesignContractV1` is persisted verbatim into the `contract` jsonb;
// a malformed persisted row fails LOUDLY on read (no silent degrade), exactly
// like the template manifest store.
//
// This store NEVER injects the contract into the writer (WS-D2) or verifies it
// (WS-D4) — it is the persistence seam those workstreams read from.

import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { ActorRef } from "../state/actor.js";
import { type DesignContractV1, designContractToJson, parseDesignContract } from "../design/designContract.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

/** A `design_contracts` row, in domain shape (contract re-parsed through the schema). */
export interface DesignContractRecord {
  id: string;
  orgId: string;
  projectId: string;
  // The monotonic version for this project (1-based). A design change mints the
  // next version rather than overwriting (never-discard).
  version: number;
  // The descriptive design domain label (mirrored out of the contract for
  // filtering/observability without parsing the jsonb).
  domain: string;
  contract: DesignContractV1;
}

/** The fields a caller supplies; `id`/`version`/timestamps are derived/managed. */
export interface CreateDesignContractInput {
  orgId: string;
  projectId: string;
  // The parsed contract — its `domain` is mirrored into the column.
  contract: DesignContractV1;
}

interface DesignContractRow {
  id: string;
  org_id: string;
  project_id: string;
  version: number | string;
  domain: string;
  contract: unknown;
}

function mapRow(row: DesignContractRow): DesignContractRecord {
  // Parse the persisted jsonb back through the schema — a malformed or
  // legacy-shaped row fails LOUDLY here rather than handing a half-typed contract
  // to a downstream consumer (injection/oracle). No silent degrade.
  const contract = parseDesignContract(row.contract);
  return {
    id: row.id,
    orgId: row.org_id,
    projectId: row.project_id,
    version: typeof row.version === "string" ? Number.parseInt(row.version, 10) : row.version,
    domain: row.domain,
    contract,
  };
}

const COLUMNS = "id, org_id, project_id, version, domain, contract";

export const DesignContractStore = {
  /**
   * Persist a NEW VERSION of a project's design contract. The version is the
   * project's current max + 1 (1-based), computed in the same statement so
   * concurrent creates serialize on the `(project_id, version)` unique index. The
   * contract jsonb is persisted verbatim; `domain` is mirrored into its column.
   * Returns the persisted record.
   */
  async create(client: QueryClient, input: CreateDesignContractInput, _actor: ActorRef): Promise<DesignContractRecord> {
    const id = `design_${randomUUID()}`;
    const result = await client.query<DesignContractRow>(
      `INSERT INTO design_contracts (id, org_id, project_id, version, domain, contract, updated_at)
       VALUES (
         $1, $2, $3,
         COALESCE((SELECT MAX(version) FROM design_contracts WHERE project_id = $3), 0) + 1,
         $4, $5::jsonb, now()
       )
       RETURNING ${COLUMNS}`,
      [id, input.orgId, input.projectId, input.contract.domain, JSON.stringify(designContractToJson(input.contract))],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`design_contracts create returned no row for ${input.orgId}/${input.projectId}`);
    }
    return mapRow(row);
  },

  /** Read one contract by id, or undefined when absent/off-scope under RLS. */
  async get(client: QueryClient, id: string, _actor: ActorRef): Promise<DesignContractRecord | undefined> {
    const result = await client.query<DesignContractRow>(`SELECT ${COLUMNS} FROM design_contracts WHERE id = $1`, [id]);
    const row = result.rows[0];
    return row === undefined ? undefined : mapRow(row);
  },

  /**
   * Read the HEAD (highest-version) contract for a project — the one the build
   * currently builds against. Undefined when the project has no contract yet (a
   * real empty state — never a defaulted contract).
   */
  async getLatest(client: QueryClient, projectId: string, _actor: ActorRef): Promise<DesignContractRecord | undefined> {
    const result = await client.query<DesignContractRow>(
      `SELECT ${COLUMNS} FROM design_contracts WHERE project_id = $1 ORDER BY version DESC LIMIT 1`,
      [projectId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapRow(row);
  },

  /** All versions of a project's contract, newest first (the version history). */
  async listVersions(client: QueryClient, projectId: string, _actor: ActorRef): Promise<DesignContractRecord[]> {
    const result = await client.query<DesignContractRow>(
      `SELECT ${COLUMNS} FROM design_contracts WHERE project_id = $1 ORDER BY version DESC`,
      [projectId],
    );
    return result.rows.map(mapRow);
  },
} as const;
