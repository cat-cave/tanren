// Unit tests for the post-merge ACCEPT step
// (docs/roadmap/tanren-method-benchmark.md §2.1). They drive `runAcceptStep`
// against a recording SSH mock (no live runner) and assert the hidden-accept-tier
// verdict: passed → `benchmark.accept.passed`, a nonzero/timeout/empty tier →
// `benchmark.accept.failed`, short-circuit on first failure, the content-addressed
// accept-tier hash riding the event, and the bounded output tail.
import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import type { EventName, EventPayload } from "../src/engine/events/index.js";
import { runAcceptStep } from "../src/engine/benchmark/accept.js";

const target = { host: "h", port: 22, username: "u", hostKeyFingerprint: "fp" } as RunnerHandle;

class RecordingSsh implements CommandSubstrate {
  readonly commands: RunnerCommand[] = [];
  constructor(private readonly script: (command: string) => Partial<CommandResult> = () => ({})) {}
  async run(_target: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
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

const BASE = {
  acceptTierHash: "sha256:accept-frozen",
  cellId: "cell_x",
  trialIndex: 2,
  timeoutMs: 1000,
  workspacePath: "/ws",
  taskId: "task_run",
};

describe("runAcceptStep", () => {
  it("passes when every accept step exits 0 and emits benchmark.accept.passed", async () => {
    const ssh = new RecordingSsh();
    const { events, appendEvent } = recordingEvents();
    const outcome = await runAcceptStep({
      ...BASE,
      ssh,
      target,
      steps: [
        { name: "build", run: "make build" },
        { name: "e2e", run: "make accept" },
      ],
      appendEvent,
    });

    expect(outcome.result).toBe("passed");
    expect(outcome.steps).toHaveLength(2);
    expect(ssh.commands.map((c) => c.command)).toEqual(["make build", "make accept"]);
    expect(ssh.commands.every((c) => c.cwd === "/ws")).toBe(true);
    expect(events.map((e) => e.eventType)).toEqual(["benchmark.accept.passed"]);
    const payload = events[0]!.payload as EventPayload<"benchmark.accept.passed">;
    expect(payload.acceptTierHash).toBe("sha256:accept-frozen");
    expect(payload.cellId).toBe("cell_x");
    expect(payload.trialIndex).toBe(2);
    expect(payload.tier).toBe("accept");
    expect(events[0]!.taskId).toBe("task_run");
  });

  it("fails on the first nonzero step, short-circuits later steps, emits benchmark.accept.failed", async () => {
    const ssh = new RecordingSsh((c) => (c === "make accept" ? { exitCode: 1, stderr: "oracle mismatch" } : {}));
    const { events, appendEvent } = recordingEvents();
    const outcome = await runAcceptStep({
      ...BASE,
      ssh,
      target,
      steps: [
        { name: "accept", run: "make accept" },
        { name: "never", run: "echo unreached" },
      ],
      appendEvent,
    });

    expect(outcome.result).toBe("failed");
    // Short-circuited before "never".
    expect(outcome.steps).toHaveLength(1);
    expect(ssh.commands.map((c) => c.command)).toEqual(["make accept"]);
    expect(events.map((e) => e.eventType)).toEqual(["benchmark.accept.failed"]);
    const payload = events[0]!.payload as EventPayload<"benchmark.accept.failed">;
    expect(payload.failedStep).toBe("accept");
    expect(payload.exitCode).toBe(1);
    expect(payload.reason).toBeNull();
  });

  it("treats a timeout as a failed accept", async () => {
    const ssh = new RecordingSsh(() => ({ exitCode: null, timedOut: true }));
    const { events, appendEvent } = recordingEvents();
    const outcome = await runAcceptStep({
      ...BASE,
      ssh,
      target,
      steps: [{ name: "accept", run: "make accept" }],
      appendEvent,
    });
    expect(outcome.result).toBe("failed");
    expect(events.map((e) => e.eventType)).toEqual(["benchmark.accept.failed"]);
  });

  it("fails (never vacuously passes) when the accept tier has no steps", async () => {
    const ssh = new RecordingSsh();
    const { events, appendEvent } = recordingEvents();
    const outcome = await runAcceptStep({ ...BASE, ssh, target, steps: [], appendEvent });
    expect(outcome.result).toBe("failed");
    expect(ssh.commands).toHaveLength(0);
    const payload = events[0]!.payload as EventPayload<"benchmark.accept.failed">;
    expect(payload.reason).toMatch(/no steps/u);
    expect(payload.steps).toHaveLength(0);
  });

  it("bounds the captured output tail", async () => {
    const big = "x".repeat(10_000);
    const ssh = new RecordingSsh(() => ({ exitCode: 1, stdout: big }));
    const { events, appendEvent } = recordingEvents();
    await runAcceptStep({ ...BASE, ssh, target, steps: [{ name: "accept", run: "make accept" }], appendEvent });
    const payload = events[0]!.payload as EventPayload<"benchmark.accept.failed">;
    expect(payload.steps[0]!.outputTail.length).toBeLessThanOrEqual(4000);
  });

  it("emits a verdict event whose payload parses against the registered schema", async () => {
    const { EventRegistry } = await import("../src/engine/events/index.js");
    const ssh = new RecordingSsh();
    const { events, appendEvent } = recordingEvents();
    await runAcceptStep({
      ...BASE,
      ssh,
      target,
      steps: [{ name: "accept", run: "make accept" }],
      appendEvent,
    });
    const evt = events[0]!;
    // Defense-in-depth: the emitted payload round-trips through the Zod registry.
    expect(() => EventRegistry[evt.eventType as "benchmark.accept.passed"].parse(evt.payload)).not.toThrow();
  });
});
