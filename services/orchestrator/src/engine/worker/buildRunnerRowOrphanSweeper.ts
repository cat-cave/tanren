// Boot wiring for the RUNNER-ROW ORPHAN SWEEPER (task #9). The sweeper
// reconciles `runners` rows the in-memory `release()` missed (orchestrator-
// crash-mid-run shape) for the `fixed_pool` taxonomy of allocators — the
// long-lived-external-host kinds whose release ONLY frees a lease (never
// destroys), so a crash mid-run leaves an orphan mirror row without a
// destroyed cloud resource on the other side to reconcile it.
//
// WIRING SCOPE — wired ONLY when the resolved allocator kind's taxonomy is
// `fixed_pool` (static, manual_ssh) OR when the router is booted (the router
// can DISPATCH to any registered kind, including fixed-pool kinds, per
// allocate — its orphan-row class is at least the union of what it can route
// to). `provisioning` cloud kinds destroy the underlying resource on release;
// `delegated` (sidecar) also destroys (via the sidecar service, which
// additionally has its own orphan sweeper on the docker side). The
// orchestrator-side sweeper would be a no-op for either, so it stays OFF.
//
// The kind read goes through the SAME loud parser the allocator builder uses
// (`resolveBootedAllocatorKind`): UNSET → `sidecar` (off, expected), a typo'd
// kind FAILS LOUD here rather than silently disabling the sweeper.

import type pg from "pg";
import { resolveBootedAllocatorKind, type BootedAllocatorKind } from "../allocators/buildAllocator.js";
import { allocatorTaxonomyFor } from "../allocators/poolPolicy.js";
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
 * Whether the sweeper should be wired for the given resolved allocator kind.
 * The gate reads the KIND-level {@link allocatorTaxonomyFor} — `fixed_pool`
 * matches the sweeper's exact leak class (release frees a lease, doesn't
 * destroy). `router` is included as a sentinel because a router can dispatch
 * to any registered kind per-allocate, including a fixed-pool one. Every
 * other taxonomy (`provisioning` / `delegated`) is OFF: release tears the
 * resource down, so there is no orphan-mirror-row class for this sweeper to
 * cover.
 */
function isSweeperWiredForKind(kind: BootedAllocatorKind): boolean {
  if (kind === "router") {
    return true;
  }
  return allocatorTaxonomyFor(kind) === "fixed_pool";
}

/**
 * Build + start the orphan sweeper when the allocator kind's taxonomy is
 * `fixed_pool` (or the router sentinel), else return undefined (and log why).
 * The returned handle's `stop()` is folded into the worker's drain.
 */
export function startRunnerRowOrphanSweeper(deps: BuildRunnerRowOrphanSweeperDeps): RunnerRowOrphanSweeper | undefined {
  const allocatorKind = resolveBootedAllocatorKind();
  if (!isSweeperWiredForKind(allocatorKind)) {
    log.info(
      "OFF for this allocator kind — provisioning / delegated allocators destroy their underlying resource on " +
        "release (the sidecar service additionally has its own runner sweeper), so this orchestrator-side row " +
        "reconciler would be a no-op.",
      { allocatorKind },
    );
    return undefined;
  }
  const sweeper = new RunnerRowOrphanSweeper({ pool: deps.pool });
  sweeper.start();
  log.info("ON (fixed_pool taxonomy — static / manual_ssh / router)", { allocatorKind });
  return sweeper;
}
