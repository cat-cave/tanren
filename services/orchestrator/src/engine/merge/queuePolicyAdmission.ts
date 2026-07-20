// Admission persistence stays outside the queue model so policy snapshots and holds
// are inserted as one transaction without enlarging the production queue adapter.
import type pg from "pg";
import { PgEventStore } from "../eventStore.js";
import type { PgMergeQueuePartitionStore } from "./mergeQueuePartitionStore.js";
import type { QueuePolicyController, QueuePolicyDecision } from "./queuePolicyController.js";

export interface QueueAdmissionInput {
  projectId: string;
  runId: string;
  specId: string;
  prUrl: string;
  prNumber: number;
  targetBranch?: string;
  scopeFingerprint?: string;
}

export async function insertPolicyQueueEntry(input: {
  client: pg.PoolClient;
  orgId: string;
  policy: QueuePolicyController;
  partitions: PgMergeQueuePartitionStore;
  queueId: string;
  entry: QueueAdmissionInput;
}): Promise<void> {
  const targetBranch = input.entry.targetBranch ?? "main";
  const applied = await input.policy.applyOnClient(input.client, {
    kind: "admission",
    orgId: input.orgId,
    projectId: input.entry.projectId,
    targetBranch,
  });
  if (!isQueuePolicyDecision(applied)) throw new Error("queue policy admission returned an invalid decision");
  const partition = await input.partitions.ensureOnClient(input.client, {
    orgId: input.orgId,
    projectId: input.entry.projectId,
    specId: input.entry.specId,
    targetBranch,
    ...(input.entry.scopeFingerprint === undefined ? {} : { scopeFingerprint: input.entry.scopeFingerprint }),
    ...(applied.kind === "admit" ? { mode: applied.mode, capacity: applied.capacity } : {}),
  });
  await input.client.query(
    `INSERT INTO merge_queue
       (queue_id, run_id, spec_id, project_id, org_id, status, pr_url, pr_number, partition_id, scope_fingerprint,
        target_branch, policy_snapshot, route_snapshot, priority_snapshot, policy_hold_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14::jsonb, $15)`,
    [
      input.queueId,
      input.entry.runId,
      input.entry.specId,
      input.entry.projectId,
      input.orgId,
      applied.kind === "admit" ? "queued" : "held_policy",
      input.entry.prUrl,
      String(input.entry.prNumber),
      partition.id,
      input.entry.scopeFingerprint ?? `spec:${input.entry.specId}`,
      targetBranch,
      applied.kind === "admit" ? JSON.stringify({ policyId: applied.policyId }) : null,
      applied.kind === "admit"
        ? JSON.stringify({
            route: applied.route,
            batchLimit: applied.batchLimit,
            deployGroupLimit: applied.deployGroupLimit,
          })
        : null,
      applied.kind === "admit" ? JSON.stringify({ priority: applied.priority, aging: applied.aging }) : null,
      applied.kind === "hold" ? applied.reason : null,
    ],
  );
  if (applied.kind === "hold") {
    await new PgEventStore(input.client).append({
      orgId: input.orgId,
      projectId: input.entry.projectId,
      eventType: "merge.queue.admission_held",
      payload: { queueId: input.queueId, reason: applied.reason, phase: "admission" },
    });
  }
}

function isQueuePolicyDecision(value: unknown): value is QueuePolicyDecision {
  return typeof value === "object" && value !== null && "kind" in value;
}
