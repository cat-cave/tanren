// Runner run-sandbox TEARDOWN — the primitive that removes a run's
// `/workspace/runs/<runId>` dir on the runner over SSH. This is layer 1 of the
// disk-leak fix: a real incident accumulated ~2054 stale run dirs (≈204 GB) on a
// long-lived runner because NOTHING removed a run's sandbox when the run ended —
// the disk filled and took down the whole stack (it even crashed the
// orchestrator). Each run dir holds a full repo clone + node_modules + build
// output, so they are large and they never went away.
//
// On an EPHEMERAL runner the container (and its `/workspace` volume) is destroyed
// on release, so the sandbox dies with it — no leak there. The leak is the STATIC
// / long-lived reused runner, whose `/workspace` survives every run. This teardown
// removes the run's dir BEFORE the runner is released, so the long-lived case is
// reclaimed inline (and the periodic reaper, layer 2, is the safety net for the
// crash-mid-run case where this never runs).
//
// SAFETY: the path is derived through `workspaceRunDirForRun`, whose
// `safeRunIdPattern` guard refuses to build a path for a malformed run id — so an
// unsafe id THROWS here rather than producing an `rm -rf`-able arbitrary path. The
// `rm -rf` is the same idiom the workspace bootstrap + `liveAccept` use (quoted via
// `quoteSshShellArg`).

import type { RunnerHandle } from "../contracts/allocator.js";
import type { CommandResult, CommandSubstrate } from "../contracts/commandSubstrate.js";
import { quoteSshShellArg } from "../ssh/command.js";
import { outputOnlyWatchdog } from "../ssh/activityWatchdog.js";
import { workspaceRunDirForRun } from "./paths.js";

/**
 * Remove one `/workspace/runs/<runId>` dir on the runner. Returns whether the
 * removal succeeded. NEVER throws: a failed teardown of one dir is real cost
 * (capacity), so it is reported (false) and the caller LOGS it — but it must not
 * mask the caller's own outcome (the per-run path runs this in the run's
 * `finally`, where a throw would hide the run's real error; the reaper runs it
 * per-dir, where a throw would stall the rest of the sweep). The transport already
 * reports a substrate failure in-band via `result.failure`, so a non-zero exit /
 * connection fault becomes a `false` return, not an exception.
 */
export async function removeRunWorkspaceDir(
  ssh: CommandSubstrate,
  target: RunnerHandle,
  runId: string,
): Promise<{ removed: boolean; reason?: string }> {
  // `workspaceRunDirForRun` enforces `safeRunIdPattern` — a malformed id throws
  // BEFORE any command is built, so we never `rm -rf` a path outside the safe set.
  let runDir: string;
  try {
    runDir = workspaceRunDirForRun(runId);
  } catch (error) {
    return { removed: false, reason: error instanceof Error ? error.message : String(error) };
  }
  try {
    const result = await ssh.run(target, {
      // INFRA op (`rm -rf` of a run dir): output-driven watchdog, no wall-clock kill.
      // A dead connection surfaces via the connect-establishment bound / a recoverable
      // stall — never a time-based kill of a legitimately long large-tree removal.
      command: `rm -rf ${quoteSshShellArg(runDir)}`,
      watchdog: outputOnlyWatchdog(),
    });
    if (result.failure !== undefined || result.stalled === true || result.exitCode !== 0) {
      return { removed: false, reason: removeFailureSummary(result) };
    }
    return { removed: true };
  } catch (error) {
    // A thrown transport error (the substrate is allowed to report in-band, but a
    // programmer-level throw is still possible) is swallowed into a `false` outcome
    // here — never re-raised — for the same reason the in-band failure is.
    return { removed: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function removeFailureSummary(result: CommandResult): string {
  if (result.failure !== undefined) {
    // The Failure union carries `message` on every transport/op fault except
    // `cancelled` (which carries `reason`); narrow accordingly so no secret-free
    // detail is dropped.
    return "message" in result.failure ? result.failure.message : result.failure.reason;
  }
  if (result.stalled === true) {
    return "rm stalled (no sign of life)";
  }
  const stderr = result.stderr.split("\n")[0]?.slice(0, 200);
  return `rm exited ${result.exitCode ?? "unknown"}${stderr !== undefined && stderr !== "" ? `: ${stderr}` : ""}`;
}
