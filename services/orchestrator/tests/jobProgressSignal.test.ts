import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../src/engine/contracts/commandSubstrate.js";
import { JobProgressSignal, instrumentSubstrateProgress } from "../src/engine/worker/jobProgressSignal.js";

// The JobProgressSignal is the in-process forward-motion axis the heartbeat watches
// (apex-v45): a job that bumps it (any SSH boundary) is making progress and is never
// flagged; a wedged job bumps nothing and its lease is released for the reaper. The
// substrate wrapper ticks the signal on every `ssh.run` BOUNDARY (entry + exit) so a
// genuinely-working job — even mid-multi-minute call, via the watchdog probe's own
// `ssh.run`s — always advances it.

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU",
  identitySecretRef: "runner/run_1/identity",
};

function okSubstrate(): CommandSubstrate {
  return {
    async run(_handle: RunnerHandle, _command: RunnerCommand): Promise<CommandResult> {
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}

describe("JobProgressSignal", () => {
  it("is monotonic: tick() bumps, value() reads the running count", () => {
    const signal = new JobProgressSignal();
    expect(signal.value()).toBe(0);
    signal.tick();
    signal.tick();
    expect(signal.value()).toBe(2);
  });

  it("the substrate wrapper ticks TWICE per run (entry + exit) — both boundaries are forward motion", async () => {
    const signal = new JobProgressSignal();
    const ssh = instrumentSubstrateProgress(okSubstrate(), signal);
    await ssh.run(target, { command: "git status" });
    // Entry-tick (a command issued) + exit-tick (a command resolved) = 2 units of motion.
    expect(signal.value()).toBe(2);
    await ssh.run(target, { command: "just bootstrap" });
    expect(signal.value()).toBe(4);
  });

  it("ticks the exit boundary even when the inner run THROWS (a transport fault is still motion)", async () => {
    const signal = new JobProgressSignal();
    const failing: CommandSubstrate = {
      async run(): Promise<CommandResult> {
        throw new Error("transport blip");
      },
    };
    const ssh = instrumentSubstrateProgress(failing, signal);
    await expect(ssh.run(target, { command: "git status" })).rejects.toThrow("transport blip");
    // Entry-tick + the `finally` exit-tick both fire — a resolved/failed call is forward motion.
    expect(signal.value()).toBe(2);
  });

  it("passes the handle + command through unchanged (a transparent decorator)", async () => {
    const seen: RunnerCommand[] = [];
    const inner: CommandSubstrate = {
      async run(_handle: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
        seen.push(command);
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    };
    const ssh = instrumentSubstrateProgress(inner, new JobProgressSignal());
    const result = await ssh.run(target, { command: "echo hi", cwd: "/ws" });
    expect(result.stdout).toBe("ok");
    expect(seen[0]).toEqual({ command: "echo hi", cwd: "/ws" });
  });
});
