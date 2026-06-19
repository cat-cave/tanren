import { Client } from "ssh2";
import type { ClientChannel, ServerHostKeyAlgorithm } from "ssh2";
import type { RunnerHandle, SshRunnerHandle } from "../contracts/allocator.js";
import { asSshRunnerHandle } from "../contracts/allocator.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type {
  ActivityWatchdog,
  RunnerCommand,
  CommandResult,
  CommandSubstrate,
} from "../contracts/commandSubstrate.js";
import { defineFailure } from "../failure.js";
import { buildSshExecCommand } from "./command.js";
import { hostKeyFingerprintMatches } from "./fingerprint.js";
import { appendWorkSignature, distinctRecentOutput, isWedgedNonAdvancing, workSignature } from "./watchdogProgress.js";

// The default cadence at which the activity watchdog consults its `livenessProbe`
// between output chunks. A poll INTERVAL (how often to ask "is it alive?"), NOT a
// total-duration budget — every tick that finds life RESETS, so it never accumulates
// toward a kill.
const DEFAULT_PROBE_INTERVAL_MS = 5_000;

// The default connect-ESTABLISHMENT bound (TCP connect + SSH handshake/auth) applied
// when a command supplies no `connectTimeoutMs`. This is the ONE legitimate time
// bound the substrate keeps: a connection that never establishes has no running work
// to lose. It bounds ONLY the handshake — once the channel is up the command runs
// UNBOUNDED, governed solely by the activity watchdog.
const DEFAULT_CONNECT_ESTABLISH_MS = 30_000;

type Ssh2Client = Pick<Client, "connect" | "destroy" | "end" | "exec" | "once" | "on">;
type Ssh2ClientFactory = () => Ssh2Client;

export interface SshCommandSubstrateOptions {
  clientFactory?: Ssh2ClientFactory;
  connectTimeoutMs?: number;
  serverHostKeyAlgorithms?: ServerHostKeyAlgorithm[];
}

interface RunState {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal?: string;
  settled: boolean;
  // Activity-watchdog state (the SOLE hang-detection path — there is no wall-clock
  // kill timer). `probeTimer` is the recurring work-signature poll tick. `lastActivityAt`
  // marks the most recent OUTPUT chunk (diagnostic only — feeds the `quietForMs` evidence);
  // `lastProbeTickAt` is when the watchdog last evaluated. `workSignatures` is the trailing
  // sequence of WORK SIGNATURES (output tail folded with the workspace signature) the
  // PROGRESS backstop reasons over via the shared convergence detector — a CHANGING signature
  // is genuine advancement (continue UNBOUNDED), a FIXED POINT is a wedge (dead OR busy-but-
  // not-advancing). None is a total-duration budget — the trigger is signature identity, not
  // elapsed time, so the command runs UNBOUNDED while its work signature advances.
  probeTimer?: NodeJS.Timeout;
  lastActivityAt: number;
  lastProbeTickAt?: number;
  workSignatures: string[];
  // How many chars of the combined stdout+stderr the LAST work-signature snapshot consumed, so
  // each tick fingerprints only the NEW distinct output since (rate-independent — see
  // distinctRecentOutput). Advances every tick the snapshot is taken.
  lastSnapshotOutputLen: number;
}

export class SshCommandSubstrate implements CommandSubstrate {
  private readonly clientFactory: Ssh2ClientFactory;

  constructor(
    private readonly secrets: SecretStore,
    private readonly options: SshCommandSubstrateOptions = {},
  ) {
    this.clientFactory = options.clientFactory ?? (() => new Client());
  }

  async run(handle: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    // The CommandSubstrate contract surface is the OPAQUE RunnerHandle; the SSH
    // impl narrows it to its concrete SshRunnerHandle (LOUD if a non-SSH handle is
    // ever routed here) and reads its reach fields from there.
    const target = asSshRunnerHandle(handle);
    const identity = await this.secrets.get(target.identitySecretRef);
    if (identity === undefined) {
      return this.failureResult(target, `missing SSH identity secret: ${target.identitySecretRef}`);
    }

    let execCommand: string;
    try {
      execCommand = buildSshExecCommand(command);
    } catch (error) {
      return this.failureResult(target, messageFromError(error));
    }

    return await this.runClient(target, command, identity.value, execCommand);
  }

  private async runClient(
    target: SshRunnerHandle,
    command: RunnerCommand,
    privateKey: string,
    execCommand: string,
  ): Promise<CommandResult> {
    return await new Promise<CommandResult>((resolve) => {
      const client = this.clientFactory();
      const state: RunState = {
        stdout: "",
        stderr: "",
        exitCode: null,
        settled: false,
        lastActivityAt: Date.now(),
        workSignatures: [],
        lastSnapshotOutputLen: 0,
      };
      let hostKeyFailure: string | undefined;

      // The watchdog is the SOLE hang detector — every command runs one. When the
      // caller supplies none, a default OUTPUT-DRIVEN watchdog (no probe) governs: it
      // still never kills for elapsed time, only surfaces a recoverable stall on a
      // genuine silent death. Callers wanting a silent-op liveness probe build their
      // watchdog via the shared `buildActivityWatchdog` factory.
      const watchdog: ActivityWatchdog = command.watchdog ?? { onQuiet: "surface" };

      const settle = (result: CommandResult, close: "end" | "destroy" = "end"): void => {
        if (state.settled) {
          return;
        }
        state.settled = true;
        if (state.probeTimer !== undefined) {
          clearInterval(state.probeTimer);
        }
        if (close === "destroy") {
          client.destroy();
        } else {
          client.end();
        }
        resolve(result);
      };

      const fail = (message: string): void => {
        settle(
          {
            ...this.failureResult(target, message),
            stdout: state.stdout,
            stderr: state.stderr,
          },
          "destroy",
        );
      };

      client.once("ready", () => {
        client.exec(execCommand, (error, stream) => {
          if (error !== undefined) {
            fail(messageFromError(error));
            return;
          }
          this.collectStream(
            stream,
            state,
            (channelError) => fail(messageFromError(channelError)),
            () => {
              settle({
                exitCode: state.exitCode,
                stdout: state.stdout,
                stderr: state.stderr,
                signal: state.signal,
              });
            },
          );
          // The watchdog arms only AFTER the channel is up (the connect-establishment
          // bound governs the handshake; the watchdog governs the running command).
          this.armActivityWatchdog(target, state, watchdog, client, resolve);
          if (command.stdin !== undefined) {
            stream.end(command.stdin);
          }
        });
      });
      // PERSISTENT listener (`.on`, not `.once`): ssh2 emits "error" AGAIN during
      // teardown after a pre-handshake connection loss (e.g. "Connection lost
      // before handshake" then a second protocol error once `client.destroy()`
      // runs in settle()). With `.once` that second emission has no listener and
      // Node's EventEmitter throws an unhandled "error" → the whole control plane
      // exits(1) on a single transient SSH blip. The `state.settled` guard makes a
      // repeat invocation a harmless no-op, so we keep listening and swallow it.
      // A long-lived listener on a destroyed client is fine — it is GC'd with the
      // client when this run's promise settles.
      client.on("error", (error: Error) => fail(hostKeyFailure ?? messageFromError(error)));
      const connectMs = this.options.connectTimeoutMs ?? command.connectTimeoutMs ?? DEFAULT_CONNECT_ESTABLISH_MS;
      // The connect-ESTABLISHMENT timeout (handshake only): a connection that never
      // comes up has no running work to lose. This is the ONE legitimate time bound;
      // it governs ONLY the handshake — once the channel is up the command runs
      // UNBOUNDED, governed solely by the ActivityWatchdog (progress-based).
      // NOTE: we deliberately omit ssh2's `timeout` connect-config option. In ssh2
      // 1.17.0, `timeout` is forwarded to the underlying socket as a connection-
      // LIFETIME idle timeout (socket.setTimeout) — NOT a handshake-only bound. A
      // codex command with >30s reasoning gaps (no stdout) would fire the ssh2
      // 'timeout' event mid-run and kill a still-alive command, which is a disguised
      // wall-clock deadline (the whole class eradicated in #609–#622). `readyTimeout`
      // is the correct handshake-only bound and is all we need here.
      // Keepalive detects a genuinely DEAD TCP connection (the legitimate concern the
      // socket idle-timeout was crudely serving) without killing a working-but-silent
      // command. The runner sshd sets ClientAliveInterval 60 / ClientAliveCountMax
      // 1440; we mirror that posture — probes every 15s, declare dead only after 1440
      // unanswered probes (~6 hours of silence on a dead socket, never a live one).
      client.once("timeout", () => fail(`SSH connection failed to establish within ${connectMs}ms`));
      client.connect({
        host: target.host,
        port: target.port,
        username: target.username,
        privateKey,
        authHandler: ["publickey"],
        hostHash: "sha256",
        hostVerifier: (fingerprint: string) => {
          const matches = hostKeyFingerprintMatches(fingerprint, target.hostKeyFingerprint);
          if (!matches) {
            hostKeyFailure = `SSH host key fingerprint mismatch for ${formatTarget(target)}`;
          }
          return matches;
        },
        readyTimeout: connectMs,
        keepaliveInterval: 15_000,
        keepaliveCountMax: 1440,
        algorithms:
          this.options.serverHostKeyAlgorithms === undefined
            ? undefined
            : { serverHostKey: this.options.serverHostKeyAlgorithms },
      });
    });
  }

  private collectStream(
    stream: ClientChannel,
    state: RunState,
    onError: (error: unknown) => void,
    onClose: () => void,
  ): void {
    // Accumulate output into the state (the watchdog folds the recent output TAIL into its
    // WORK SIGNATURE each tick — NEW distinct output advances the signature = progress). Stamp
    // `lastActivityAt` as the last-output time: diagnostic evidence for `quietForMs`, not the
    // progress trigger (which is the work-signature advancement read in tickWatchdog).
    const markActivity = (): void => {
      state.lastActivityAt = Date.now();
    };
    stream.on("data", (chunk: Buffer) => {
      state.stdout += chunk.toString("utf8");
      markActivity();
    });
    stream.stderr.on("data", (chunk: Buffer) => {
      state.stderr += chunk.toString("utf8");
      markActivity();
    });
    stream.on("error", onError);
    stream.stderr.on("error", onError);
    stream.once("exit", (code: number | null, signal?: string) => {
      state.exitCode = code;
      state.signal = signal;
    });
    stream.once("close", onClose);
  }

  // Arm the PROGRESS-BASED activity watchdog (the doctrine's wall-clock-kill replacement).
  // It does NOT count toward any total-duration budget. On a recurring poll CADENCE it
  // snapshots a WORK SIGNATURE of the exec — the recent OUTPUT TAIL folded with the remote
  // WORKSPACE signature the `livenessProbe` reads (for SILENT ops like a long `jj rebase` the
  // probe IS the signal: the newest workspace mtime, which advances as files are written) —
  // and feeds the SEQUENCE into the shared convergence detector. A CHANGING signature (new
  // distinct output OR an advancing workspace) is genuine progress → RESET → continue
  // UNBOUNDED. Output chunks ALSO short-circuit a tick (see collectStream + the fast path
  // below). The watchdog fires ONLY when the work signature is at a FIXED POINT across
  // successive checks — no new output AND no workspace advance — which covers BOTH a
  // dead/zombied/deadlocked process AND a WEDGED-BUT-BUSY one (an infinite loop emitting
  // byte-identical output, a CPU-burn touching nothing). Even then it SURFACES a recoverable
  // `stalled` result by default (never destroying possibly-recoverable work) unless
  // `onQuiet: "kill"`. A genuinely-advancing process is never killed regardless of elapsed time.
  private armActivityWatchdog(
    target: SshRunnerHandle,
    state: RunState,
    watchdog: ActivityWatchdog,
    client: Ssh2Client,
    resolve: (result: CommandResult) => void,
  ): void {
    const onQuiet = watchdog.onQuiet ?? "surface";
    // Baseline the tick window at arm time so the first tick can tell whether output arrived since.
    state.lastProbeTickAt = Date.now();
    // The probe poll cadence (an INTERVAL, not a deadline — it resets on every sign of life).
    const intervalMs = watchdog.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
    state.probeTimer = setInterval(() => {
      void this.tickWatchdog(target, state, watchdog, onQuiet, client, resolve);
    }, intervalMs);
    // Do not hold the event loop open on the probe tick alone.
    state.probeTimer.unref?.();
  }

  private async tickWatchdog(
    target: SshRunnerHandle,
    state: RunState,
    watchdog: ActivityWatchdog,
    onQuiet: "surface" | "kill",
    client: Ssh2Client,
    resolve: (result: CommandResult) => void,
  ): Promise<void> {
    if (state.settled) {
      return;
    }
    state.lastProbeTickAt = Date.now();
    // PROGRESS backstop: snapshot a WORK SIGNATURE — the NEW DISTINCT OUTPUT since the prior
    // snapshot (rate-independent — see distinctRecentOutput) folded with the remote WORKSPACE
    // signature the probe reads — and feed the SEQUENCE into the shared convergence detector.
    // The output content folded INTO the signature is what distinguishes a streaming process
    // (new distinct lines = an advancing signature) from a wedged-busy one (byte-identical
    // output = a fixed signature, however fast it repeats); for SILENT ops the probe IS the
    // signal (the newest workspace mtime). The probe returns `undefined` when the runner is
    // UNREACHABLE (no signal — folded as a fixed sentinel, so a dead process reads non-advancing).
    let workspaceSig: string | undefined;
    if (watchdog.livenessProbe !== undefined) {
      try {
        workspaceSig = await watchdog.livenessProbe();
      } catch {
        // A probe that THREW reached no signal — workspaceSig stays its declared default (the
        // unreachable sentinel), exactly as a probe that returned undefined: non-advancing.
      }
      if (state.settled) {
        return;
      }
    }
    const recent = distinctRecentOutput(state.stdout + state.stderr, state.lastSnapshotOutputLen);
    state.lastSnapshotOutputLen = recent.length;
    const signature = workSignature(recent.content, workspaceSig);
    state.workSignatures = appendWorkSignature(state.workSignatures, signature);
    // The verdict turns ENTIRELY on whether the WORK SIGNATURE is ADVANCING. A CHANGING
    // signature (new distinct output OR an advancing workspace) is genuine progress → continue
    // UNBOUNDED, no matter the elapsed time. A FIXED POINT (no new distinct output AND no
    // workspace advance across successive checks) is a WEDGE — dead/zombied OR busy-but-not-
    // advancing (an infinite loop spewing identical lines / a CPU-burn touching nothing) — and
    // surfaces a stall. The decision is signature IDENTITY, never a duration.
    if (!isWedgedNonAdvancing(state.workSignatures)) {
      return;
    }
    // The work signature is at a fixed point: no NEW distinct work across the checks.
    // `quietForMs` is EVIDENCE of how long since the last output — diagnostic only; the trigger
    // is the non-advancing work signature, never a fixed quiet duration on its own.
    const quietForMs = Date.now() - state.lastActivityAt;
    this.fireWatchdog(target, state, onQuiet, quietForMs, client, resolve);
  }

  // The watchdog fired on a genuine absence of all signals. SURFACE a recoverable `stalled`
  // result (default — the caller re-drives) or KILL the transport (`onQuiet: "kill"`).
  private fireWatchdog(
    target: SshRunnerHandle,
    state: RunState,
    onQuiet: "surface" | "kill",
    quietForMs: number,
    client: Ssh2Client,
    resolve: (result: CommandResult) => void,
  ): void {
    if (state.settled) {
      return;
    }
    state.settled = true;
    if (state.probeTimer !== undefined) {
      clearInterval(state.probeTimer);
    }
    client.destroy();
    if (onQuiet === "surface") {
      resolve({
        exitCode: null,
        stdout: state.stdout,
        stderr: state.stderr,
        signal: state.signal,
        stalled: true,
        quietForMs,
      });
      return;
    }
    resolve({
      ...this.failureResult(target, "SSH command showed no sign of life (dead/zombied/deadlocked) and was terminated"),
      stdout: state.stdout,
      stderr: state.stderr,
      stalled: true,
      quietForMs,
    });
  }

  private failureResult(target: SshRunnerHandle, message: string): CommandResult {
    return {
      exitCode: null,
      stdout: "",
      stderr: "",
      failure: defineFailure({ kind: "ssh_failed", target: formatTarget(target), message }),
    };
  }
}

function formatTarget(target: SshRunnerHandle): string {
  return `${target.username}@${target.host}:${target.port}`;
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
