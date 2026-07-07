// Tanren-native design subsystem (WS-D1) — the `design_contracts` store on the
// `Repositories` seam. The durable WRITE/READ surface for the first-class,
// versioned, org-scoped `DesignContract` entity (migrations
// 0010_design_contracts + 0028_design_contracts_drop_mode). Pure SQL + row
// mapping in the seam shape: every method takes the caller's `QueryClient` (the
// org-scope carrier) + `ActorRef`, so under RLS an org-scoped client sees only
// that org's contracts and an off-scope client sees ZERO rows.
//
// A project's design contract is VERSIONED (per-project): each `create` mints
// the next version FOR THE PROJECT (a design change is a new version, not an
// in-place overwrite — the never-discard posture, and what lets a later
// workstream re-propagate a design change). `getLatest` reads the HEAD
// version the build builds against. The parsed `DesignContractV1` is persisted
// verbatim into the `contract` jsonb; a malformed persisted row fails LOUDLY
// on read (no silent degrade), exactly like the template manifest store.
//
// PROJECT-SCOPED (H2 BLOCKING — unify): the DesignContract describes PRODUCT
// identity (behaviors, personas, dimensions) which is shared across ALL spec
// types in the same project. Migration 0026 briefly keyed the head on
// `(project_id, mode, version)` (per-writer-prompt-mode heads), but no code
// path ever wrote a row at `specialize_seed` — `persistDesignContract` lands
// the derive-time contract at `DEFAULT_SPEC_MODE`, so scaffold/build/deploy
// specs (which run under `specialize_seed`) got `{ kind: 'absent' }` on the
// head lookup and WS-D2 (writer design block) + WS-D4 (design oracle) silently
// no-op'd for the three specs the greenfield loop targets. Migration 0028
// collapses this back to the single per-project head — there is exactly ONE
// product-level contract per project. The writer prompt's mode-awareness lives
// in `subtaskWriterPrompt.ts` + `designOraclePrompt.ts` tail blocks (the v64
// load-bearing fix), NOT here.
//
// This store NEVER injects the contract into the writer (WS-D2) or verifies it
// (WS-D4) — it is the persistence seam those workstreams read from.

import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { ActorRef } from "../state/actor.js";
import { type DesignContractV1, designContractToJson, parseDesignContract } from "../design/designContract.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

/**
 * A persisted `design_contracts` row was PRESENT but its jsonb `contract` payload
 * failed the {@link DesignContractV1} schema parse — a corrupt / legacy-shaped row we
 * refuse to silently degrade. Distinct from the ABSENT case (no row for the project)
 * so a caller can DISTINGUISH "no design phase ran yet" from "the persisted contract
 * is malformed and must not be used" — the corrupt payload is a hard fault the
 * caller propagates loudly (Codex critic #7). The typed class mirrors the neighbor
 * convention (`MalformedAncestorStackError` in `engine/dag/ancestorStack.ts`,
 * landed by PR #740): a data-corruption throw is never a `crashed` opaque default.
 */
export class DesignContractCorruptError extends Error {
  constructor(
    /** The project whose HEAD row failed to parse. */
    readonly projectId: string,
    /** The rejected raw jsonb payload (for diagnostics — a corrupt row). */
    readonly rawValue: unknown,
    /** The underlying parse error (Zod issue text). */
    readonly detail: string,
  ) {
    super(`design_contracts row for project '${projectId}' failed schema parse: ${detail}`);
    this.name = "DesignContractCorruptError";
  }
}

/**
 * Typed lookup state for the HEAD-contract read (Codex critic #7). The store's
 * read has THREE distinguishable outcomes, and the SILENT-FALLBACK bug was
 * collapsing them all to `undefined` — a caller could not tell a legit "no
 * contract yet" project apart from an off-scope actor / RLS block / corrupt row,
 * so it skipped the design ring cleanly in every case. This discriminated union
 * makes each outcome explicit:
 *
 *   - `found`   — the HEAD contract row parsed cleanly.
 *   - `absent`  — the SELECT returned zero rows (a real empty state OR an
 *     off-scope RLS block; the two are indistinguishable at the SQL level and
 *     the CALLER is responsible for guarding against the off-scope shape
 *     upstream — see the `actor.orgId === null` pre-check in the design oracle).
 *   - `corrupt` — the row was present but `parseDesignContract` failed; the
 *     caller MUST throw / emit a blocking finding, never silently skip.
 */
export type DesignContractLookup =
  | { kind: "found"; record: DesignContractRecord }
  | { kind: "absent" }
  | { kind: "corrupt"; error: DesignContractCorruptError };

/** A `design_contracts` row, in domain shape (contract re-parsed through the schema). */
export interface DesignContractRecord {
  id: string;
  orgId: string;
  projectId: string;
  // The monotonic version for this project (1-based). A design change mints
  // the next version rather than overwriting (never-discard).
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

/**
 * Same shape as {@link mapRow} but classifies a parse failure into a typed
 * {@link DesignContractCorruptError} rather than a raw Error (Codex critic #7).
 * Used by {@link DesignContractStore.getLatestState} so a corrupt row surfaces
 * as the `corrupt` lookup variant — the caller decides throw vs. blocking
 * finding, but never silently skips.
 */
function mapRowOrCorrupt(row: DesignContractRow, projectId: string): DesignContractLookup {
  try {
    return { kind: "found", record: mapRow(row) };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return {
      kind: "corrupt",
      error: new DesignContractCorruptError(projectId, row.contract, detail),
    };
  }
}

const COLUMNS = "id, org_id, project_id, version, domain, contract";

export const DesignContractStore = {
  /**
   * Persist a NEW VERSION of a project's design contract. The version is the
   * project's current max + 1 (1-based), computed in the same statement so
   * concurrent creates serialize on the `(project_id, version)` unique index.
   * The contract jsonb is persisted verbatim; `domain` is mirrored into its
   * column. Returns the persisted record.
   *
   * H2 BLOCKING (unify): the design contract describes PRODUCT identity
   * shared across every spec type, so there is exactly ONE product-level head
   * per project — no per-writer-prompt-mode split (migration 0028 collapsed
   * the broken mode-keying).
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
   * Read the HEAD (highest-version) contract for the project — the one the
   * build currently builds against. Undefined when the project has no
   * contract yet (a real empty state — never a defaulted contract). Throws
   * (via `mapRow` → `parseDesignContract`) on a corrupt persisted row —
   * callers that need to DISTINGUISH the corrupt case from absent should use
   * {@link getLatestState} instead (Codex critic #7).
   */
  async getLatest(client: QueryClient, projectId: string, _actor: ActorRef): Promise<DesignContractRecord | undefined> {
    const result = await client.query<DesignContractRow>(
      `SELECT ${COLUMNS} FROM design_contracts WHERE project_id = $1 ORDER BY version DESC LIMIT 1`,
      [projectId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapRow(row);
  },

  /**
   * The TYPED-STATE variant of {@link getLatest} (Codex critic #7). Returns a
   * discriminated {@link DesignContractLookup} so a caller can distinguish
   * `found` from `absent` from `corrupt` — the silent-fallback bug was
   * collapsing all three to `undefined`, letting an off-scope actor / RLS
   * block / corrupt row skip the design ring cleanly (indistinguishable from a
   * legit no-contract project). Callers on the safety-critical path (the
   * design oracle) MUST use this variant — `absent` legitimately skips;
   * `corrupt` is a hard fault the caller propagates loudly (never a silent
   * skip). "Inaccessible" (off-scope actor / null orgId) is the CALLER's
   * responsibility to detect upstream — RLS makes it indistinguishable from
   * `absent` at the SQL level, and the primary detectable form (actor.orgId
   * === null) is caught by a pre-store check in the design oracle before this
   * method is called.
   */
  async getLatestState(client: QueryClient, projectId: string, _actor: ActorRef): Promise<DesignContractLookup> {
    const result = await client.query<DesignContractRow>(
      `SELECT ${COLUMNS} FROM design_contracts WHERE project_id = $1 ORDER BY version DESC LIMIT 1`,
      [projectId],
    );
    const row = result.rows[0];
    if (row === undefined) return { kind: "absent" };
    return mapRowOrCorrupt(row, projectId);
  },

  /**
   * All versions of the project's contract, newest first (the version history).
   */
  async listVersions(client: QueryClient, projectId: string, _actor: ActorRef): Promise<DesignContractRecord[]> {
    const result = await client.query<DesignContractRow>(
      `SELECT ${COLUMNS} FROM design_contracts WHERE project_id = $1 ORDER BY version DESC`,
      [projectId],
    );
    return result.rows.map(mapRow);
  },
} as const;
