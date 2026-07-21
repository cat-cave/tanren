import type pg from "pg";
import type { RuntimeOutcomeRecord } from "../contracts/runtimeOutcome.js";
import { PgEventStore } from "../eventStore.js";

type QueryClient = Pick<pg.PoolClient, "query">;

export interface RuntimeOutcomeEventContext {
  readonly orgId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly specId: string;
}

/**
 * Persist one immutable terminal authority outcome. The INSERT is SELECT-bound to the
 * actual V2 projection, SP-3 seal, current integration-node member array, and (for a
 * landed result) the exact effect intent. A 0-row INSERT is never treated as success.
 */
export async function persistRuntimeOutcome(
  client: QueryClient,
  input: RuntimeOutcomeRecord,
  event: RuntimeOutcomeEventContext,
): Promise<void> {
  assertRecord(input, event);
  const result = await client.query<{ id: string }>(
    `INSERT INTO merge_runtime_outcomes
       (org_id, project_id, id, authority_decision_id, effect_intent_id, gate_proof_bundle_id,
        proof_bundle_digest, proof_root, quarantine_version, base_sha, head_sha, tree_hash,
        member_set_hash, decision, result, main_sha)
     SELECT $1,$2,$3,$4,$5,g.id,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15
       FROM gate_proof_bundles g
       JOIN proof_bundles b ON b.org_id = g.org_id AND b.id = g.proof_bundle_id
       JOIN integration_nodes n ON n.org_id = g.org_id AND n.node_id = g.integration_node_id
      WHERE g.org_id = $1 AND g.project_id = $2
        AND g.id = $16 AND g.integration_node_id = n.node_id
        AND g.gate_verdict = 'passed' AND g.quarantine_version = $8
        AND b.bundle_digest = $6 AND b.proof_root = $7
        AND b.member_set_hash = $12 AND b.prepared_head_sha = $10 AND b.jj_tree_id = $11
        AND b.expected_main_sha = $9 AND b.gate_config_hash = $17 AND b.policy_version = $18
        AND b.runner_image = $19 AND b.app_env_hash = $20 AND b.quarantine_version = $8
        AND n.status = 'ready' AND n.base_sha = $9 AND n.head_sha = $10 AND n.tree_hash = $11
        AND n.member_key = $12 AND n.members = $21::jsonb
        AND ($14 <> 'landed' OR EXISTS (
          SELECT 1 FROM authority_effect_intents e
          JOIN authority_decisions d ON d.org_id = e.org_id AND d.id = e.decision_id
           WHERE e.org_id = $1 AND e.id = $5 AND e.project_id = $2
             AND e.decision_id = $4 AND e.integration_node_id = n.node_id
             AND e.authorized_sha = $10 AND e.expected_main_sha = $9
             AND d.project_id = $2 AND d.head_sha = $10 AND d.expected_main_sha = $9
             AND d.member_set_hash = $12 AND d.proof_root = $7 AND d.decision = 'authorized'
        ))
     ON CONFLICT (org_id, id) DO NOTHING
     RETURNING id`,
    [
      input.orgId,
      input.projectId,
      input.id,
      input.authorityDecisionId ?? null,
      input.effectIntentId ?? null,
      input.proofBundleDigest,
      input.proofRoot,
      input.quarantineVersion,
      input.baseSha,
      input.headSha,
      input.treeHash,
      input.memberSetHash,
      input.decision,
      input.result,
      input.mainSha ?? null,
      input.gateProofBundleId,
      input.gateConfigHash,
      input.policyVersion,
      input.runnerImage,
      input.appEnvHash,
      JSON.stringify(input.members),
    ],
  );
  if (result.rowCount === 0) {
    await assertExistingExact(client, input);
    return;
  }
  await new PgEventStore(client).append({
    ...event,
    eventType: "merge.runtime_outcome.recorded",
    payload: {
      outcomeId: input.id,
      decision: input.decision,
      result: input.result,
      gateProofBundleId: input.gateProofBundleId,
      proofBundleDigest: input.proofBundleDigest,
      proofRoot: input.proofRoot,
      quarantineVersion: input.quarantineVersion,
      baseSha: input.baseSha,
      headSha: input.headSha,
      memberSetHash: input.memberSetHash,
      ...(input.mainSha === undefined ? {} : { mainSha: input.mainSha }),
    },
  });
}

async function assertExistingExact(client: QueryClient, input: RuntimeOutcomeRecord): Promise<void> {
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM merge_runtime_outcomes
      WHERE org_id = $1 AND id = $2 AND project_id = $3
        AND authority_decision_id IS NOT DISTINCT FROM $4
        AND effect_intent_id IS NOT DISTINCT FROM $5
        AND gate_proof_bundle_id = $6 AND proof_bundle_digest = $7 AND proof_root = $8
        AND quarantine_version = $9 AND base_sha = $10 AND head_sha = $11 AND tree_hash = $12
        AND member_set_hash = $13 AND decision = $14 AND result = $15
        AND main_sha IS NOT DISTINCT FROM $16`,
    [
      input.orgId,
      input.id,
      input.projectId,
      input.authorityDecisionId ?? null,
      input.effectIntentId ?? null,
      input.gateProofBundleId,
      input.proofBundleDigest,
      input.proofRoot,
      input.quarantineVersion,
      input.baseSha,
      input.headSha,
      input.treeHash,
      input.memberSetHash,
      input.decision,
      input.result,
      input.mainSha ?? null,
    ],
  );
  if (existing.rowCount !== 1) throw new Error("runtime outcome coordinate was not inserted or exactly replayed");
}

function assertRecord(input: RuntimeOutcomeRecord, event: RuntimeOutcomeEventContext): void {
  const text = [
    input.orgId,
    input.projectId,
    input.id,
    input.gateProofBundleId,
    input.proofBundleDigest,
    input.proofRoot,
    input.quarantineVersion,
    input.baseSha,
    input.headSha,
    input.treeHash,
    input.memberSetHash,
    input.gateConfigHash,
    input.policyVersion,
    input.runnerImage,
    input.appEnvHash,
    event.orgId,
    event.projectId,
    event.runId,
    event.specId,
  ];
  if (text.some((value) => typeof value !== "string" || value.trim() === "")) {
    throw new TypeError("runtime outcome has a blank or invalid coordinate");
  }
  if (input.orgId !== event.orgId || input.projectId !== event.projectId) {
    throw new Error("runtime outcome event scope diverges from its durable coordinate");
  }
  if (!Array.isArray(input.members) || input.members.length === 0 || !input.members.every(validMember)) {
    throw new TypeError("runtime outcome requires a non-empty exact member set");
  }
  const landed = input.result === "landed";
  if (
    landed !==
      (input.effectIntentId !== undefined && input.authorityDecisionId !== undefined && input.mainSha !== undefined) ||
    (landed && input.decision !== "authorized")
  ) {
    throw new TypeError("runtime outcome effect fields do not match its terminal result");
  }
  if (
    !landed &&
    (input.effectIntentId !== undefined || input.authorityDecisionId !== undefined || input.mainSha !== undefined)
  ) {
    throw new TypeError("non-landed runtime outcome cannot claim a host effect coordinate");
  }
}

function validMember(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  return ["specId", "runId", "branch", "headSha"].every((field) => {
    const candidate = Reflect.get(value, field);
    return typeof candidate === "string" && candidate.trim() !== "";
  });
}
