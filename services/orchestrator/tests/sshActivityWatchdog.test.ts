import { EventEmitter } from "node:events";
import type { Client, ClientChannel } from "ssh2";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { ActivityWatchdog } from "../src/engine/contracts/commandSubstrate.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { SshCommandSubstrate } from "../src/engine/ssh/index.js";

// The ActivityWatchdog is the doctrine's progress-based replacement for the wall-clock
// kill (feedback_no_timeouts_progress_based): a process making genuine PROGRESS is NEVER
// killed regardless of elapsed time; the watchdog fires ONLY when the WORK SIGNATURE is at
// a fixed point (no new output AND no workspace advance across successive checks — a wedge,
// whether dead OR busy-but-not-advancing), and SURFACES a recoverable stall by default.
// The `livenessProbe` returns the remote WORK SIGNATURE (the workspace mtime), `undefined`
// when unreachable. These tests drive the real SshCommandSubstrate against a controllable
// fake ssh2 client with fake timers so we control the probe ticks deterministically.

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU",
  identitySecretRef: "runner/run_1/identity",
};

// A controllable fake ssh2 Client + stream. `emitData` pushes an output chunk (a sign of
// life); the run resolves when the test settles it or the watchdog fires.
interface Controllable {
  client: Client & EventEmitter;
  emitStdout: (text: string) => void;
  emitClose: (exitCode: number) => void;
  state: { destroyCount: number };
}

function createControllableClient(): Controllable {
  const emitter = new EventEmitter();
  const stderr = new EventEmitter();
  const stream = Object.assign(new EventEmitter(), {
    stderr,
    end: () => stream,
  });
  const state = { destroyCount: 0 };
  const client = Object.assign(emitter, {
    connect: () => {
      queueMicrotask(() => emitter.emit("ready"));
      return client;
    },
    destroy: () => {
      state.destroyCount += 1;
      return client;
    },
    end: () => client,
    exec: (_command: string, callback: (error: Error | undefined, channel: ClientChannel) => void) => {
      // Defer so the run() promise wiring (the watchdog arm) is in place first.
      queueMicrotask(() => callback(undefined, stream as unknown as ClientChannel));
      return client;
    },
  });
  return {
    client: client as unknown as Client & EventEmitter,
    emitStdout: (text: string) => stream.emit("data", Buffer.from(text)),
    emitClose: (exitCode: number) => {
      stream.emit("exit", exitCode);
      stream.emit("close");
    },
    state,
  };
}

async function makeSubstrate(client: Client & EventEmitter): Promise<SshCommandSubstrate> {
  const secrets = new FakeSecretStore();
  await secrets.put({ ref: target.identitySecretRef, value: "private-key" });
  return new SshCommandSubstrate(secrets, { clientFactory: () => client });
}

describe("SSH activity watchdog (progress-based hang detection)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("NEVER kills for elapsed time: a long-but-ADVANCING op runs unbounded (no wall-clock kill)", async () => {
    vi.useFakeTimers();
    const c = createControllableClient();
    const substrate = await makeSubstrate(c.client);
    // A probe whose workspace signature keeps ADVANCING (a build writing files) — genuine
    // progress, must never be killed no matter the elapsed time.
    let mtime = 1_000;
    const watchdog: ActivityWatchdog = {
      livenessProbe: () => Promise.resolve(`ws:${(mtime += 1)}`),
      probeIntervalMs: 1_000,
    };

    const runPromise = substrate.run(target, { command: "jj rebase", watchdog });
    // Advance FAR beyond any prior wall-clock budget — there is NO time-based kill now.
    await vi.advanceTimersByTimeAsync(10_000);
    // Still alive: the run has not settled. Now let it finish cleanly.
    c.emitClose(0);
    const result = await runPromise;

    expect(result.exitCode).toBe(0);
    expect(result.stalled).toBeFalsy();
    expect(c.state.destroyCount).toBe(0);
  });

  it("RESETS on new output: a streaming process is never killed while it emits NEW content", async () => {
    vi.useFakeTimers();
    const c = createControllableClient();
    const substrate = await makeSubstrate(c.client);
    // A probe whose workspace signature NEVER advances (a fixed mtime) — output alone, as long
    // as it is genuinely NEW content, must keep the watchdog reset (the streaming-agent case).
    const watchdog: ActivityWatchdog = {
      livenessProbe: () => Promise.resolve("ws:1000"),
      probeIntervalMs: 1_000,
    };

    const runPromise = substrate.run(target, { command: "codex --json", watchdog });
    // Let exec/arm settle.
    await vi.advanceTimersByTimeAsync(0);
    // Emit a token line every 500ms for several probe windows; each is genuinely-new content.
    for (let i = 0; i < 10; i += 1) {
      c.emitStdout(`{"token":${i}}\n`);
      await vi.advanceTimersByTimeAsync(500);
    }
    c.emitClose(0);
    const result = await runPromise;

    expect(result.stalled).toBeFalsy();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('{"token":9}');
    expect(c.state.destroyCount).toBe(0);
  });

  it("RESETS on an ADVANCING workspace signature for a SILENT op (no output, workspace moving)", async () => {
    vi.useFakeTimers();
    const c = createControllableClient();
    const substrate = await makeSubstrate(c.client);
    let aliveChecks = 0;
    let mtime = 1_000;
    const watchdog: ActivityWatchdog = {
      // Silent op (a jj rebase) whose workspace keeps advancing (mtime climbs) — genuine
      // progress with no output. Must never be flagged.
      livenessProbe: () => {
        aliveChecks += 1;
        return Promise.resolve(`ws:${(mtime += 1)}`);
      },
      probeIntervalMs: 1_000,
    };

    const runPromise = substrate.run(target, { command: "jj rebase -r all()", watchdog });
    // Five silent probe windows, the workspace advancing each time.
    await vi.advanceTimersByTimeAsync(5_000);
    c.emitClose(0);
    const result = await runPromise;

    expect(aliveChecks).toBeGreaterThan(0);
    expect(result.stalled).toBeFalsy();
    expect(result.exitCode).toBe(0);
    expect(c.state.destroyCount).toBe(0);
  });

  it("SURFACES a recoverable stall on a DEAD process: no output, probe unreachable (default onQuiet)", async () => {
    vi.useFakeTimers();
    const c = createControllableClient();
    const substrate = await makeSubstrate(c.client);
    // No output AND the probe reports NO signal (undefined = unreachable/gone) — a
    // dead/zombied/deadlocked process. The work signature is fixed across checks.
    const watchdog: ActivityWatchdog = { livenessProbe: () => Promise.resolve(), probeIntervalMs: 1_000 };

    const runPromise = substrate.run(target, { command: "jj rebase", watchdog });
    // The work signature is established on the first check and proven non-advancing on the
    // second — signature IDENTITY, not a duration → fire.
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await runPromise;

    expect(result.stalled).toBe(true);
    // SURFACED, not a hard transport failure.
    expect(result.failure).toBeUndefined();
    expect(typeof result.quietForMs).toBe("number");
    expect(c.state.destroyCount).toBe(1);
  });

  it("SURFACES a stall on a WEDGED-BUT-BUSY process: byte-identical output forever, workspace flat", async () => {
    vi.useFakeTimers();
    const c = createControllableClient();
    const substrate = await makeSubstrate(c.client);
    // The genuine-hang gap: the process is ALIVE (its probe reaches the runner, returns a
    // signature) and BUSY (it keeps spewing output) — but it emits BYTE-IDENTICAL lines and
    // its workspace mtime never advances. No NEW distinct work. The fixed-point read over the
    // work signature must SURFACE a stall (it would otherwise run truly forever).
    const watchdog: ActivityWatchdog = {
      livenessProbe: () => Promise.resolve("ws:1000"),
      probeIntervalMs: 1_000,
    };

    const runPromise = substrate.run(target, { command: "./infinite-loop.sh", watchdog });
    await vi.advanceTimersByTimeAsync(0);
    // Spew the SAME line continuously across many probe windows — alive + busy, zero progress.
    // Without the work-signature backstop this would run TRULY FOREVER. Each chunk re-stamps
    // lastActivityAt (so a bare liveness watchdog reads "alive"), but the output TAIL never
    // changes and the workspace signature is flat → the work signature is a fixed point.
    for (let i = 0; i < 12; i += 1) {
      c.emitStdout("Retrying... still working\n");
      await vi.advanceTimersByTimeAsync(1_000);
    }
    const result = await runPromise;

    expect(result.stalled).toBe(true);
    expect(result.failure).toBeUndefined();
    expect(c.state.destroyCount).toBe(1);
  });

  it("KILLS with an in-band failure when onQuiet is 'kill' and the work signature is fixed", async () => {
    vi.useFakeTimers();
    const c = createControllableClient();
    const substrate = await makeSubstrate(c.client);
    const watchdog: ActivityWatchdog = {
      livenessProbe: () => Promise.resolve(),
      probeIntervalMs: 1_000,
      onQuiet: "kill",
    };

    const runPromise = substrate.run(target, { command: "jj rebase", watchdog });
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await runPromise;

    expect(result.stalled).toBe(true);
    expect(result.failure?.kind).toBe("ssh_failed");
    expect(result.failure?.message).toContain("no sign of life");
    expect(c.state.destroyCount).toBe(1);
  });
});
