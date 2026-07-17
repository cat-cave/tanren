// MQ-5 exact member contexts for the durable group receipt path.

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { BatchAuthorityBinding } from "../contracts/batchMergeCoordinator.js";
import type { MergeQueueEntry } from "../contracts/mergeCoordinator.js";
import type { LandGroupMemberContext } from "./landGroupStore.js";

export async function loadMultiMemberLandGroupContexts(input: {
  readonly pool: pg.Pool;
  readonly orgId: string;
  readonly projectId: string;
  readonly entries: ReadonlyArray<MergeQueueEntry>;
  readonly binding: BatchAuthorityBinding;
}): Promise<LandGroupMemberContext[]> {
  const taskByRun = await runWithOrgScope(input.pool, input.orgId, async (client) => {
    const result = await client.query<{ run_id: string; task_id: string }>(
      `SELECT DISTINCT ON (run_id) run_id, task_id
         FROM tasks
        WHERE run_id = ANY($1::text[]) AND kind = 'merge'
        ORDER BY run_id, started_at DESC NULLS LAST, task_id ASC`,
      [input.binding.members.map((member) => member.runId)],
    );
    return new Map(result.rows.map((row) => [row.run_id, row.task_id]));
  });
  return input.binding.members.map((member, index) => {
    const entry = input.entries[index];
    const taskId = taskByRun.get(member.runId);
    if (
      entry === undefined ||
      taskId === undefined ||
      entry.projectId !== input.projectId ||
      entry.runId !== member.runId ||
      entry.specId !== member.specId
    ) {
      throw new Error("land group receipt no longer matches its exact authorized batch");
    }
    return {
      ...member,
      prNumber: entry.prNumber,
      prUrl: entry.prUrl,
      projectId: entry.projectId,
      taskId,
    };
  });
}
