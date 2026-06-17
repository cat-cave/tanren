// The COMMAND SUBSTRATE seam — the backend-neutral boundary at which the
// orchestrator runs a command inside an allocated runner. This is the single
// swappable boundary every backend must satisfy: the engine never knows whether
// the command runs over SSH to a container/VM, a native-exec API (Sprites /
// Daytona), or a micro-VM (Fly Machines). It only knows it hands a
// {@link RunnerHandle} + a {@link RunnerCommand} to a `CommandSubstrate` and
// gets a {@link CommandResult} back.
//
// The handle is OPAQUE at this contract: the substrate that produced it knows
// how to reach the runner (the SSH impl's handle carries host/port/identity;
// see {@link RunnerHandle} in ./allocator.js). Engine code threads the handle
// through unchanged — it never reads transport fields off it.
//
// SSH is the ONE concrete impl today ({@link SshCommandSubstrate} in
// engine/ssh/ssh2Substrate.ts). New backends slot in as a new `CommandSubstrate`
// impl (a documented seam arm), NOT a refactor of the consumers.
import type { Failure } from "../failure.js";
import type { RunnerHandle } from "./allocator.js";

// One command to run in a runner. Backend-neutral: stdin is piped, cwd scopes the
// working directory. The substrate redacts none of this into logs — the command
// string / stdin / any materialized identity never leave the substrate impl.
//
// HANG DETECTION — the doctrine (feedback_no_timeouts_progress_based, BINDING):
// Tanren has ZERO arbitrary wall-clock kills. A working process is NEVER killed,
// regardless of total elapsed time ("10 minutes is nothing to an AI agent"). A
// command bounds itself on SIGNS OF LIFE, not duration, via the optional
// `watchdog`. The legacy `timeoutMs` is the TRANSITIONAL hard-kill path for
// un-migrated callers; the final eradication PR removes it once every site carries
// a `watchdog`. New code must pass a `watchdog`, never rely on `timeoutMs` as a
// safety budget.
export interface RunnerCommand {
  command: string;
  cwd?: string;
  stdin?: string;
  // TRANSITIONAL hard-kill budget (legacy). When no `watchdog` is supplied the SSH
  // substrate enforces this as a wall-clock `client.destroy()` — the very thing the
  // doctrine forbids for real work. Retained ONLY so un-migrated callers keep their
  // current behavior; do NOT add new reliance on it. (Also feeds the connect/handshake
  // timeout fallback, which IS legitimate — a dead handshake has no work to lose.)
  timeoutMs: number;
  // The progress-based replacement for `timeoutMs`. When present, the substrate
  // bounds the command on the ABSENCE of all signs of life (see ActivityWatchdog),
  // never on elapsed time, and NEVER kills a process that shows any activity.
  watchdog?: ActivityWatchdog;
}

// An OUT-OF-BAND liveness probe: between bursts of output, the watchdog ticks this
// to ask "is the remote work still ALIVE?" for SILENT ops (a `jj rebase` that emits
// nothing for minutes is still legitimately working). It returns `true` for ANY sign
// of life — the remote process exists AND its CPU-time advanced (read /proc/<pid>/stat
// utime+stime), and/or the workspace mtime changed. A deadlocked / zombied process
// holds CPU flat and touches nothing: that (and ONLY that) reads `false`. The probe is
// the PRIMARY liveness mechanism for silent ops; it must check actual progress signals,
// not merely "did a timer elapse".
export type LivenessProbe = () => Promise<boolean>;

// How the watchdog reacts when it observes a GENUINE absence of all signs of life
// (no output, the probe reports no liveness): SURFACE a recoverable `stalled` result
// the caller can re-drive (default — preferred over destroying possibly-recoverable
// work), or KILL the transport (a hard `client.destroy()`, only where a stalled
// connection has demonstrably nothing left to do).
export type OnQuiet = "surface" | "kill";

// The PROGRESS-BASED hang detector for one command — the doctrine's replacement for a
// wall-clock kill. It is driven by SIGNS OF LIFE, never by elapsed time:
//
//   - It RESETS on ANY activity: every stdout/stderr output chunk (the primary tick —
//     for a streaming agent like `codex --json` every telemetry line is a token/log =
//     a sign of life), AND every positive `livenessProbe` result (the primary mechanism
//     for SILENT ops). Any positive signal → reset → continue UNBOUNDED, no matter the
//     total elapsed time.
//   - It FIRES only on the GENUINE absence of ALL signals — a dead / zombied / deadlocked
//     process or a dead connection. A working process (any activity at all) is never killed.
//
// `livenessProbe` is the PRIMARY mechanism, not an afterthought: the interface takes a
// PROBE (does the work show any liveness?), NOT a duration. A bare "no output for N ms"
// gauge alone is a DISGUISED timeout (forbidden + lint-flagged). The watchdog ticks the
// probe between output; `probeIntervalMs` is the cadence of those checks (a poll INTERVAL,
// not a budget — it never accumulates toward a kill), and the kill/surface decision is made
// only when the probe ALSO reports no life. `onQuiet` defaults to `"surface"`.
export interface ActivityWatchdog {
  livenessProbe?: LivenessProbe;
  // How often to consult `livenessProbe` between output chunks (poll cadence, NOT a
  // total-duration budget — it resets the same as output does). Defaults to a modest
  // cadence in the substrate. Bless this as an interval, never a deadline.
  probeIntervalMs?: number;
  onQuiet?: OnQuiet;
}

// The outcome of one command. A substrate (transport) failure is reported
// IN-BAND via `failure` rather than thrown, so consumers branch on the result
// shape uniformly across backends. `exitCode` is the runner process's code
// (null when the command never produced one — e.g. a connection failure).
//
// `timedOut` is the LEGACY wall-clock-kill flag (the un-migrated `timeoutMs` path).
// `stalled` is the NEW progress-based flag: the watchdog observed a genuine absence of
// all signs of life and SURFACED a recoverable stall (rather than a time-based kill).
// `quietForMs` is evidence — how long since the last observed sign of life when the
// watchdog fired (diagnostic only; NOT the trigger, which is the probe verdict). The
// final eradication PR unifies `timedOut` into `stalled` once every site migrates.
export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  signal?: string;
  timedOut: boolean;
  stalled?: boolean;
  quietForMs?: number;
  failure?: Failure;
}

// THE seam. `run()` executes one command in the runner the handle addresses.
// Backend-neutral vocabulary: an SSH backend speaks ssh2, a native-exec backend
// calls its exec API — the engine sees only this method.
export interface CommandSubstrate {
  run(handle: RunnerHandle, command: RunnerCommand): Promise<CommandResult>;
}

// A no-op CommandSubstrate for unit paths that drive the workflow with fake
// writers (the command output is irrelevant to the assertion). TEST FIXTURE
// ONLY — never the live path.
export class FakeCommandSubstrate implements CommandSubstrate {
  async run(_handle: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    return {
      exitCode: 0,
      stdout: `fake command: ${command.command}`,
      stderr: "",
      timedOut: false,
    };
  }
}
