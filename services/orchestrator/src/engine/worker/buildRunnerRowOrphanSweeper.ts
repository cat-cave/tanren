// Boot wiring for the RUNNER-ROW ORPHAN SWEEPER (task #9). The sweeper
// reconciles `runners` rows the in-memory `release()` missed (orchestrator-
// crash-mid-run shape) for the long-lived allocator kinds (static, manual-ssh).
//
// WIRING SCOPE — wired ONLY when the resolved allocator kind is on the
// long-lived allowlist (`static`, `manual_ssh`, `router`). The router path is
// included because a router can DISPATCH to either long-lived kind on a
// per-allocate basis, so its orphan-row class is the same. Cloud / sidecar
// kinds (sidecar, hetzner, digitalocean, gcp, aws_ec2, kubernetes) destroy
// their runner's resource on release; the sidecar service additionally has its
// OWN sweeper for the docker side. The orchestrator-side sweeper would be a
// no-op for those, so it stays OFF.
//
// The kind read goes through the SAME loud parser the allocator builder uses
// (`resolveBootedAllocatorKind`): UNSET → `sidecar` (off, expected), a typo'd
// kind FAILS LOUD here rather than silently disabling the sweeper.

import type pg from "pg";
import { resolveBootedAllocatorKind, type BootedAllocatorKind } from "../allocators/buildAllocator.js";
import { RunnerRowOrphanSweeper } from "../allocators/runnerRowOrphanSweeper.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("runner-row-orphan-sweeper");
// Re-exported (as a type) so the worker boot imports the sweeper TYPE + its
// starter from a SINGLE module — keeping boot.ts under its dependency-count cap.
export type { RunnerRowOrphanSweeper } from "../allocators/runnerRowOrphanSweeper.js";

export interface BuildRunnerRowOrphanSweeperDeps {
  pool: pg.Pool;
}

/**
 * The set of {@link BootedAllocatorKind} values whose runner-row leak class the
 * orphan sweeper covers — the long-lived external-host kinds + `router`
 * (which can dispatch to them per-allocate). Anything else is OFF.
 */
const SWEEPER_WIRED_FOR: ReadonlySet<BootedAllocatorKind> = new Set<BootedAllocatorKind>([
  "static",
  "manual_ssh",
  "router",
]);

/**
 * Build + start the orphan sweeper when the allocator kind is long-lived
 * (static / manual_ssh / router), else return undefined (and log why). The
 * returned handle's `stop()` is folded into the worker's drain.
 */
export function startRunnerRowOrphanSweeper(deps: BuildRunnerRowOrphanSweeperDeps): RunnerRowOrphanSweeper | undefined {
  const allocatorKind = resolveBootedAllocatorKind();
  if (!SWEEPER_WIRED_FOR.has(allocatorKind)) {
    log.info(
      "OFF for this allocator kind — cloud / sidecar runners destroy their underlying resource on release and the " +
        "sidecar service has its own runner sweeper, so this orchestrator-side row reconciler would be a no-op.",
      { allocatorKind },
    );
    return undefined;
  }
  const sweeper = new RunnerRowOrphanSweeper({ pool: deps.pool });
  sweeper.start();
  log.info("ON (long-lived runners — static/manual_ssh/router)", { allocatorKind });
  return sweeper;
}
