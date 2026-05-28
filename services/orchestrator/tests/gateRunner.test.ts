// P3-0005: unit tests for the deterministic gate runner. They drive runGateTier
// / runGateForWhen / resolveGateConfig against a recording SSH mock (no live
// runner) and assert exit-code-driven pass/fail, short-circuit-on-failure, the
// gate.* event emission, and the default-config path.
import { describe, expect, it } from "vitest";
import { DEFAULT_CI_CONFIG, resolveCiConfig, tiersFor } from "../src/engine/ci/index.js";
import type { SshTarget } from "../src/engine/contracts/allocator.js";
import type { SshCommand, SshCommandResult, SshSubstrate } from "../src/engine/contracts/sshSubstrate.js";
import type { EventName, EventPayload } from "../src/engine/events/index.js";
import { resolveGateConfig } from "../src/engine/workflow/gate/resolveGateConfig.js";
import { runGateForWhen } from "../src/engine/workflow/gate/runGateForWhen.js";
import { runGateTier } from "../src/engine/workflow/gate/runGateTier.js";

const target: SshTarget = { host: "h", port: 22, username: "u", hostKeyFingerprint: "fp" };

// Maps each command to a scripted result; unmatched commands default to exit 0.
class RecordingSsh implements SshSubstrate {
  readonly commands: SshCommand[] = [];
  constructor(private readonly script: (command: string) => Partial<SshCommandResult> = () => ({})) {}
  async run(_target: SshTarget, command: SshCommand): Promise<SshCommandResult> {
    this.commands.push(command);
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...this.script(command.command) };
  }
}

function recordingEvents() {
  const events: { eventType: EventName; payload: unknown; taskId?: string }[] = [];
  const appendEvent = async <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => {
    events.push({ eventType, payload, taskId });
  };
  return { events, appendEvent };
}

describe("runGateTier", () => {
  it("passes when every step exits 0 and emits gate.started + gate.passed", async () => {
    const ssh = new RecordingSsh();
    const { events, appendEvent } = recordingEvents();
    const result = await runGateTier({
      ssh, target, workspacePath: "/ws", tier: "fast", when: "per_iteration",
      steps: [{ name: "lint", run: "pnpm lint" }, { name: "test", run: "pnpm test" }],
      timeoutMs: 1000, appendEvent, taskId: "task_w"
    });

    expect(result.passed).toBe(true);
    expect(result.steps).toHaveLength(2);
    expect(ssh.commands.map((c) => c.command)).toEqual(["pnpm lint", "pnpm test"]);
    expect(ssh.commands.every((c) => c.cwd === "/ws")).toBe(true);
    expect(events.map((e) => e.eventType)).toEqual(["gate.started", "gate.passed"]);
    expect(events.every((e) => e.taskId === "task_w")).toBe(true);
  });

  it("fails on the first nonzero step, short-circuits later steps, and emits gate.failed", async () => {
    const ssh = new RecordingSsh((c) => (c === "pnpm lint" ? { exitCode: 2, stderr: "boom" } : {}));
    const { events, appendEvent } = recordingEvents();
    const result = await runGateTier({
      ssh, target, workspacePath: "/ws", tier: "fast", when: "per_iteration",
      steps: [{ name: "lint", run: "pnpm lint" }, { name: "test", run: "pnpm test" }],
      timeoutMs: 1000, appendEvent
    });

    expect(result.passed).toBe(false);
    if (result.passed) return;
    expect(result.failedStep).toBe("lint");
    expect(result.exitCode).toBe(2);
    // The second step never ran (only the failing first command was issued).
    expect(ssh.commands.map((c) => c.command)).toEqual(["pnpm lint"]);
    expect(events.map((e) => e.eventType)).toEqual(["gate.started", "gate.failed"]);
    expect((events[1]!.payload as { failedStep: string }).failedStep).toBe("lint");
  });

  it("treats a timeout / substrate failure as a failed step", async () => {
    const ssh = new RecordingSsh(() => ({ exitCode: null, timedOut: true }));
    const { appendEvent } = recordingEvents();
    const result = await runGateTier({
      ssh, target, workspacePath: "/ws", tier: "slow", when: "pre_audit",
      steps: [{ name: "build", run: "pnpm build" }], timeoutMs: 1000, appendEvent
    });
    expect(result.passed).toBe(false);
    if (result.passed) return;
    expect(result.exitCode).toBeNull();
  });

  it("truncates a large output tail to the bound", async () => {
    const big = "x".repeat(10_000);
    const ssh = new RecordingSsh(() => ({ exitCode: 1, stdout: big }));
    const { appendEvent } = recordingEvents();
    const result = await runGateTier({
      ssh, target, workspacePath: "/ws", tier: "fast", when: "per_iteration",
      steps: [{ name: "lint", run: "pnpm lint" }], timeoutMs: 1000, appendEvent
    });
    expect(result.steps[0]!.outputTail.length).toBeLessThanOrEqual(4000);
  });
});

describe("runGateForWhen", () => {
  it("runs every tier mapped to the lifecycle point and passes when all pass", async () => {
    const ssh = new RecordingSsh();
    const { events, appendEvent } = recordingEvents();
    const outcome = await runGateForWhen({
      ssh, target, workspacePath: "/ws", config: DEFAULT_CI_CONFIG,
      when: "per_iteration", timeoutMs: 1000, appendEvent
    });
    expect(outcome.passed).toBe(true);
    // Default per_iteration maps only the fast tier.
    expect(outcome.results).toHaveLength(tiersFor(DEFAULT_CI_CONFIG, "per_iteration").length);
    expect(events.filter((e) => e.eventType === "gate.passed")).toHaveLength(1);
  });

  it("stops at the first failing tier and surfaces its failure", async () => {
    const ssh = new RecordingSsh((c) => (c === "pnpm build" ? { exitCode: 1 } : {}));
    const { appendEvent } = recordingEvents();
    const outcome = await runGateForWhen({
      ssh, target, workspacePath: "/ws", config: DEFAULT_CI_CONFIG,
      when: "pre_audit", timeoutMs: 1000, appendEvent
    });
    expect(outcome.passed).toBe(false);
    if (outcome.passed) return;
    expect(outcome.failure.tier).toBe("slow");
    expect(outcome.failure.failedStep).toBe("build");
  });

  it("is a vacuous pass when no tier maps to the lifecycle point", async () => {
    const ssh = new RecordingSsh();
    const { events, appendEvent } = recordingEvents();
    // A config whose tiers map to nothing for pre_merge.
    const config = resolveCiConfig(undefined);
    const outcome = await runGateForWhen({
      ssh, target, workspacePath: "/ws",
      config: { ...config, when: { fast: ["per_iteration"], slow: ["pre_audit"] } },
      when: "pre_merge", timeoutMs: 1000, appendEvent
    });
    expect(outcome.passed).toBe(true);
    expect(outcome.results).toHaveLength(0);
    expect(events).toHaveLength(0);
  });
});

describe("resolveGateConfig", () => {
  it("returns the documented default when tanren-ci.yml is absent (empty stdout)", async () => {
    const ssh = new RecordingSsh(() => ({ exitCode: 0, stdout: "" }));
    const config = await resolveGateConfig({ ssh, target, workspacePath: "/ws", timeoutMs: 1000 });
    expect(config).toEqual(DEFAULT_CI_CONFIG);
    // It cat'd the repo-root config path.
    expect(ssh.commands[0]!.command).toContain("/ws/tanren-ci.yml");
  });

  it("parses a present tanren-ci.yml into the repo's tiers", async () => {
    const yaml = [
      "version: 1",
      "tiers:",
      "  fast:",
      "    - name: lint",
      "      run: just lint",
      "  slow:",
      "    - name: build",
      "      run: just build",
      "when:",
      "  fast:",
      "    - per_iteration",
      "  slow:",
      "    - pre_audit"
    ].join("\n");
    const ssh = new RecordingSsh(() => ({ exitCode: 0, stdout: yaml }));
    const config = await resolveGateConfig({ ssh, target, workspacePath: "/ws", timeoutMs: 1000 });
    expect(config.tiers.fast?.[0]?.run).toBe("just lint");
    expect(tiersFor(config, "pre_audit")).toEqual(["slow"]);
  });

  it("degrades to the default when the read fails", async () => {
    const ssh = new RecordingSsh(() => ({ exitCode: 1 }));
    const config = await resolveGateConfig({ ssh, target, workspacePath: "/ws", timeoutMs: 1000 });
    expect(config).toEqual(DEFAULT_CI_CONFIG);
  });
});
