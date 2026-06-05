// P3-0005: unit tests for the deterministic gate runner. They drive runGateTier
// / runGateForWhen / resolveGateConfig against a recording SSH mock (no live
// runner) and assert exit-code-driven pass/fail, short-circuit-on-failure, the
// gate.* event emission, and the default-config path.
import { describe, expect, it } from "vitest";
import { DEFAULT_CI_CONFIG, resolveCiConfig, tiersFor } from "../src/engine/ci/index.js";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import type { EventName, EventPayload } from "../src/engine/events/index.js";
import { resolveBootstrapCommand, resolveGateConfig } from "../src/engine/workflow/gate/resolveGateConfig.js";
import { runGateForWhen } from "../src/engine/workflow/gate/runGateForWhen.js";
import { runGateTier } from "../src/engine/workflow/gate/runGateTier.js";
import { advisoryStepNamesForPosture } from "../src/engine/workflow/gate/advisoryGate.js";

const target: RunnerHandle = { host: "h", port: 22, username: "u", hostKeyFingerprint: "fp" };

// Maps each command to a scripted result; unmatched commands default to exit 0.
class RecordingSsh implements CommandSubstrate {
  readonly commands: RunnerCommand[] = [];
  constructor(private readonly script: (command: string) => Partial<CommandResult> = () => ({})) {}
  async run(_target: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push(command);
    return {
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      ...this.script(command.command),
    };
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
      ssh,
      target,
      workspacePath: "/ws",
      tier: "fast",
      when: "per_iteration",
      steps: [
        { name: "lint", run: "pnpm lint" },
        { name: "test", run: "pnpm test" },
      ],
      timeoutMs: 1000,
      appendEvent,
      taskId: "task_w",
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
      ssh,
      target,
      workspacePath: "/ws",
      tier: "fast",
      when: "per_iteration",
      steps: [
        { name: "lint", run: "pnpm lint" },
        { name: "test", run: "pnpm test" },
      ],
      timeoutMs: 1000,
      appendEvent,
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
      ssh,
      target,
      workspacePath: "/ws",
      tier: "slow",
      when: "pre_audit",
      steps: [{ name: "build", run: "pnpm build" }],
      timeoutMs: 1000,
      appendEvent,
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
      ssh,
      target,
      workspacePath: "/ws",
      tier: "fast",
      when: "per_iteration",
      steps: [{ name: "lint", run: "pnpm lint" }],
      timeoutMs: 1000,
      appendEvent,
    });
    expect(result.steps[0]!.outputTail.length).toBeLessThanOrEqual(4000);
  });
});

describe("runGateTier advisory steps (lenient posture)", () => {
  it("an advisory step's failure is recorded but does NOT fail the tier; the gate keeps running + passes", async () => {
    // lint fails (advisory under lenient) but test passes (blocking). The tier
    // must still PASS, lint must NOT short-circuit test, and a gate.advisory_failed
    // warning must be emitted instead of gate.failed.
    const ssh = new RecordingSsh((c) => (c === "pnpm lint" ? { exitCode: 2, stderr: "lint boom" } : {}));
    const { events, appendEvent } = recordingEvents();
    const result = await runGateTier({
      ssh,
      target,
      workspacePath: "/ws",
      tier: "fast",
      when: "per_iteration",
      steps: [
        { name: "lint", run: "pnpm lint" },
        { name: "typecheck", run: "pnpm typecheck" },
        { name: "unit", run: "pnpm test" },
      ],
      timeoutMs: 1000,
      appendEvent,
      advisoryStepNames: new Set(["lint", "typecheck"]),
    });

    expect(result.passed).toBe(true);
    // Every step ran (lint did NOT short-circuit the rest).
    expect(ssh.commands.map((c) => c.command)).toEqual(["pnpm lint", "pnpm typecheck", "pnpm test"]);
    // The failing advisory step is recorded with passed=false, the tier still passes.
    expect(result.steps.find((s) => s.name === "lint")?.passed).toBe(false);
    expect(events.map((e) => e.eventType)).toEqual(["gate.started", "gate.advisory_failed", "gate.passed"]);
    const advisory = events.find((e) => e.eventType === "gate.advisory_failed")!.payload as {
      advisoryStep: string;
      exitCode: number | null;
    };
    expect(advisory.advisoryStep).toBe("lint");
    expect(advisory.exitCode).toBe(2);
  });

  it("a BLOCKING step's failure still fails the tier even under an advisory set", async () => {
    // build is NOT in the advisory set → its failure blocks (gate.failed), exactly
    // as strict. This is the functional-but-weak guard: build/test always block.
    const ssh = new RecordingSsh((c) => (c === "pnpm build" ? { exitCode: 1, stderr: "build broke" } : {}));
    const { events, appendEvent } = recordingEvents();
    const result = await runGateTier({
      ssh,
      target,
      workspacePath: "/ws",
      tier: "slow",
      when: "pre_audit",
      steps: [
        { name: "build", run: "pnpm build" },
        { name: "test", run: "pnpm test" },
      ],
      timeoutMs: 1000,
      appendEvent,
      advisoryStepNames: new Set(["lint", "typecheck"]),
    });

    expect(result.passed).toBe(false);
    if (result.passed) return;
    expect(result.failedStep).toBe("build");
    // build short-circuits test (blocking failure stops the tier).
    expect(ssh.commands.map((c) => c.command)).toEqual(["pnpm build"]);
    expect(events.map((e) => e.eventType)).toEqual(["gate.started", "gate.failed"]);
  });
});

describe("advisoryStepNamesForPosture", () => {
  it("lenient → {lint, typecheck} advisory; every other posture → empty", () => {
    expect([...advisoryStepNamesForPosture("lenient")].sort()).toEqual(["lint", "typecheck"]);
    expect(advisoryStepNamesForPosture("strict").size).toBe(0);
    expect(advisoryStepNamesForPosture("open").size).toBe(0);
    expect(advisoryStepNamesForPosture("audit_only").size).toBe(0);
    // An absent posture (the field is optional on the run context) → empty too.
    const absent = undefined as Parameters<typeof advisoryStepNamesForPosture>[0];
    expect(advisoryStepNamesForPosture(absent).size).toBe(0);
  });
});

describe("runGateForWhen", () => {
  it("runs every tier mapped to the lifecycle point and passes when all pass", async () => {
    const ssh = new RecordingSsh();
    const { events, appendEvent } = recordingEvents();
    const outcome = await runGateForWhen({
      ssh,
      target,
      workspacePath: "/ws",
      config: DEFAULT_CI_CONFIG,
      when: "per_iteration",
      timeoutMs: 1000,
      appendEvent,
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
      ssh,
      target,
      workspacePath: "/ws",
      config: DEFAULT_CI_CONFIG,
      when: "pre_audit",
      timeoutMs: 1000,
      appendEvent,
    });
    expect(outcome.passed).toBe(false);
    if (outcome.passed) return;
    expect(outcome.failure.tier).toBe("slow");
    expect(outcome.failure.failedStep).toBe("build");
  });

  it("emits a gate.verdict roll-up carrying the headSha + flattened steps when a head is given", async () => {
    const ssh = new RecordingSsh();
    const { events, appendEvent } = recordingEvents();
    const outcome = await runGateForWhen({
      ssh,
      target,
      workspacePath: "/ws",
      config: DEFAULT_CI_CONFIG,
      when: "per_iteration",
      timeoutMs: 1000,
      appendEvent,
      headSha: "a".repeat(40),
      policyVersion: 1,
    });
    expect(outcome.passed).toBe(true);
    const verdicts = events.filter((e) => e.eventType === "gate.verdict");
    expect(verdicts).toHaveLength(1);
    const payload = verdicts[0]!.payload as {
      headSha: string;
      passed: boolean;
      steps: Array<{ name: string }>;
      policyVersion?: number;
      initiatingActor?: { kind: string; id?: string };
      approvingActor?: unknown;
    };
    expect(payload.headSha).toBe("a".repeat(40));
    expect(payload.passed).toBe(true);
    // The fast tier's three steps are flattened onto the verdict.
    expect(payload.steps.map((s) => s.name)).toEqual(["lint", "typecheck", "unit"]);
    // AUDIT-EVIDENCE BASELINE: the verdict carries the governance policy version + the
    // initiating SERVICE actor (the gate runs autonomously — no approver, a machine
    // judgment). The merge authority's verdict is now an audit-grade governing event.
    expect(payload.policyVersion).toBe(1);
    expect(payload.initiatingActor).toEqual({ kind: "service", id: "tanren-engine" });
    expect(payload.approvingActor).toBeUndefined();
  });

  it("emits a gate.verdict with the initiating actor but NO policy version when none is threaded", async () => {
    const ssh = new RecordingSsh();
    const { events, appendEvent } = recordingEvents();
    await runGateForWhen({
      ssh,
      target,
      workspacePath: "/ws",
      config: DEFAULT_CI_CONFIG,
      when: "per_iteration",
      timeoutMs: 1000,
      appendEvent,
      headSha: "b".repeat(40),
    });
    const payload = events.find((e) => e.eventType === "gate.verdict")!.payload as {
      policyVersion?: number;
      initiatingActor?: unknown;
    };
    // No project-governance context ⇒ an HONEST absence of policy version (never a
    // fabricated 0), but the initiating actor is still recorded.
    expect(payload.policyVersion).toBeUndefined();
    expect(payload.initiatingActor).toEqual({ kind: "service", id: "tanren-engine" });
  });

  it("emits a failing gate.verdict naming the blocking tier+step", async () => {
    const ssh = new RecordingSsh((c) => (c === "pnpm build" ? { exitCode: 1 } : {}));
    const { events, appendEvent } = recordingEvents();
    const outcome = await runGateForWhen({
      ssh,
      target,
      workspacePath: "/ws",
      config: DEFAULT_CI_CONFIG,
      when: "pre_audit",
      timeoutMs: 1000,
      appendEvent,
      headSha: "b".repeat(40),
    });
    expect(outcome.passed).toBe(false);
    const verdict = events.find((e) => e.eventType === "gate.verdict")!;
    const payload = verdict.payload as { passed: boolean; failedTier?: string; failedStep?: string };
    expect(payload.passed).toBe(false);
    expect(payload.failedTier).toBe("slow");
    expect(payload.failedStep).toBe("build");
  });

  it("is a vacuous pass when no tier maps to the lifecycle point", async () => {
    const ssh = new RecordingSsh();
    const { events, appendEvent } = recordingEvents();
    // A config whose tiers map to nothing for pre_merge.
    const config = resolveCiConfig();
    const outcome = await runGateForWhen({
      ssh,
      target,
      workspacePath: "/ws",
      config: { ...config, when: { fast: ["per_iteration"], slow: ["pre_audit"] } },
      when: "pre_merge",
      timeoutMs: 1000,
      appendEvent,
    });
    expect(outcome.passed).toBe(true);
    expect(outcome.results).toHaveLength(0);
    expect(events).toHaveLength(0);
  });
});

describe("resolveGateConfig", () => {
  it("returns the documented default when .tanren/ci.yml is absent (empty stdout)", async () => {
    const ssh = new RecordingSsh(() => ({ exitCode: 0, stdout: "" }));
    const config = await resolveGateConfig({ ssh, target, workspacePath: "/ws", timeoutMs: 1000 });
    expect(config).toEqual(DEFAULT_CI_CONFIG);
    // It cat'd the repo-root config path.
    expect(ssh.commands[0]!.command).toContain("/ws/.tanren/ci.yml");
  });

  it("parses a present .tanren/ci.yml into the repo's tiers", async () => {
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
      "    - pre_audit",
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

describe("resolveBootstrapCommand", () => {
  it("uses the repo-declared bootstrap.run when .tanren/ci.yml ships one", async () => {
    const yaml = [
      "version: 1",
      "bootstrap:",
      "  run: just install",
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
      "    - pre_merge",
    ].join("\n");
    const ssh = new RecordingSsh(() => ({ exitCode: 0, stdout: yaml }));
    const command = await resolveBootstrapCommand({ ssh, target, workspacePath: "/ws", timeoutMs: 1000 });
    expect(command).toBe("just install");
    // It read the repo-root config path over SSH (no live install).
    expect(ssh.commands[0]!.command).toContain("/ws/.tanren/ci.yml");
  });

  it("returns undefined when the repo ships no .tanren/ci.yml (so the default heuristic applies)", async () => {
    const ssh = new RecordingSsh(() => ({ exitCode: 0, stdout: "" }));
    const command = await resolveBootstrapCommand({ ssh, target, workspacePath: "/ws", timeoutMs: 1000 });
    expect(command).toBeUndefined();
  });

  it("returns undefined when the config read fails (degrades to the default heuristic)", async () => {
    const ssh = new RecordingSsh(() => ({ exitCode: 1 }));
    const command = await resolveBootstrapCommand({ ssh, target, workspacePath: "/ws", timeoutMs: 1000 });
    expect(command).toBeUndefined();
  });

  it("returns undefined when a present config omits the bootstrap section", async () => {
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
      "    - pre_merge",
    ].join("\n");
    const ssh = new RecordingSsh(() => ({ exitCode: 0, stdout: yaml }));
    const command = await resolveBootstrapCommand({ ssh, target, workspacePath: "/ws", timeoutMs: 1000 });
    expect(command).toBeUndefined();
  });
});
