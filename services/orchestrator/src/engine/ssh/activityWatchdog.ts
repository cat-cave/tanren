// The SHARED ActivityWatchdog factory — the doctrine's wall-clock-kill replacement
// (feedback_no_timeouts_progress_based, BINDING). Tanren has ZERO arbitrary
// wall-clock kills: a process showing ANY sign of life is NEVER terminated, no
// matter the total elapsed time ("10 minutes is nothing to an AI agent"). Every
// `ssh.run` call constructs its watchdog here — per CALL CLASS — instead of
// hand-rolling one at ~30 sites.
//
// The watchdog's PRIMARY signal is the command's streamed output (the substrate
// resets the activity clock on every stdout/stderr chunk — a `codex --json` line,
// a build log line). For SILENT stretches a `livenessProbe` is consulted between
// output: it asks the runner whether the work is still ALIVE (the workspace is
// being touched / the runner is doing compute), and ANY positive answer resets the
// clock and the work continues UNBOUNDED. The watchdog FIRES only on a GENUINE
// absence of ALL signs of life — and even then SURFACES a recoverable stall (the
// caller re-drives) by default rather than destroying possibly-recoverable work.
//
// There is NO time budget here: `probeIntervalMs` is a poll CADENCE (how often to
// consult the probe between output), never a deadline — it resets on every sign of
// life and never accumulates toward a kill.
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

// What the liveness probe watches for a silent op: the WORKSPACE being touched (a
// build/jj writes files as it works) is the most robust no-PID-tracking signal. The
// probe stamps the newest mtime under the workspace each tick and reports "alive"
// when it advanced since the previous tick — genuine progress. A first tick with no
// prior baseline reads alive (give the work a tick to produce a signal). A
// deadlocked/zombied process touches nothing: its mtime holds flat → "no life".
interface WorkspaceLivenessState {
  lastMaxMtime?: number;
}

// Build the `livenessProbe` for a workspace-bound op: each tick runs a trivial
// `find <ws> -printf '%T@\n' | sort | tail` over the substrate to read the newest
// mtime under the workspace, and reports liveness when it advanced. The probe's own
// command runs under a short connect-establishment bound (PROBE_CONNECT_MS) so a
// wedged side-channel can't stall the tick — a probe that cannot reach the runner
// reads "no life" (and the watchdog surfaces a recoverable stall, never a silent
// hang). Returns undefined when there is no workspace to watch (output-only class).
function buildWorkspaceLivenessProbe(
  substrate: CommandSubstrate,
  target: RunnerHandle,
  workspace: string,
): () => Promise<boolean> {
  const state: WorkspaceLivenessState = {};
  return async (): Promise<boolean> => {
    // Newest mtime (epoch seconds, float) anywhere under the workspace. `-printf` is
    // GNU find (the runner image); the `2>/dev/null` swallows races where a file is
    // removed mid-walk (itself a sign of life). An empty read (workspace gone) yields
    // no number → treated as no advance.
    const ws = quoteSshShellArg(workspace);
    const result = await substrate.run(target, {
      command: `find ${ws} -printf '%T@\\n' 2>/dev/null | sort -n | tail -1`,
      connectTimeoutMs: PROBE_CONNECT_MS,
    });
    if (result.failure !== undefined || result.stalled === true || result.exitCode !== 0) {
      // The probe could not reach the runner / the runner is wedged: NOT a liveness
      // signal. Report no-life so the watchdog can surface a recoverable stall.
      return false;
    }
    const maxMtime = Number.parseFloat(result.stdout.trim());
    if (!Number.isFinite(maxMtime)) {
      return false;
    }
    const prev = state.lastMaxMtime;
    state.lastMaxMtime = maxMtime;
    // First tick (no baseline yet) reads alive: give the work a cadence window to
    // produce a touch before any verdict. After that, advance = genuine progress.
    if (prev === undefined) {
      return true;
    }
    return maxMtime > prev;
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
