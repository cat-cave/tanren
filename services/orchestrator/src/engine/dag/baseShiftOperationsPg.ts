// gv-17: durable base-shift operation history (before/after member vectors +
// invalidation cause). Written when the never-discard BaseShiftCoordinator
// settles a restack; read by operators and by SP-7 proof invalidation.

import { randomUUID } from "node:crypto";
import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { IntegrationNodeMember } from "../contracts/integrationNodes.js";
import type { QueryRunner } from "./integrationNodesPg.js";
// ONE vocabulary: the cause union is declared with the ports the drivers implement, so the
// pure builder that produces it and this writer that persists it cannot drift apart.
import type { BaseShiftInvalidationCause } from "./baseShiftPorts.js";

export type BaseShiftDecision = "rebased_clean" | "rebased_resolved" | "replanned" | "held";
export type { BaseShiftInvalidationCause };

export interface BaseShiftOperationInput {
  orgId: string;
  projectId: string;
  nodeId?: string;
  dependentRunId: string;
  dependentSpecId: string;
  ancestorSpecId?: string;
  fromBaseSha: string;
  toBaseSha: string;
  fromMemberKey: string;
  toMemberKey: string;
  fromMembers: ReadonlyArray<IntegrationNodeMember>;
  toMembers: ReadonlyArray<IntegrationNodeMember>;
  decision: BaseShiftDecision;
  invalidationCause: BaseShiftInvalidationCause;
}

export interface BaseShiftOperationRecord extends BaseShiftOperationInput {
  opId: string;
  createdAt: Date;
}

/** Persist one base-shift operation on an already org-scoped client. */
export async function recordBaseShiftOperationOnClient(
  client: QueryRunner,
  input: BaseShiftOperationInput,
): Promise<string> {
  const opId = `bso_${randomUUID()}`;
  await client.query(
    `INSERT INTO base_shift_operations
       (op_id, org_id, project_id, node_id, dependent_run_id, dependent_spec_id,
        ancestor_spec_id, from_base_sha, to_base_sha, from_member_key, to_member_key,
        from_members, to_members, decision, invalidation_cause)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15)`,
    [
      opId,
      input.orgId,
      input.projectId,
      input.nodeId ?? null,
      input.dependentRunId,
      input.dependentSpecId,
      input.ancestorSpecId ?? null,
      input.fromBaseSha,
      input.toBaseSha,
      input.fromMemberKey,
      input.toMemberKey,
      JSON.stringify(input.fromMembers),
      JSON.stringify(input.toMembers),
      input.decision,
      input.invalidationCause,
    ],
  );
  return opId;
}

/** Org-scoped writer for base-shift history. */
export class PgBaseShiftOperationStore {
  constructor(private readonly pool: pg.Pool) {}

  async record(input: BaseShiftOperationInput): Promise<string> {
    return runWithOrgScope(this.pool, input.orgId, (client) => recordBaseShiftOperationOnClient(client, input));
  }

  /** Chronological base-shift history for a dependent run (before/after vectors). */
  async listForDependentRun(orgId: string, dependentRunId: string): Promise<BaseShiftOperationRecord[]> {
    return runWithOrgScope(this.pool, orgId, async (client) => {
      const result = await client.query<{
        op_id: string;
        org_id: string;
        project_id: string;
        node_id: string | null;
        dependent_run_id: string;
        dependent_spec_id: string;
        ancestor_spec_id: string | null;
        from_base_sha: string;
        to_base_sha: string;
        from_member_key: string;
        to_member_key: string;
        from_members: unknown;
        to_members: unknown;
        decision: BaseShiftDecision;
        invalidation_cause: BaseShiftInvalidationCause;
        created_at: Date;
      }>(
        `SELECT op_id, org_id, project_id, node_id, dependent_run_id, dependent_spec_id,
                ancestor_spec_id, from_base_sha, to_base_sha, from_member_key, to_member_key,
                from_members, to_members, decision, invalidation_cause, created_at
           FROM base_shift_operations
          WHERE dependent_run_id = $1
          ORDER BY created_at ASC`,
        [dependentRunId],
      );
      return result.rows.map((row) => ({
        opId: row.op_id,
        orgId: row.org_id,
        projectId: row.project_id,
        ...(row.node_id !== null && { nodeId: row.node_id }),
        dependentRunId: row.dependent_run_id,
        dependentSpecId: row.dependent_spec_id,
        ...(row.ancestor_spec_id !== null && { ancestorSpecId: row.ancestor_spec_id }),
        fromBaseSha: row.from_base_sha,
        toBaseSha: row.to_base_sha,
        fromMemberKey: row.from_member_key,
        toMemberKey: row.to_member_key,
        fromMembers: decodeHistoryMembers(row.from_members, row.op_id, "from_members"),
        toMembers: decodeHistoryMembers(row.to_members, row.op_id, "to_members"),
        decision: row.decision,
        invalidationCause: row.invalidation_cause,
        createdAt: row.created_at,
      }));
    });
  }
}

/** Fail-closed decode of a history member vector (never invent empty on corrupt JSON). */
function decodeHistoryMembers(value: unknown, opId: string, field: string): IntegrationNodeMember[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`base_shift_operations ${opId}.${field} is not an array`);
  }
  const out: IntegrationNodeMember[] = [];
  for (const [index, m] of value.entries()) {
    if (m === null || typeof m !== "object") {
      throw new TypeError(`base_shift_operations ${opId}.${field}[${index}] is not an object`);
    }
    const specId = Reflect.get(m, "specId");
    const runId = Reflect.get(m, "runId");
    const branch = Reflect.get(m, "branch");
    const headSha = Reflect.get(m, "headSha");
    if (
      typeof specId !== "string" ||
      typeof runId !== "string" ||
      typeof branch !== "string" ||
      typeof headSha !== "string" ||
      specId === "" ||
      runId === "" ||
      branch === "" ||
      headSha === ""
    ) {
      throw new TypeError(`base_shift_operations ${opId}.${field}[${index}] missing required string fields`);
    }
    out.push({ specId, runId, branch, headSha });
  }
  return out;
}
