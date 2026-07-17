// cspell:ignore scontract iloop
import { runWithOrgScope } from "@tanren/db";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import {
  SymptomContractV1Schema,
  symptomContractHash,
  type SymptomContractProofPolicy,
  type SymptomContractV1,
} from "../contracts/symptomContract.js";
import { PgEventStore, type EventStore } from "../eventStore.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

export const SYMPTOM_CONTRACT_STATES = ["draft", "authored", "validated", "superseded", "authoring_failed"] as const;
export type SymptomContractState = (typeof SYMPTOM_CONTRACT_STATES)[number];

export interface SymptomContractRow {
  readonly orgId: string;
  readonly projectId: string;
  readonly id: string;
  readonly issueLoopId: string;
  readonly schemaVersion: number;
  readonly contract: SymptomContractV1;
  readonly canonicalHash: string;
  readonly proofPolicy: SymptomContractProofPolicy;
  readonly target: Record<string, unknown>;
  readonly sourceRevision: string | null;
  readonly authorTaskId: string | null;
  readonly state: SymptomContractState;
  readonly baselineRequired: boolean;
  readonly createdAt: Date;
}

export interface SymptomContractFragmentRow {
  readonly orgId: string;
  readonly contractId: string;
  readonly fragmentId: string;
  readonly version: number;
  readonly contentHash: string;
  readonly conformanceResult: string | null;
}

export interface CreateSymptomContractInput {
  readonly orgId: string;
  readonly projectId: string;
  readonly contract: SymptomContractV1;
  readonly authorTaskId?: string | null;
}

export interface MarkValidatedInput {
  readonly orgId: string;
  readonly contractId: string;
  readonly validationTaskId?: string;
}

export interface MarkSupersededInput {
  readonly orgId: string;
  readonly contractId: string;
  readonly supersededByContractId: string;
}

export interface BindSymptomContractFragmentInput {
  readonly orgId: string;
  readonly contractId: string;
  readonly fragmentId: string;
  readonly version: number;
  readonly contentHash: string;
  readonly conformanceResult?: string | null;
}

interface RawSymptomContractRow {
  org_id: string;
  project_id: string;
  id: string;
  issue_loop_id: string;
  schema_version: number | string;
  contract_json: unknown;
  canonical_hash: string;
  proof_policy: string | null;
  target: unknown;
  source_revision: string | null;
  author_task_id: string | null;
  state: string;
  baseline_required: boolean;
  created_at: Date;
}

interface RawSymptomContractFragmentRow {
  org_id: string;
  contract_id: string;
  fragment_id: string;
  version: number | string;
  content_hash: string;
  conformance_result: string | null;
}

const CONTRACT_COLUMNS =
  "org_id, project_id, id, issue_loop_id, schema_version, contract_json, canonical_hash, proof_policy, target, source_revision, author_task_id, state, baseline_required, created_at";
const FRAGMENT_COLUMNS = "org_id, contract_id, fragment_id, version, content_hash, conformance_result";

function stateOf(value: string): SymptomContractState {
  if ((SYMPTOM_CONTRACT_STATES as readonly string[]).includes(value)) return value as SymptomContractState;
  throw new Error(`invalid symptom contract state: ${value}`);
}

function mapContractRow(row: RawSymptomContractRow): SymptomContractRow {
  const contract = SymptomContractV1Schema.parse(row.contract_json);
  const canonicalHash = symptomContractHash(contract);
  if (canonicalHash !== row.canonical_hash) {
    throw new Error(`symptom contract ${row.id} canonical hash does not match contract_json`);
  }
  if (row.proof_policy !== contract.proofPolicy) {
    throw new Error(`symptom contract ${row.id} proof policy mirror does not match contract_json`);
  }
  if (row.source_revision !== contract.sourceRevision || row.baseline_required !== contract.baselineRequired) {
    throw new Error(`symptom contract ${row.id} scalar mirrors do not match contract_json`);
  }
  if (row.target === null || typeof row.target !== "object" || Array.isArray(row.target)) {
    throw new Error(`symptom contract ${row.id} target is not a JSON object`);
  }
  return {
    orgId: row.org_id,
    projectId: row.project_id,
    id: row.id,
    issueLoopId: row.issue_loop_id,
    schemaVersion: Number(row.schema_version),
    contract,
    canonicalHash,
    proofPolicy: contract.proofPolicy,
    target: row.target as Record<string, unknown>,
    sourceRevision: row.source_revision,
    authorTaskId: row.author_task_id,
    state: stateOf(row.state),
    baselineRequired: row.baseline_required,
    createdAt: row.created_at,
  };
}

function mapFragmentRow(row: RawSymptomContractFragmentRow): SymptomContractFragmentRow {
  return {
    orgId: row.org_id,
    contractId: row.contract_id,
    fragmentId: row.fragment_id,
    version: Number(row.version),
    contentHash: row.content_hash,
    conformanceResult: row.conformance_result,
  };
}

export class SymptomContractNotFoundError extends Error {
  override readonly name = "SymptomContractNotFoundError";

  constructor(readonly contractId: string) {
    super(`symptom contract ${contractId} not found`);
  }
}

type ContractEventStore = Pick<EventStore, "append">;

/** Immutable, org-scoped symptom-contract snapshots and fragment bindings. */
export class SymptomContractStore {
  private readonly eventStore: ContractEventStore;

  constructor(
    private readonly pool: pg.Pool,
    eventStore?: ContractEventStore,
  ) {
    this.eventStore = eventStore ?? new PgEventStore(pool);
  }

  async create(input: CreateSymptomContractInput): Promise<SymptomContractRow> {
    return runWithOrgScope(this.pool, input.orgId, async (client) => {
      const contract = SymptomContractV1Schema.parse(input.contract);
      const row = await this.insertVersion(client, {
        orgId: input.orgId,
        projectId: input.projectId,
        contract,
        state: "authored",
        authorTaskId: input.authorTaskId ?? null,
      });
      await this.eventStore.append({
        orgId: row.orgId,
        projectId: row.projectId,
        eventType: "symptom.contract.authored",
        payload: {
          projectId: row.projectId,
          issueLoopId: row.issueLoopId,
          contractId: row.id,
          schemaVersion: row.schemaVersion,
          canonicalHash: row.canonicalHash,
          ...(row.sourceRevision === null ? {} : { sourceRevision: row.sourceRevision }),
          ...(row.authorTaskId === null ? {} : { authorTaskId: row.authorTaskId }),
          baselineRequired: row.baselineRequired,
        },
      });
      return row;
    });
  }

  async get(orgId: string, contractId: string): Promise<SymptomContractRow | undefined> {
    return runWithOrgScope(this.pool, orgId, (client) => this.getOnClient(client, orgId, contractId));
  }

  /** Return the newest immutable snapshot for an issue loop. */
  async getByIssueLoop(orgId: string, issueLoopId: string): Promise<SymptomContractRow | undefined> {
    return runWithOrgScope(this.pool, orgId, async (client) => {
      const result = await client.query<RawSymptomContractRow>(
        `SELECT ${CONTRACT_COLUMNS}
           FROM symptom_contracts
          WHERE org_id = $1 AND issue_loop_id = $2
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
        [orgId, issueLoopId],
      );
      return result.rows[0] === undefined ? undefined : mapContractRow(result.rows[0]);
    });
  }

  /** Return all immutable snapshots for an issue loop, newest first. */
  async listVersions(orgId: string, issueLoopId: string): Promise<SymptomContractRow[]> {
    return runWithOrgScope(this.pool, orgId, async (client) => {
      const result = await client.query<RawSymptomContractRow>(
        `SELECT ${CONTRACT_COLUMNS}
           FROM symptom_contracts
          WHERE org_id = $1 AND issue_loop_id = $2
          ORDER BY created_at DESC, id DESC`,
        [orgId, issueLoopId],
      );
      return result.rows.map(mapContractRow);
    });
  }

  async markValidated(input: MarkValidatedInput): Promise<SymptomContractRow> {
    return runWithOrgScope(this.pool, input.orgId, async (client) => {
      const prior = await this.requireOnClient(client, input.orgId, input.contractId);
      const row = await this.insertVersion(client, {
        prior,
        contract: prior.contract,
        state: "validated",
        authorTaskId: prior.authorTaskId,
      });
      await this.eventStore.append({
        orgId: row.orgId,
        projectId: row.projectId,
        eventType: "symptom.contract.validated",
        payload: {
          projectId: row.projectId,
          issueLoopId: row.issueLoopId,
          contractId: row.id,
          canonicalHash: row.canonicalHash,
          ...(input.validationTaskId === undefined ? {} : { validationTaskId: input.validationTaskId }),
        },
      });
      return row;
    });
  }

  async markSuperseded(input: MarkSupersededInput): Promise<SymptomContractRow> {
    return runWithOrgScope(this.pool, input.orgId, async (client) => {
      const prior = await this.requireOnClient(client, input.orgId, input.contractId);
      const row = await this.insertVersion(client, {
        prior,
        contract: prior.contract,
        state: "superseded",
        authorTaskId: prior.authorTaskId,
      });
      await this.eventStore.append({
        orgId: row.orgId,
        projectId: row.projectId,
        eventType: "symptom.contract.superseded",
        payload: {
          projectId: row.projectId,
          issueLoopId: row.issueLoopId,
          contractId: row.id,
          supersededByContractId: input.supersededByContractId,
        },
      });
      return row;
    });
  }

  async bindFragment(input: BindSymptomContractFragmentInput): Promise<SymptomContractFragmentRow> {
    return runWithOrgScope(this.pool, input.orgId, async (client) => {
      const result = await client.query<RawSymptomContractFragmentRow>(
        `INSERT INTO symptom_contract_fragments
           (org_id, contract_id, fragment_id, version, content_hash, conformance_result)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (org_id, contract_id, fragment_id)
         DO UPDATE SET version = EXCLUDED.version,
                       content_hash = EXCLUDED.content_hash,
                       conformance_result = EXCLUDED.conformance_result
         RETURNING ${FRAGMENT_COLUMNS}`,
        [
          input.orgId,
          input.contractId,
          input.fragmentId,
          input.version,
          input.contentHash,
          input.conformanceResult ?? null,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error(`symptom contract fragment binding returned no row`);
      return mapFragmentRow(row);
    });
  }

  async listFragments(orgId: string, contractId: string): Promise<SymptomContractFragmentRow[]> {
    return runWithOrgScope(this.pool, orgId, async (client) => {
      const result = await client.query<RawSymptomContractFragmentRow>(
        `SELECT ${FRAGMENT_COLUMNS}
           FROM symptom_contract_fragments
          WHERE org_id = $1 AND contract_id = $2
          ORDER BY fragment_id`,
        [orgId, contractId],
      );
      return result.rows.map(mapFragmentRow);
    });
  }

  private async getOnClient(
    client: QueryClient,
    orgId: string,
    contractId: string,
  ): Promise<SymptomContractRow | undefined> {
    const result = await client.query<RawSymptomContractRow>(
      `SELECT ${CONTRACT_COLUMNS}
         FROM symptom_contracts
        WHERE org_id = $1 AND id = $2`,
      [orgId, contractId],
    );
    return result.rows[0] === undefined ? undefined : mapContractRow(result.rows[0]);
  }

  private async requireOnClient(client: QueryClient, orgId: string, contractId: string): Promise<SymptomContractRow> {
    const row = await this.getOnClient(client, orgId, contractId);
    if (row === undefined) throw new SymptomContractNotFoundError(contractId);
    return row;
  }

  private async insertVersion(
    client: QueryClient,
    input: {
      readonly orgId?: string;
      readonly projectId?: string;
      readonly prior?: SymptomContractRow;
      readonly contract: SymptomContractV1;
      readonly state: SymptomContractState;
      readonly authorTaskId: string | null;
    },
  ): Promise<SymptomContractRow> {
    const contract = SymptomContractV1Schema.parse(input.contract);
    const id = `scontract_${randomUUID()}`;
    const orgId = input.orgId ?? input.prior?.orgId;
    const projectId = input.projectId ?? input.prior?.projectId;
    if (orgId === undefined || projectId === undefined)
      throw new Error("symptom contract version has no tenant identity");
    const result = await client.query<RawSymptomContractRow>(
      `INSERT INTO symptom_contracts
         (org_id, project_id, id, issue_loop_id, schema_version, contract_json,
          canonical_hash, proof_policy, target, source_revision, author_task_id,
          state, baseline_required)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb, $10, $11, $12, $13)
       RETURNING ${CONTRACT_COLUMNS}`,
      [
        orgId,
        projectId,
        id,
        contract.issueLoopId,
        contract.version,
        JSON.stringify(contract),
        symptomContractHash(contract),
        contract.proofPolicy,
        JSON.stringify(contract.target),
        contract.sourceRevision,
        input.authorTaskId,
        input.state,
        contract.baselineRequired,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error(`symptom contract insert returned no row for ${orgId}/${projectId}`);
    return mapContractRow(row);
  }
}
