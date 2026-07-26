import type { RunnerHandle } from "../contracts/allocator.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import { resolveWorkspaceHeadSha } from "../workspace/index.js";
import { readDurableDraftPrPublishedHead } from "./githubDraftPrLease.js";

type DurableLeaseInput = {
  pool: { query(sql: string, params: readonly unknown[]): Promise<{ rows: readonly unknown[] }> };
};

/**
 * Publish against the immutable prior head for the stable spec-derived branch.
 * The downstream publisher performs the immediate exact remote-ref read and
 * force-with-lease CAS; this lookup supplies the durable predecessor it must
 * equal, never process-local rework state.
 */
export async function publishDraftPullRequestWithDurableLease<T extends DurableLeaseInput, R>(
  input: T,
  durable: { orgId: string; specId: string; branch: string },
  publish: (input: T & { expectedPublishedHeadSha?: string }) => Promise<R>,
): Promise<R> {
  const expectedPublishedHeadSha = await readDurableDraftPrPublishedHead(input.pool, durable);
  return await publish({ ...input, ...(expectedPublishedHeadSha !== undefined && { expectedPublishedHeadSha }) });
}

/** Manual publication must persist a real head, never the fake-SSH empty sentinel. */
export async function resolveManualDraftPrHead(input: {
  ssh: CommandSubstrate;
  target: RunnerHandle;
  workspacePath: string;
}): Promise<string> {
  const headSha = await resolveWorkspaceHeadSha(input);
  if (!/^[0-9a-f]{40}$/u.test(headSha)) {
    throw new Error("manual draft PR workspace head is invalid; refusing to publish without a durable lease witness");
  }
  return headSha;
}
