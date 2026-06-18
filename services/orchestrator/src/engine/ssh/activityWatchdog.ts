// The SHARED ActivityWatchdog factory — the doctrine's wall-clock-kill replacement
// (feedback_no_timeouts_progress_based, BINDING). Tanren has ZERO arbitrary
// wall-clock kills: a process making genuine PROGRESS is NEVER terminated, no
// matter the total elapsed time ("10 minutes is nothing to an AI agent"). Every
// `ssh.run` call constructs its watchdog here — per CALL CLASS — instead of
// hand-rolling one at ~30 sites.
//
// The watchdog's PRIMARY signal is the command's streamed output (the substrate
// folds every stdout/stderr chunk into a WORK SIGNATURE — a `codex --json` line, a
// build log line is new distinct content = progress). For SILENT stretches a
// `livenessProbe` is consulted between output: it returns a SIGNATURE of the
// remote work state (the newest workspace mtime — a build/jj writes files as it
// advances). The substrate feeds the SEQUENCE of work signatures into the shared
// convergence detector: a CHANGING signature (new output OR an advancing workspace)
// is genuine progress → the work continues UNBOUNDED. The watchdog FIRES only when
// the work signature is at a FIXED POINT (no new output AND no workspace advance
// across successive checks) — which covers BOTH a dead/zombied/deadlocked process
// AND a WEDGED-BUT-BUSY one (an infinite loop emitting byte-identical output, a
// CPU-burn touching nothing) — and even then SURFACES a recoverable stall (the
// caller re-drives) by default rather than destroying possibly-recoverable work.
//
// There is NO time budget here: `probeIntervalMs` is a poll CADENCE (how often to
// snapshot the work signature between output), never a deadline — the trigger is
// signature IDENTITY (non-advancement), never an elapsed duration.
import type { RunnerHandle } from "../contracts/allocator.js";
import type { ActivityWatchdog, CommandSubstrate } from "../contracts/commandSubstrate.js";
import { quoteSshShellArg } from "./command.js";

// How often a watchdog consults its `livenessProbe` between output chunks. A poll
// INTERVAL (cadence), NOT a total-duration budget — every tick that finds life
// RESETS, so it never accumulates toward a kill. The substrate clamps the probe's
// own command on a short connect-establishment bound so a wedged probe can't hang
// the tick (a probe that itself cannot reach the runner reads "no life").
const PROBE_CADENCE_MS = 15_000;

// The short connect-establishment bound the liveness probe's OWN little SSH command
// runs under (a sub-second `stat`/`ps`). This is a legitimate HANDSHAKE bound on a
// trivial side-channel command — not a kill budget on the watched work — so it is
// named in the connect-establishment class the lint allowlist accepts.
const PROBE_CONNECT_MS = 20_000;

// The call CLASS a watchdog is built for. The class only selects whether a
// `livenessProbe` is attached (and which signal it reads); EVERY class is unbounded
// in time and resets on any output. Classes:
//   - "agent": an LLM agent exec (codex/claude/opencode/aider/pi/reasonix). Its
//     `--json`/stream output is continuous, so output IS the primary tick; the probe
//     is a backstop for a long silent tool call. Surfaces a recoverable stall.
//   - "vcs": a git/jj/gate SSH command that can run silently for minutes (a big
//     rebase, a clone, a gate suite). The probe (workspace touched) is the PRIMARY
//     liveness signal. Surfaces a recoverable stall.
//   - "infra": a side/IO op (read of usage, a small capture). Output-driven only,
//     no probe; surfaces a stall rather than killing.
export type WatchdogClass = "agent" | "vcs" | "infra";

// What the liveness probe reads for a silent op: a SIGNATURE of the WORKSPACE state (a
// build/jj writes files as it works) is the most robust no-PID-tracking signal. Each tick
// the probe reads the newest mtime under the workspace and RETURNS it as the work-state
// signature string; the substrate compares the SEQUENCE for genuine advancement (a changing
// mtime = forward motion, a flat mtime = no new work). A deadlocked/zombied process touches
// nothing, so its mtime holds flat → an unchanging signature → eventually a fixed point.

// Build the `livenessProbe` for a workspace-bound op: each tick runs a trivial
// `find <ws> -printf '%T@\n' | sort | tail` over the substrate to read the newest
// mtime under the workspace and returns it as the work-state SIGNATURE. The probe's own
// command runs under a short connect-establishment bound (PROBE_CONNECT_MS) so a
// wedged side-channel can't stall the tick — a probe that cannot reach the runner
// returns `undefined` (no signal; the substrate folds that into a non-advancing work
// signature and surfaces a recoverable stall, never a silent hang). Returns undefined
// when there is no workspace to watch (output-only class).
function buildWorkspaceLivenessProbe(
  substrate: CommandSubstrate,
  target: RunnerHandle,
  workspace: string,
): () => Promise<string | undefined> {
  return async (): Promise<string | undefined> => {
    // Newest mtime (epoch seconds, float) anywhere under the workspace. `-printf` is
    // GNU find (the runner image); the `2>/dev/null` swallows races where a file is
    // removed mid-walk (itself a sign of life). An empty read (workspace gone) yields
    // no number → no signal.
    const ws = quoteSshShellArg(workspace);
    const result = await substrate.run(target, {
      command: `find ${ws} -printf '%T@\\n' 2>/dev/null | sort -n | tail -1`,
      connectTimeoutMs: PROBE_CONNECT_MS,
    });
    if (result.failure !== undefined || result.stalled === true || result.exitCode !== 0) {
      // The probe could not reach the runner / the runner is wedged: NO signal. Return
      // undefined so the substrate treats it as a non-advancing work signature.
      return undefined;
    }
    const maxMtime = Number.parseFloat(result.stdout.trim());
    if (!Number.isFinite(maxMtime)) {
      return undefined;
    }
    // The workspace signature IS the newest mtime: a strictly newer value across checks is
    // an advancing workspace (genuine progress); an unchanged value is no new work.
    return `ws:${maxMtime}`;
  };
}

// Inputs a call site threads to build its watchdog. `workspace` is the runner-local
// path whose touches mean "still working" (a git/jj/build/gate op); omit it for an
// output-only class with no workspace to watch.
export interface WatchdogInput {
  substrate: CommandSubstrate;
  target: RunnerHandle;
  cls: WatchdogClass;
  workspace?: string;
}

// THE shared constructor. Returns the right `ActivityWatchdog` for the call class —
// always unbounded in time, always output-driven, with a workspace liveness probe
// attached for the silent classes (agent/vcs) when a workspace is known. Default
// reaction is "surface" (a recoverable stall the caller re-drives), NEVER a
// wall-clock kill. Callers pass the result as `RunnerCommand.watchdog`.
export function buildActivityWatchdog(input: WatchdogInput): ActivityWatchdog {
  const wantsProbe = (input.cls === "agent" || input.cls === "vcs") && input.workspace !== undefined;
  const watchdog: ActivityWatchdog = {
    probeIntervalMs: PROBE_CADENCE_MS,
    onQuiet: "surface",
  };
  if (wantsProbe) {
    watchdog.livenessProbe = buildWorkspaceLivenessProbe(input.substrate, input.target, input.workspace as string);
  }
  return watchdog;
}

// Convenience: the output-only watchdog for a call class with no workspace to probe
// (a capture, an answerer schema write, a usage read). Output remains the primary
// tick; on a genuine silent death the substrate surfaces a recoverable stall.
export function outputOnlyWatchdog(): ActivityWatchdog {
  return { probeIntervalMs: PROBE_CADENCE_MS, onQuiet: "surface" };
}
