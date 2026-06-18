import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../src/engine/contracts/commandSubstrate.js";
import { buildActivityWatchdog, outputOnlyWatchdog } from "../src/engine/ssh/activityWatchdog.js";

// The shared `buildActivityWatchdog` factory is the SOLE constructor of the per-call
// ActivityWatchdog (feedback_no_timeouts_progress_based): every class is UNBOUNDED in
// time and resets on any sign of life. The agent/vcs classes attach a workspace-mtime
// liveness probe (a build/jj writes files as it works → the newest mtime advancing is
// genuine progress); the infra class is output-driven only. None is a wall-clock kill.

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU",
  identitySecretRef: "runner/run_1/identity",
};

// A scripted substrate: each `run` returns the next queued result. The probe's own
// `find <ws> -printf '%T@'` read is what we control to simulate workspace mtime advance.
function scriptedSubstrate(results: CommandResult[]): { substrate: CommandSubstrate; commands: RunnerCommand[] } {
  const commands: RunnerCommand[] = [];
  let i = 0;
  const substrate: CommandSubstrate = {
    async run(_handle: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
      commands.push(command);
      const next = results[i] ?? { exitCode: 0, stdout: "", stderr: "" };
      i += 1;
      return next;
    },
  };
  return { substrate, commands };
}

function probeRead(mtime: string): CommandResult {
  return { exitCode: 0, stdout: `${mtime}\n`, stderr: "" };
}

describe("buildActivityWatchdog (the shared per-call-class factory)", () => {
  it("is always UNBOUNDED in time: no class carries a duration budget, only a poll cadence", () => {
    const { substrate } = scriptedSubstrate([]);
    for (const cls of ["agent", "vcs", "infra"] as const) {
      const wd = buildActivityWatchdog({ substrate, target, cls, workspace: "/ws" });
      // The default reaction is the recoverable SURFACE, never a wall-clock kill.
      expect(wd.onQuiet).toBe("surface");
      // `probeIntervalMs` is a poll cadence, NEVER a total-duration deadline.
      expect(typeof wd.probeIntervalMs).toBe("number");
      // No field encodes an elapsed-time kill budget.
      expect(wd).not.toHaveProperty("timeoutMs");
    }
  });

  it("attaches a workspace liveness probe for the silent classes (agent/vcs) when a workspace is known", () => {
    const { substrate } = scriptedSubstrate([]);
    expect(buildActivityWatchdog({ substrate, target, cls: "agent", workspace: "/ws" }).livenessProbe).toBeDefined();
    expect(buildActivityWatchdog({ substrate, target, cls: "vcs", workspace: "/ws" }).livenessProbe).toBeDefined();
    // The infra class is output-driven only (no workspace to probe).
    expect(buildActivityWatchdog({ substrate, target, cls: "infra", workspace: "/ws" }).livenessProbe).toBeUndefined();
    // An agent/vcs class with NO workspace also has no probe (output is the only tick).
    expect(buildActivityWatchdog({ substrate, target, cls: "vcs" }).livenessProbe).toBeUndefined();
  });

  it("liveness probe reports ALIVE while the workspace mtime ADVANCES (a build/jj writing files)", async () => {
    // First tick: baseline (always alive — give the work a window to produce a touch).
    // Second tick: a LATER mtime → genuine progress → alive. Third: same again → alive.
    const { substrate } = scriptedSubstrate([probeRead("1000.0"), probeRead("1001.5"), probeRead("1003.0")]);
    const wd = buildActivityWatchdog({ substrate, target, cls: "vcs", workspace: "/ws" });
    const probe = wd.livenessProbe!;
    // Tick 1 = baseline (alive); tick 2 = mtime advanced 1000→1001.5; tick 3 = 1001.5→1003.0.
    expect(await probe()).toBe(true);
    expect(await probe()).toBe(true);
    expect(await probe()).toBe(true);
  });

  it("liveness probe reports NO LIFE when the workspace mtime is FLAT (a deadlocked/zombied op)", async () => {
    // Baseline, then the SAME mtime twice — nothing is being written → not alive.
    const { substrate } = scriptedSubstrate([probeRead("2000.0"), probeRead("2000.0"), probeRead("2000.0")]);
    const wd = buildActivityWatchdog({ substrate, target, cls: "vcs", workspace: "/ws" });
    const probe = wd.livenessProbe!;
    // Tick 1 = baseline (alive); ticks 2 and 3 = mtime flat → no life.
    expect(await probe()).toBe(true);
    expect(await probe()).toBe(false);
    expect(await probe()).toBe(false);
  });

  it("liveness probe reports NO LIFE when the probe itself cannot reach the runner (wedged side-channel)", async () => {
    // A probe whose OWN little command failed (exit !=0 / stalled) is NOT a liveness
    // signal — it reads no-life so the watchdog can surface a recoverable stall.
    const failed: CommandResult = { exitCode: 1, stdout: "", stderr: "find: cannot access" };
    const { substrate } = scriptedSubstrate([failed]);
    const wd = buildActivityWatchdog({ substrate, target, cls: "agent", workspace: "/ws" });
    expect(await wd.livenessProbe!()).toBe(false);
  });

  it("the probe's own side-channel command runs under a connect-ESTABLISHMENT bound (not a kill budget)", async () => {
    const { substrate, commands } = scriptedSubstrate([probeRead("1.0")]);
    const wd = buildActivityWatchdog({ substrate, target, cls: "vcs", workspace: "/ws" });
    await wd.livenessProbe!();
    // The mtime read carries a connectTimeoutMs (the handshake bound for the trivial
    // side-channel) and NEVER a `timeoutMs` running-command kill.
    expect(commands[0]?.connectTimeoutMs).toBeGreaterThan(0);
    expect(commands[0]).not.toHaveProperty("timeoutMs");
  });

  it("outputOnlyWatchdog is unbounded, output-driven, and surfaces (never a wall-clock kill)", () => {
    const wd = outputOnlyWatchdog();
    expect(wd.onQuiet).toBe("surface");
    expect(wd.livenessProbe).toBeUndefined();
    expect(wd).not.toHaveProperty("timeoutMs");
  });
});
