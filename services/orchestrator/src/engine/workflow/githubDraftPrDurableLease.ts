import type { RunnerHandle } from "../contracts/allocator.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import { buildActivityWatchdog } from "../ssh/activityWatchdog.js";
import { quoteSshShellArg } from "../ssh/command.js";
import { resolveWorkspaceHeadSha } from "../workspace/index.js";
import { runWorkspaceSshCommand } from "../workspace/ssh.js";
import { readDurableDraftPrPublishedHead } from "./githubDraftPrLease.js";

type DurableLeaseInput = {
  pool: { query(sql: string, params: readonly unknown[]): Promise<{ rows: readonly unknown[] }> };
  repoUrl: string;
};

/**
 * Publish against the immutable prior head for the stable spec-derived branch.
 * The downstream publisher performs the immediate exact remote-ref read and
 * force-with-lease CAS; this lookup supplies the durable predecessor it must
 * equal, never process-local rework state.
 */
export async function publishDraftPullRequestWithDurableLease<T extends DurableLeaseInput, R>(
  input: T,
  durable: {
    orgId: string;
    specId: string;
    branch: string;
    expectedPublishedHeadSha?: string;
    predecessorEstablished?: boolean;
  },
  publish: (input: T & { expectedPublishedHeadSha?: string }) => Promise<R>,
): Promise<R> {
  const expectedPublishedHeadSha = durable.predecessorEstablished
    ? durable.expectedPublishedHeadSha
    : await readDurableDraftPrPublishedHead(input.pool, { ...durable, repoUrl: input.repoUrl });
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

/**
 * A manual rework may only advance the durable publication. If the workspace
 * snapshot predates the last published head, a valid remote lease alone would
 * still permit rolling that publication back. Require the durable predecessor
 * to be an ancestor of the exact snapshot that will be pushed; an absent
 * predecessor is the first-publication case and has no ancestry to prove.
 */
export async function assertManualDraftPrHeadAdvancesFrom(
  input: {
    ssh: CommandSubstrate;
    target: RunnerHandle;
    workspacePath: string;
  },
  predecessorSha: string | undefined,
  headSha: string,
): Promise<void> {
  if (predecessorSha === undefined) return;
  if (!/^[0-9a-f]{40}$/u.test(predecessorSha)) {
    throw new Error("manual draft PR durable predecessor is invalid; refusing to bind workspace snapshot");
  }
  await runWorkspaceSshCommand(input.ssh, input.target, {
    label: "verify manual draft PR workspace snapshot ancestry",
    cwd: input.workspacePath,
    watchdog: buildActivityWatchdog({
      substrate: input.ssh,
      target: input.target,
      cls: "vcs",
      workspace: input.workspacePath,
    }),
    command: `git merge-base --is-ancestor ${quoteSshShellArg(predecessorSha)} ${quoteSshShellArg(headSha)}`,
  });
}

/** Resolve a manual snapshot and bind it to one stable durable predecessor. */
export async function resolveBoundManualDraftPrHead(input: {
  pool: DurableLeaseInput["pool"];
  orgId: string;
  specId: string;
  branch: string;
  repoUrl: string;
  ssh: CommandSubstrate;
  target: RunnerHandle;
  workspacePath: string;
}): Promise<{ predecessorSha: string | undefined; headSha: string }> {
  // Establish the predecessor before observing mutable workspace state.
  const predecessorSha = await readDurableDraftPrPublishedHead(input.pool, input);
  const headSha = await resolveManualDraftPrHead(input);
  // A concurrent publication may commit between those observations. Refuse to
  // pair its newer witness with this snapshot; the remote CAS is not enough.
  const currentPredecessorSha = await readDurableDraftPrPublishedHead(input.pool, input);
  if (currentPredecessorSha !== predecessorSha) {
    throw new Error("manual draft PR durable predecessor advanced while resolving workspace snapshot");
  }
  await assertManualDraftPrHeadAdvancesFrom(input, currentPredecessorSha, headSha);
  return { predecessorSha: currentPredecessorSha, headSha };
}
