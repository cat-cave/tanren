import { EventEmitter } from "node:events";
import type { Client, ClientChannel } from "ssh2";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { ActivityWatchdog } from "../src/engine/contracts/commandSubstrate.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { SshCommandSubstrate } from "../src/engine/ssh/index.js";

// The ActivityWatchdog is the doctrine's progress-based replacement for the wall-clock
// kill (feedback_no_timeouts_progress_based): a working process is NEVER killed regardless
// of elapsed time; the watchdog fires ONLY on a genuine absence of ALL signs of life
// (no output AND a negative livenessProbe), and SURFACES a recoverable stall by default.
// These tests drive the real SshCommandSubstrate against a controllable fake ssh2 client
// with fake timers so we control the probe ticks deterministically.

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

  it("does NOT arm the legacy wall-clock kill when a watchdog is supplied (no time-based kill)", async () => {
    vi.useFakeTimers();
    const c = createControllableClient();
    const substrate = await makeSubstrate(c.client);
    // A probe that always reports life — the work is alive, must never be killed.
    const watchdog: ActivityWatchdog = { livenessProbe: () => Promise.resolve(true), probeIntervalMs: 1_000 };

    const runPromise = substrate.run(target, { command: "jj rebase", timeoutMs: 50, watchdog });
    // Advance FAR beyond the legacy timeoutMs (50ms) — with the old path this would kill.
    await vi.advanceTimersByTimeAsync(10_000);
    // Still alive: the run has not settled. Now let it finish cleanly.
    c.emitClose(0);
    const result = await runPromise;

    expect(result.exitCode).toBe(0);
    expect(result.stalled).toBeFalsy();
    expect(result.timedOut).toBe(false);
    expect(c.state.destroyCount).toBe(0);
  });

  it("RESETS on output: a streaming process is never killed while it emits (any signal)", async () => {
    vi.useFakeTimers();
    const c = createControllableClient();
    const substrate = await makeSubstrate(c.client);
    // A probe that reports NO life — but output alone must keep the watchdog reset.
    const watchdog: ActivityWatchdog = { livenessProbe: () => Promise.resolve(false), probeIntervalMs: 1_000 };

    const runPromise = substrate.run(target, { command: "codex --json", timeoutMs: 50, watchdog });
    // Let exec/arm settle.
    await vi.advanceTimersByTimeAsync(0);
    // Emit a token line every 500ms for several probe windows; each output is a sign of life.
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

  it("RESETS on a positive livenessProbe for a SILENT op (no output, but alive)", async () => {
    vi.useFakeTimers();
    const c = createControllableClient();
    const substrate = await makeSubstrate(c.client);
    let aliveChecks = 0;
    const watchdog: ActivityWatchdog = {
      // Silent op: alive for the first few probe windows, then completes.
      livenessProbe: () => {
        aliveChecks += 1;
        return Promise.resolve(true);
      },
      probeIntervalMs: 1_000,
    };

    const runPromise = substrate.run(target, { command: "jj rebase -r all()", timeoutMs: 50, watchdog });
    // Five silent probe windows, all reporting alive.
    await vi.advanceTimersByTimeAsync(5_000);
    c.emitClose(0);
    const result = await runPromise;

    expect(aliveChecks).toBeGreaterThan(0);
    expect(result.stalled).toBeFalsy();
    expect(result.exitCode).toBe(0);
    expect(c.state.destroyCount).toBe(0);
  });

  it("SURFACES a recoverable stall on a genuine absence of all signals (default onQuiet)", async () => {
    vi.useFakeTimers();
    const c = createControllableClient();
    const substrate = await makeSubstrate(c.client);
    // No output AND the probe reports no life — a dead/zombied/deadlocked process.
    const watchdog: ActivityWatchdog = { livenessProbe: () => Promise.resolve(false), probeIntervalMs: 1_000 };

    const runPromise = substrate.run(target, { command: "jj rebase", timeoutMs: 999_999, watchdog });
    // One probe tick → no output, no life → fire.
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await runPromise;

    expect(result.stalled).toBe(true);
    expect(result.timedOut).toBe(false);
    // SURFACED, not a hard transport failure.
    expect(result.failure).toBeUndefined();
    expect(typeof result.quietForMs).toBe("number");
    expect(c.state.destroyCount).toBe(1);
  });

  it("KILLS with an in-band failure when onQuiet is 'kill' and all signals are absent", async () => {
    vi.useFakeTimers();
    const c = createControllableClient();
    const substrate = await makeSubstrate(c.client);
    const watchdog: ActivityWatchdog = {
      livenessProbe: () => Promise.resolve(false),
      probeIntervalMs: 1_000,
      onQuiet: "kill",
    };

    const runPromise = substrate.run(target, { command: "jj rebase", timeoutMs: 999_999, watchdog });
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await runPromise;

    expect(result.stalled).toBe(true);
    expect(result.failure?.kind).toBe("ssh_failed");
    expect(result.failure?.message).toContain("no sign of life");
    expect(c.state.destroyCount).toBe(1);
  });
});
