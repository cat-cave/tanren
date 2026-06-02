// The planner-loop's CI-poll tail helpers, split out of plannerRun.ts to keep
// that file under the 500-line architecture cap.
//
// `pollCiUntilTerminal` drives `pollCiForRun` to a terminal verdict (green
// resolves; failed/timed-out throws). `buildReGateCi` is the P2a hook the merge
// stage calls AFTER an auto-rebase advances the branch: it re-runs the same CI
// poll (the prior green is stale) and maps the outcome onto the merge stage's
// terminal-status contract — a throw becomes `failed`, so the merge stage HOLDS
// rather than merging unverified work.

import { pollCiForRun, type PollCiForRunResult } from "./ciPolling.js";
import type { ReGateCiHook } from "./reviewMerge/index.js";
import type { RunPlannerLoopInput } from "./plannerRun.js";

export async function pollCiUntilTerminal(input: RunPlannerLoopInput): Promise<PollCiForRunResult> {
  const maxPolls = input.maxCiPolls ?? 12;
  const delayMs = input.ciPollDelayMs ?? 10_000;
  const sleep =
    input.sleep ??
    ((ms) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  let last: PollCiForRunResult | undefined;
  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    last = await pollCiForRun({
      pool: input.pool,
      eventStore: input.eventStore,
      ...(input.runStateWriter === undefined ? {} : { runStateWriter: input.runStateWriter }),
      secrets: input.secrets,
      vcsProvider: input.vcsProvider,
      runId: input.context.runId,
      githubCredentialRef: input.context.githubCredentialRef,
    });
    if (last.status === "passed") {
      return last;
    }
    if (last.status === "failed") {
      throw new Error(`planner-loop CI failed: ${last.reason}`);
    }
    if (attempt < maxPolls - 1) {
      await sleep(delayMs);
    }
  }
  throw new Error(`planner-loop CI did not finish after ${maxPolls} polls: ${last?.reason ?? "not_polled"}`);
}

/**
 * P2a: build the merge stage's re-gate hook. After an auto-rebase the prior
 * green is stale, so re-poll CI; a green poll is `passed`, a failed/timed-out
 * poll (a throw) is `failed`, so the merge stage never merges on an unverified
 * rebase.
 */
export function buildReGateCi(input: RunPlannerLoopInput): ReGateCiHook {
  return async () => {
    try {
      await pollCiUntilTerminal(input);
      return { status: "passed" };
    } catch {
      return { status: "failed" };
    }
  };
}
