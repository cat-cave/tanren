// The merge-coordinator drive-pass CI re-gate (autonomy-engine.md §2d / §2a). When
// the coordinator drives a queued run's merge and P2a auto-rebases the branch, the
// prior green is stale — so the merge stage re-polls CI through this hook BEFORE
// merging. It reuses `pollCiForRun` (the SAME VcsProvider/CI path the run loop
// uses), so NO runner is needed: it is a CI-status read. A green poll is `passed`;
// a failed/timed-out poll holds the merge (so an unverified rebase never merges).

import type pg from "pg";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { VcsProvider } from "../contracts/vcsProvider.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import { PgEventStore, type EventStore } from "../eventStore.js";
import { pollCiForRun } from "../workflow/ciPolling.js";
import type { ReGateCiHook } from "../workflow/reviewMerge/index.js";

export interface BuildReGateCiForQueuedRunDeps {
  pool: pg.Pool;
  eventStore?: EventStore;
  /**
   * Plane-split (autonomy loops): route the re-gate CI poll's `tasks` writes
   * through the control plane when wired (else direct on the pool — byte-identical).
   */
  runStateWriter?: RunStateWriter;
  secrets: SecretStore;
  vcsProvider: VcsProvider;
  runId: string;
  githubCredentialRef: string;
  githubAppMinter?: GithubAppTokenMinter;
}

/** Build the drive-pass re-gate hook: re-poll the run's CI to a terminal verdict. */
export function buildReGateCiForQueuedRun(deps: BuildReGateCiForQueuedRunDeps): ReGateCiHook {
  return async () => {
    const result = await pollCiForRun({
      pool: deps.pool,
      eventStore: deps.eventStore ?? new PgEventStore(deps.pool),
      ...(deps.runStateWriter !== undefined && { runStateWriter: deps.runStateWriter }),
      secrets: deps.secrets,
      vcsProvider: deps.vcsProvider,
      runId: deps.runId,
      githubCredentialRef: deps.githubCredentialRef,
      ...(deps.githubAppMinter !== undefined && { githubAppMinter: deps.githubAppMinter }),
    });
    if (result.status === "passed") {
      return { status: "passed" };
    }
    if (result.status === "failed") {
      return { status: "failed" };
    }
    return { status: "pending" };
  };
}
