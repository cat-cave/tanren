// Boot wiring for the run-sandbox REAPER (layer 2 of the ≈204 GB disk-leak fix).
// The reaper sweeps a LONG-LIVED runner's `/workspace/runs/*` and removes stale,
// non-active run dirs. It is wired ONLY where the runner is actually long-lived:
//
//   - STATIC (`TANREN_ALLOCATOR_KIND=static`, the dev-compose shared runner): one
//     reused `/workspace` survives every run — this is the exact leak the incident
//     hit. The reaper resolves the SAME SSH target the static allocator uses and
//     sweeps it.
//   - EPHEMERAL kinds (sidecar / hetzner / cloud): the container + its `/workspace`
//     volume are DESTROYED on release, so the sandbox dies with the runner — there
//     is nothing to reap, and sweeping a soon-destroyed runner is wasteful. The
//     reaper is NOT started for these.
//   - `manual_ssh` (a pool of pre-provisioned long-lived hosts) DOES leak the same
//     way, but it is a multi-host pool with no single sweep target — a per-host
//     reaper is a follow-up. We do not silently pretend to cover it: the boot logs
//     that the reaper is OFF for the configured kind.
//
// Retention + cadence are governed CONFIG (AllocatorConfig), never env vars — see
// `resolveRunWorkspaceReaperConfig`.

import { runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import { resolveRunWorkspaceReaperConfig } from "../config/index.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import type { SecretStore } from "../contracts/secretStore.js";
import { StaticRunnerAllocator } from "../allocators/staticRunnerAllocator.js";
import { parseSshPort, resolveBootedAllocatorKind } from "../allocators/buildAllocator.js";
import { PgRunnerStore } from "../allocators/runnerStore.js";
import { RunWorkspaceReaper, type ActiveRunIdSource } from "./runWorkspaceReaper.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("run-workspace-reaper");
// Re-exported (as a type) so the worker boot imports the reaper TYPE and its starter
// from a SINGLE module — keeping boot.ts under its dependency-count cap.
export type { RunWorkspaceReaper } from "./runWorkspaceReaper.js";

export interface BuildRunWorkspaceReaperDeps {
  pool: pg.Pool;
  secrets: SecretStore;
  ssh: CommandSubstrate;
  identitySecretRef: string;
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

/**
 * Read the CURRENTLY-ACTIVE (non-terminal) run-id set the reaper protects. This is
 * a cross-tenant SYSTEM concern — the reaper sweeps ONE shared runner across every
 * org — so it reads via the system pool (BYPASSRLS), exactly like the CiInsightsLoop's
 * `listProjects()`. The worker runs as the de-privileged `tanren_dataplane` role with
 * no cross-tenant reach, so an org-scoped client would (correctly) see zero rows.
 *
 * Active = NOT a hard terminal state. `completed`/`failed`/`cancelled` are eligible
 * for reaping (their dir is done); `queued`/`running`/`halted` are protected — a
 * `halted` run is recoverable (it can transition back to `running`) so its working
 * tree must survive.
 */
export function buildPgActiveRunIdSource(pool: pg.Pool): ActiveRunIdSource {
  return async () =>
    runWithSystemScope(pool, async (client) => {
      const result = await client.query<{ run_id: string }>(
        "SELECT run_id FROM runs WHERE status NOT IN ('completed', 'failed', 'cancelled')",
      );
      return new Set(result.rows.map((row) => row.run_id));
    });
}

/**
 * Build + start the run-sandbox reaper when the allocator is long-lived (static),
 * else return undefined (and log why). The returned handle's `stop()` is folded into
 * the worker's drain.
 */
export function startRunWorkspaceReaper(deps: BuildRunWorkspaceReaperDeps): RunWorkspaceReaper | undefined {
  // Read the allocator kind through the SAME loud parser the allocator builder
  // uses (`resolveBootedAllocatorKind`): UNSET → `sidecar`, a typo'd kind FAILS
  // LOUD here rather than silently failing the `!== "static"` compare and quietly
  // disabling the reaper (the leak this whole module exists to fix). Only `static`
  // is a single long-lived runner the reaper can sweep; see the module header.
  const allocatorKind = resolveBootedAllocatorKind();
  if (allocatorKind !== "static") {
    log.info(
      "OFF for this allocator kind — an ephemeral runner's sandbox is destroyed with its container on release " +
        "(no leak), and manual_ssh multi-host pools are a follow-up. The per-run teardown still runs for every kind.",
      { allocatorKind },
    );
    return undefined;
  }

  // Resolve the SAME long-lived SSH target the static allocator hands runs, but
  // WITHOUT claiming a runner row (the reaper is a sweep, not an allocation). The
  // resolution (a fresh TOFU host-key discovery — a live SSH handshake) is a per-tick
  // THUNK, not done here at boot: a runner that is down at boot must not block the
  // whole worker from coming up. The reaper invokes it on its first tick and caches it.
  const allocator = new StaticRunnerAllocator({
    host: env("TANREN_RUNNER_SSH_HOST") ?? "runner",
    // The SAME loud `parseSshPort` the static allocator builder uses — a malformed
    // value FAILS LOUD (never the old `Number("not-a-port")` → NaN handed straight
    // to the SSH client). UNSET → the documented default 22.
    port: parseSshPort("TANREN_RUNNER_SSH_PORT", 22),
    username: env("TANREN_RUNNER_SSH_USER") ?? "tanren",
    ...(env("TANREN_RUNNER_SSH_HOST_FINGERPRINT") !== undefined && {
      hostKeyFingerprint: env("TANREN_RUNNER_SSH_HOST_FINGERPRINT")!,
    }),
    runners: new PgRunnerStore(deps.pool),
  });

  const { retentionMs, reapIntervalMs } = resolveRunWorkspaceReaperConfig();
  const reaper = new RunWorkspaceReaper(
    {
      ssh: deps.ssh,
      resolveTarget: () => allocator.resolveTarget(deps.identitySecretRef),
      activeRunIds: buildPgActiveRunIdSource(deps.pool),
      retentionMs,
    },
    reapIntervalMs,
  );
  reaper.start();
  log.info("ON (static runner) (config: allocator.runWorkspace*)", {
    retentionMin: Math.round(retentionMs / 60_000),
    intervalMin: Math.round(reapIntervalMs / 60_000),
  });
  return reaper;
}
