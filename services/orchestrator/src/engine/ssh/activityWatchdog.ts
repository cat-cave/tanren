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
// remote work state (the workspace's total file COUNT + total BYTES — a build/jj
// grows the tree as it advances; deliberately NOT a single file's mtime, which a
// heartbeat-touched lock file would advance forever with no real work — apex-v45).
// The substrate feeds the SEQUENCE of work signatures into the shared
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
//     rebase, a clone, a gate suite). The probe (workspace tree GROWING — file count
//     + byte total, not a single mtime) is the PRIMARY liveness signal. Surfaces a
//     recoverable stall.
//   - "infra": a side/IO op (read of usage, a small capture). Output-driven only,
//     no probe; surfaces a stall rather than killing.
export type WatchdogClass = "agent" | "vcs" | "infra";

// What the liveness probe reads for a silent op: a STRUCTURAL SIGNATURE of the WORKSPACE
// state (a build/install/test extracts packages, downloads artifacts, writes output — the
// file COUNT and total BYTES grow as it works) is the most robust no-PID-tracking signal.
// Each tick the probe reads the workspace's total file count + total byte size and RETURNS
// the pair as the work-state signature; the substrate compares the SEQUENCE for genuine
// advancement (a growing count/bytes = forward motion, a flat count+bytes = no new work).
// A deadlocked/zombied process writes nothing new, so the pair holds flat → an unchanging
// signature → eventually a fixed point.
//
// WHY NOT THE NEWEST mtime (apex-v45 wedge): the probe USED to return the single newest
// mtime under the workspace. That conflates "a file was TOUCHED" with "the build ADVANCED"
// — and a stalled tool that holds a HEARTBEAT LOCK FILE (e.g. playwright's browser-download
// `.cache/ms-playwright/__dirlock`, re-touched every few seconds while a download is wedged)
// keeps the newest mtime advancing FOREVER with zero real progress. The probe read that as
// genuine forward motion, so the watchdog never fired and the job wedged for hours
// (run_a81f3424, the gate's `just bootstrap` → `playwright install` stalled with a constant
// 15591-file / 805552244-byte tree while one lock file's mtime ticked). The count+bytes
// signature is IMMUNE: re-touching one file changes neither, so a lock-heartbeat reads as a
// fixed point, while genuine work (a download landing, a package unpacking, an artifact
// written) grows the tree. The trigger remains signature IDENTITY, never elapsed time.

// Build the `livenessProbe` for a workspace-bound op: each tick runs a trivial
// `find <ws> -type f -printf '%s\n' | awk '{c++; s+=$1} END {print c" "s}'` over the
// substrate to read the workspace's total file count + total byte size and returns the pair
// as the work-state SIGNATURE. The probe's own command runs under a short
// connect-establishment bound (PROBE_CONNECT_MS) so a wedged side-channel can't stall the
// tick — a probe that cannot reach the runner returns `undefined` (no signal; the substrate
// folds that into a non-advancing work signature and surfaces a recoverable stall, never a
// silent hang). Returns undefined when there is no workspace to watch (output-only class).
function buildWorkspaceLivenessProbe(
  substrate: CommandSubstrate,
  target: RunnerHandle,
  workspace: string,
): () => Promise<string | undefined> {
  return async (): Promise<string | undefined> => {
    // Total file count + total byte size anywhere under the workspace. `-printf` is GNU
    // find (the runner image); `awk` folds the per-file sizes into "<count> <bytes>" (the
    // `BEGIN` init makes an empty tree print "0 0", a valid flat signature). The
    // `2>/dev/null` swallows races where a file is removed mid-walk (itself a sign of life).
    // Deliberately NOT the newest mtime — a single heartbeat-touched lock file advances mtime
    // forever with no real work (apex-v45), but cannot grow the count or the byte total.
    const ws = quoteSshShellArg(workspace);
    const result = await substrate.run(target, {
      command: `find ${ws} -type f -printf '%s\\n' 2>/dev/null | awk 'BEGIN{c=0;s=0} {c++; s+=$1} END {print c" "s}'`,
      connectTimeoutMs: PROBE_CONNECT_MS,
    });
    if (result.failure !== undefined || result.stalled === true || result.exitCode !== 0) {
      // The probe could not reach the runner / the runner is wedged: NO signal. Return
      // undefined so the substrate treats it as a non-advancing work signature.
      return undefined;
    }
    // `awk` prints "<count> <bytes>"; an unreachable/garbled read yields no two-number
    // line → no signal.
    const parts = result.stdout.trim().split(/\s+/u);
    if (parts.length !== 2) {
      return undefined;
    }
    const count = Number.parseInt(parts[0] as string, 10);
    const bytes = Number.parseInt(parts[1] as string, 10);
    if (!Number.isFinite(count) || !Number.isFinite(bytes)) {
      return undefined;
    }
    // The workspace signature IS the (count, bytes) pair: a strictly larger count OR byte
    // total across checks is an advancing workspace (genuine progress — new/growing files);
    // an unchanged pair is no new work (even if a lock file's mtime keeps ticking).
    return `ws:${count}:${bytes}`;
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
