import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../src/engine/contracts/commandSubstrate.js";
import { buildActivityWatchdog, outputOnlyWatchdog } from "../src/engine/ssh/activityWatchdog.js";

// The shared `buildActivityWatchdog` factory is the SOLE constructor of the per-call
// ActivityWatchdog (feedback_no_timeouts_progress_based): every class is UNBOUNDED in
// time and continues while it makes genuine PROGRESS. The agent/vcs classes attach a
// workspace STRUCTURAL liveness probe that returns the workspace SIGNATURE (the total file
// count + total byte size — NOT a single newest mtime, which a heartbeat-touched lock file
// would advance forever; the apex-v45 wedge); the substrate compares the SEQUENCE for
// advancement (a changing signature = a build/install growing the tree = progress). The infra
// class is output-driven only. None is a wall-clock kill.

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU",
  identitySecretRef: "runner/run_1/identity",
};

// A scripted substrate: each `run` returns the next queued result. The probe's own
// `find <ws> … | awk` read (the "<count> <bytes>" structural signature) is what we control.
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

// The probe runs `find … | awk` and reads back "<count> <bytes>" — the STRUCTURAL workspace
// signature (file count + total byte size). A single heartbeat-touched lock file cannot grow
// either, so this is IMMUNE to the apex-v45 lock-mtime wedge (the bare newest-mtime it replaced
// would have ticked forever). This helper scripts that two-number stdout.
function probeRead(count: number, bytes: number): CommandResult {
  return { exitCode: 0, stdout: `${count} ${bytes}\n`, stderr: "" };
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

  it("liveness probe returns a CHANGING workspace signature as the tree GROWS (a build/install writing files)", async () => {
    // Each read reports MORE files / MORE bytes → the probe returns a DISTINCT signature each
    // tick. The substrate reads a changing signature as genuine progress (a workspace being
    // written — a package unpacking, a download landing).
    const { substrate } = scriptedSubstrate([probeRead(100, 5000), probeRead(140, 9000), probeRead(180, 13000)]);
    const wd = buildActivityWatchdog({ substrate, target, cls: "vcs", workspace: "/ws" });
    const probe = wd.livenessProbe!;
    const a = await probe();
    const b = await probe();
    const c = await probe();
    expect(a).toBe("ws:100:5000");
    expect(b).toBe("ws:140:9000");
    expect(c).toBe("ws:180:13000");
    // Distinct signatures across ticks = advancement.
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("liveness probe returns the SAME signature when the tree is FLAT (a deadlocked/zombied op)", async () => {
    // The SAME count+bytes each read — nothing new is being written → an UNCHANGING signature,
    // which the substrate's work-signature read eventually flags as a non-advancing fixed point.
    const { substrate } = scriptedSubstrate([
      probeRead(2000, 9_000_000),
      probeRead(2000, 9_000_000),
      probeRead(2000, 9_000_000),
    ]);
    const wd = buildActivityWatchdog({ substrate, target, cls: "vcs", workspace: "/ws" });
    const probe = wd.livenessProbe!;
    expect(await probe()).toBe("ws:2000:9000000");
    expect(await probe()).toBe("ws:2000:9000000");
    expect(await probe()).toBe("ws:2000:9000000");
  });

  it("apex-v45: a lock-file HEARTBEAT (constant tree, only an mtime ticking) reads as a FIXED POINT", async () => {
    // The exact apex-v45 wedge: `playwright install` stalled on a download while holding
    // `.cache/ms-playwright/__dirlock`, re-touched every few seconds. The OLD probe read the
    // single newest mtime and saw it ADVANCE forever → never fired → the job wedged for hours.
    // The structural count+bytes signature is IMMUNE: re-touching one file changes NEITHER the
    // file count NOR the byte total, so successive reads of the SAME (count, bytes) — even as a
    // lock's mtime ticks underneath — yield the IDENTICAL signature → a fixed point the
    // substrate surfaces as a recoverable stall.
    // 15591 files / 805552244 bytes — the live runner's constant tree during the wedge.
    const wedged = probeRead(15591, 805552244);
    const { substrate } = scriptedSubstrate([wedged, wedged, wedged, wedged]);
    const wd = buildActivityWatchdog({ substrate, target, cls: "vcs", workspace: "/ws" });
    const probe = wd.livenessProbe!;
    const reads = [await probe(), await probe(), await probe(), await probe()];
    // Every read is byte-identical — the lock-heartbeat is invisible to a structural signature.
    expect(new Set(reads).size).toBe(1);
    expect(reads[0]).toBe("ws:15591:805552244");
  });

  it("liveness probe ADVANCES on a byte-only grow (an in-place file growing, count flat)", async () => {
    // A download landing into an existing file grows BYTES without adding a file — still genuine
    // progress. The signature folds bytes, so it advances even when the file count is flat.
    const { substrate } = scriptedSubstrate([probeRead(15591, 805552244), probeRead(15591, 805552244 + 40_000_000)]);
    const wd = buildActivityWatchdog({ substrate, target, cls: "vcs", workspace: "/ws" });
    const probe = wd.livenessProbe!;
    const a = await probe();
    const b = await probe();
    expect(a).not.toBe(b);
  });

  it("liveness probe returns UNDEFINED when the probe itself cannot reach the runner (wedged side-channel)", async () => {
    // A probe whose OWN little command failed (exit !=0 / stalled) is NOT a signal — it
    // returns undefined so the substrate folds in a fixed sentinel (a non-advancing signature)
    // and can surface a recoverable stall.
    const failed: CommandResult = { exitCode: 1, stdout: "", stderr: "find: cannot access" };
    const { substrate } = scriptedSubstrate([failed]);
    const wd = buildActivityWatchdog({ substrate, target, cls: "agent", workspace: "/ws" });
    expect(await wd.livenessProbe!()).toBeUndefined();
  });

  it("the probe's own side-channel command runs under a connect-ESTABLISHMENT bound (not a kill budget)", async () => {
    const { substrate, commands } = scriptedSubstrate([probeRead(1, 10)]);
    const wd = buildActivityWatchdog({ substrate, target, cls: "vcs", workspace: "/ws" });
    await wd.livenessProbe!();
    // The structural read carries a connectTimeoutMs (the handshake bound for the trivial
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
