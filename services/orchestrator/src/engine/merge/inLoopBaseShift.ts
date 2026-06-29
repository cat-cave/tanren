// Build THE ONE BASE-SHIFT HANDLER for the IN-LOOP `direct_merge` land
// (decomposition PR-7 / §5h). The native_queue DRIVE pass already wires `baseShiftRebase`
// (coordinatorBuild.ts); the in-loop `direct_merge` land did NOT — it fell back to the
// legacy server-side `update-branch`. Wiring it here makes the unified jj base-shift
// UNCONDITIONAL across every land-driving caller (the precondition for deleting the
// `updateBranch` fallback): a `behind` PR branch rebases in place over jj through the SAME
// `BaseShiftCoordinator` the percolation kick-off + the queue DRIVE use.
//
// WHY here (not in plannerRun): the coordinator needs the worker `pg.Pool`, but the merge
// stage threads its pool as the `{ query }`-only `RunStateClient` (the workflow layer is
// pool-shape-agnostic + the architecture check forbids a raw `as pg.Pool` cast in workflow
// code). This module owns the narrowing once — the SAME pattern `mergeAuthorityBundleBuild`
// uses for the durable finalize — so the workflow caller stays cast-free.

import type pg from "pg";
import { buildBaseShiftCoordinator } from "../dag/percolationBuild.js";
import { buildBaseShiftRebaseHook } from "../dag/baseShiftRebaseHook.js";
import type { Allocator } from "../contracts/allocator.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import type { RunStateClient } from "../workflow/reviewMerge/context.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { GitHubHttpClient } from "../providers/github.js";
import type { BaseShiftRebaseHook } from "../workflow/reviewMerge/mergeDispatchTypes.js";

/** The runner + credential deps the in-loop base-shift hook drives a live jj rebase from. */
export interface InLoopBaseShiftDeps {
  /** The worker pool (the merge stage threads it as a `RunStateClient`; narrowed here). */
  pool: RunStateClient;
  /** The shared (timed) GitHub HTTP client the run/merge host seams build over. */
  githubHttp: GitHubHttpClient;
  secrets: SecretStore;
  allocator: Allocator;
  ssh: CommandSubstrate;
  identitySecretRef: string;
  githubAppMinter?: GithubAppTokenMinter;
  runStateWriter: RunStateWriter;
}

/**
 * Build the in-loop `direct_merge` `baseShiftRebase` hook over the live
 * `BaseShiftCoordinator`. `suppressInFlightMarker` is set (the in-loop rebase is a
 * SYNCHRONOUS dispatcher step that re-gates + lands in the same pass — never a deferred
 * percolation the settle poller should pick up), matching the queue DRIVE wiring.
 */
export function buildInLoopBaseShiftRebaseHook(deps: InLoopBaseShiftDeps): BaseShiftRebaseHook {
  // The coordinator needs the full `pg.Pool` (org-scoped persistence/events + the run-row
  // reads). In every land-driving caller `pool` IS the real worker pool at runtime — the
  // SAME narrowing `mergeAuthorityBundleBuild` performs for the durable finalize.
  const pool = deps.pool as pg.Pool;
  const coordinator = buildBaseShiftCoordinator(
    {
      pool,
      githubHttp: deps.githubHttp,
      secrets: deps.secrets,
      allocator: deps.allocator,
      ssh: deps.ssh,
      identitySecretRef: deps.identitySecretRef,
      ...(deps.githubAppMinter !== undefined && { githubAppMinter: deps.githubAppMinter }),
      runStateWriter: deps.runStateWriter,
    },
    { suppressInFlightMarker: true },
  );
  return buildBaseShiftRebaseHook({ pool, coordinator });
}
