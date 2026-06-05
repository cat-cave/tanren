// RUN-SANDBOX REAPER (layer 2 of the ≈204 GB disk-leak fix). Per-run teardown
// (layer 1, in the run's `finally`) is the primary path, but it is NOT sufficient
// on its own: the orchestrator can crash mid-run and never reach that `finally` —
// which is exactly what happened in the incident (a long-lived runner accumulated
// ~2054 stale `/workspace/runs/<runId>` dirs ≈204 GB, filled the disk, and took
// down the whole stack, crashing the orchestrator itself). This periodic loop is
// the safety net: it sweeps the long-lived runner's `/workspace/runs/*` and removes
// any dir whose run has ENDED and is OLDER than the retention window.
//
// Shape: modeled on the AuditSchedulerLoop / CiInsightsLoop — start()/stop()/tick(),
// an `unref()`'d timer, tolerant of a per-tick AND a per-dir error (one bad `rm`
// never stalls the rest of the sweep; one bad tick never stops the loop). It runs
// ONLY where the runner is STATIC / long-lived (the boot wires it only for a
// reuse-kind allocator) — an ephemeral runner's sandbox dies with its container on
// release, so there is nothing to reap there.
//
// SAFETY INVARIANTS (non-negotiable):
//   - PROTECT ACTIVE RUNS ABSOLUTELY. A dir whose runId is in the currently-active
//     set (a non-terminal run in the DB) is NEVER removed, regardless of age — it is
//     a live execution's working tree.
//   - PROTECT MALFORMED ENTRIES. Any `/workspace/runs/*` entry that does not match
//     the safe `run_*` pattern is SKIPPED, never deleted — the reaper refuses to
//     `rm -rf` an arbitrary path it cannot prove is a run dir.
//   - Only a dir OLDER than the retention window AND with a non-active runId AND a
//     safe `run_*` name is removed.

import type { RunnerHandle } from "../contracts/allocator.js";
import type { CommandResult, CommandSubstrate } from "../contracts/commandSubstrate.js";
import { quoteSshShellArg } from "../ssh/command.js";
import { removeRunWorkspaceDir, safeRunIdPattern, WORKSPACE_RUNS_ROOT } from "../workspace/index.js";

/** Time budget for the directory listing command (a cheap `find`). */
const LIST_TIMEOUT_MS = 30_000;

/** One `/workspace/runs/*` entry: its run-id basename + its mtime (epoch ms). */
export interface RunWorkspaceDirEntry {
  runId: string;
  mtimeMs: number;
}

/**
 * Resolves the set of CURRENTLY-ACTIVE run ids (runs in a non-terminal state). The
 * reaper protects every dir in this set absolutely. A cross-tenant SYSTEM concern
 * (the reaper sweeps one shared runner across all orgs), so the live impl reads via
 * the system pool — see {@link buildPgActiveRunIdSource}.
 */
export type ActiveRunIdSource = () => Promise<Set<string>>;

export interface RunWorkspaceReaperDeps {
  ssh: CommandSubstrate;
  /**
   * Resolve the SSH handle to the long-lived runner the reaper sweeps. A THUNK, not a
   * pre-resolved handle, so the boot never BLOCKS on an unreachable runner: the static
   * target's host-key TOFU discovery is a live SSH handshake, and a runner that is down
   * at boot must not hang the whole worker. The thunk is invoked per tick (the first
   * success is cached); a failure is a tolerated skipped tick that retries.
   */
  resolveTarget: () => Promise<RunnerHandle>;
  /** The currently-active (non-terminal) run-id set; protected absolutely. */
  activeRunIds: ActiveRunIdSource;
  /** Dirs older than this (ms) are eligible for removal (if non-active + safe-named). */
  retentionMs: number;
  now?: () => number;
}

/**
 * The recurring run-sandbox reaper. `start()` ticks on `reapIntervalMs`; each tick
 * lists `/workspace/runs/*`, reads the active-run set, and removes every dir that is
 * (a) older than the retention window, (b) NOT an active run, and (c) safe-named.
 * Idempotent: a second tick over the same listing removes nothing new (the prior
 * tick already deleted the stale dirs; the active + too-young ones are still kept).
 */
export class RunWorkspaceReaper {
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private ticking = false;
  private readonly now: () => number;
  // The resolved long-lived runner handle, cached after the first successful
  // resolution (the static target is fixed for the process lifetime).
  private cachedTarget: RunnerHandle | undefined;

  constructor(
    private readonly deps: RunWorkspaceReaperDeps,
    private readonly reapIntervalMs: number,
  ) {
    this.now = deps.now ?? (() => Date.now());
  }

  start(): void {
    if (this.timer !== undefined) return;
    // Unlike the audit/CI-insights loops, we DON'T fire an immediate tick at boot:
    // the first tick resolves the runner target via a live SSH host-key handshake,
    // and a runner that is down at boot would leave an in-flight connection holding
    // the process. The first sweep runs after one interval (the timer is `unref()`'d
    // so it never keeps the process alive on its own) — a stale dir is at most one
    // sweep-interval old before it is reaped, which is well within the retention grace.
    this.timer = setInterval(() => void this.tick(), this.reapIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Run one sweep. Returns the run-ids removed this pass (tests assert on it). */
  async tick(): Promise<string[]> {
    if (this.ticking || this.stopped) return [];
    this.ticking = true;
    try {
      // Resolve the long-lived runner handle (TOFU host-key discovery for the static
      // runner). A failure (runner down at boot) is a tolerated skipped tick — never a
      // throw that stalls the loop, and never a boot-time block. Cached after success.
      let target: RunnerHandle;
      try {
        target = await this.resolveTargetCached();
      } catch (error) {
        console.error("[run-workspace-reaper] failed to resolve runner target (will retry next tick):", error);
        return [];
      }
      // A failure to LIST (the runner unreachable, the dir absent at boot) is logged,
      // never thrown — the next tick retries. Same shape as the audit scheduler's
      // list-failure tolerance.
      let entries: RunWorkspaceDirEntry[];
      try {
        entries = await this.listRunDirs(target);
      } catch (error) {
        console.error("[run-workspace-reaper] failed to list run dirs (will retry next tick):", error);
        return [];
      }
      // The active-set read failing is a HARD skip for this tick (not a degrade to
      // "delete everything"): without it we cannot prove a dir is inactive, and the
      // active-run protection is absolute. Log + bail; the next tick retries.
      let active: Set<string>;
      try {
        active = await this.deps.activeRunIds();
      } catch (error) {
        console.error("[run-workspace-reaper] failed to read active run set (skipping sweep this tick):", error);
        return [];
      }
      const cutoff = this.now() - this.deps.retentionMs;
      const removed: string[] = [];
      for (const entry of entries) {
        if (this.stopped) break;
        // SAFETY: refuse to touch any entry that is not a safe `run_*` dir.
        if (!safeRunIdPattern.test(entry.runId)) {
          console.warn(`[run-workspace-reaper] skipping non-run entry (never deleted): ${entry.runId}`);
          continue;
        }
        // SAFETY: an active run's dir is its live working tree — protected absolutely.
        if (active.has(entry.runId)) continue;
        // Retention grace: a recently-ended run's dir is left for the next sweep.
        if (entry.mtimeMs > cutoff) continue;
        // Per-dir tolerance: a failed `rm` on ONE dir is logged and the sweep
        // continues — never stalls the rest. (removeRunWorkspaceDir never throws.)
        const result = await removeRunWorkspaceDir(this.deps.ssh, target, entry.runId);
        if (result.removed) {
          removed.push(entry.runId);
        } else {
          console.warn(
            `[run-workspace-reaper] failed to remove stale dir ${entry.runId} (will retry next tick): ${result.reason ?? "unknown"}`,
          );
        }
      }
      if (removed.length > 0) {
        console.log(`[run-workspace-reaper] removed ${removed.length} stale run dir(s)`);
      }
      return removed;
    } finally {
      this.ticking = false;
    }
  }

  /** Resolve the runner handle once, caching the first success. */
  private async resolveTargetCached(): Promise<RunnerHandle> {
    if (this.cachedTarget === undefined) {
      this.cachedTarget = await this.deps.resolveTarget();
    }
    return this.cachedTarget;
  }

  /**
   * List the immediate `/workspace/runs/*` directories with their mtime. Uses a
   * single `find` printing `<basename>\t<mtime-epoch-seconds>` per dir — robust to
   * spaces/odd names (parsing `ls -l` is fragile). A missing root is a clean empty
   * listing (the `2>/dev/null` + exit-0 path), not a failure.
   */
  private async listRunDirs(target: RunnerHandle): Promise<RunWorkspaceDirEntry[]> {
    const root = quoteSshShellArg(WORKSPACE_RUNS_ROOT);
    const result = await this.deps.ssh.run(target, {
      // -mindepth/-maxdepth 1 → only the direct children; -type d → dirs only;
      // %f = basename, %T@ = mtime as epoch seconds (with a fractional part).
      command: `find ${root} -mindepth 1 -maxdepth 1 -type d -printf '%f\\t%T@\\n' 2>/dev/null || true`,
      timeoutMs: LIST_TIMEOUT_MS,
    });
    if (result.failure !== undefined || result.timedOut || result.exitCode !== 0) {
      throw new Error(`run-dir listing failed: ${listFailureDetail(result)}`);
    }
    return parseRunDirListing(result.stdout);
  }
}

/** A non-secret one-line summary of why the dir listing failed (runId/exit detail only). */
function listFailureDetail(result: CommandResult): string {
  if (result.failure !== undefined) {
    // The Failure union carries `message` everywhere except `cancelled` (which carries `reason`).
    return "message" in result.failure ? result.failure.message : result.failure.reason;
  }
  if (result.timedOut) {
    return "timed out";
  }
  return `exit ${result.exitCode ?? "unknown"}`;
}

/**
 * Parse the `find -printf '%f\t%T@\n'` listing into entries. Each line is
 * `<basename>\t<mtime-epoch-seconds>`; the epoch is converted to ms. Malformed /
 * unparseable lines are dropped (the per-entry safety guard in the tick still
 * refuses to delete any non-`run_*` name regardless). Exported for unit tests.
 */
export function parseRunDirListing(stdout: string): RunWorkspaceDirEntry[] {
  const entries: RunWorkspaceDirEntry[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trimEnd();
    if (line === "") continue;
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const runId = line.slice(0, tab);
    const epochSeconds = Number.parseFloat(line.slice(tab + 1));
    if (runId === "" || !Number.isFinite(epochSeconds)) continue;
    entries.push({ runId, mtimeMs: Math.floor(epochSeconds * 1000) });
  }
  return entries;
}
