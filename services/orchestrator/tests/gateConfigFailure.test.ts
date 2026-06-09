// FAIL-CLOSED gate-config boundary (the v25-apex crash class): a built-repo
// `.tanren/ci.yml` that does not satisfy `CiConfigV1` (the live evidence: `tiers.fast`
// an object not an array, `when` undefined) must be a LOUD, RUN-SCOPED gate FAILURE —
// NEVER an unhandled throw that crash-loops the shared worker, and NEVER a pass. The
// gate returns `{ passed: false }` with the validation issues, emits `gate.failed`, and
// the failure flows through `gateFindings` to a P0 "the repo's `.tanren/ci.yml` is
// invalid" so the spec loop fixes the config in-place. A SSH fake supplies the invalid
// config text; no live runner.
import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import { CI_CONFIG_GATE_TIER } from "../src/engine/workflow/gate/index.js";
import { gateFindings } from "../src/engine/workflow/loopFindings.js";
import { buildDefaultGate } from "../src/engine/workflow/plannerRunAdapters.js";
import type { PlannerRunContext, RunPlannerLoopInput } from "../src/engine/workflow/plannerRun.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};
const workspacePath = "/workspace/runs/run_cfg/repo";

// The exact shape from the live v25-apex crash: tiers.fast a MAPPING (not an array) and
// no `when` policy — two `CiConfigV1` schema violations the resolver rejects.
const INVALID_CI_YAML = "version: 1\ntiers:\n  fast:\n    name: lint\n    run: pnpm lint\n";

function context(): PlannerRunContext {
  return {
    runId: "run_cfg",
    specId: "spec_cfg",
    projectId: "project_cfg",
    repoUrl: "https://github.com/cat-cave/greenfield",
    targetBranch: "main",
    runBranch: "tanren/cfg",
    specTitle: "scaffold",
    specDescription: "stand up the toolchain",
    acceptanceCriteria: ["the pipeline is green"],
    runnerImage: "ghcr.io/cat-cave/tanren-runner:test",
    identitySecretRef: "runner/test/identity",
    githubCredentialRef: "credential/github/dev",
    greenfield: true,
  };
}

// Returns the invalid config text for the `.tanren/ci.yml` read; records every command
// so the test can prove the gate SHORT-CIRCUITED (no deps-ensure, no tier step ran).
class InvalidConfigSsh implements CommandSubstrate {
  readonly commands: RunnerCommand[] = [];
  async run(_t: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push(command);
    const ok = { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    if (command.command.includes(".tanren/ci.yml") || command.command.includes("tanren-ci.yml")) {
      return { ...ok, stdout: INVALID_CI_YAML };
    }
    return ok;
  }
}

function gateInput(ssh: CommandSubstrate): RunPlannerLoopInput {
  return { ssh, context: context(), timeoutMs: 100 } as unknown as RunPlannerLoopInput;
}

describe("buildDefaultGate — invalid .tanren/ci.yml is a fail-closed gate failure (not a throw)", () => {
  it("returns a FAILED gate (does NOT throw) and emits gate.failed with the validation issues", async () => {
    const ssh = new InvalidConfigSsh();
    const events = new FakeEventStore();
    const gate = buildDefaultGate(gateInput(ssh), target, workspacePath, events);

    // The crash was an UNHANDLED throw here; the fix makes it a returned failed outcome.
    const outcome = await gate({ when: "per_iteration", taskId: "task_w" });

    expect(outcome.passed).toBe(false);
    expect(outcome).toMatchObject({ failure: { tier: CI_CONFIG_GATE_TIER } });
    // A gate.failed event records the broken config loudly on the run timeline.
    const failed = events.events.find((e) => e.eventType === "gate.failed");
    expect(failed).toBeDefined();
    expect((failed!.payload as { tier: string }).tier).toBe(CI_CONFIG_GATE_TIER);
    if (outcome.passed) throw new Error("unreachable");
    // The validation issues are surfaced in the failed step's outputTail (so the
    // finding/steering names exactly what to fix). No verdict — nothing ran.
    expect(outcome.failure.steps[0]?.outputTail).toContain("invalid tanren-ci.yml");
    expect(events.events.some((e) => e.eventType === "gate.verdict")).toBe(false);
    // It short-circuited BEFORE deps-ensure / any tier step — a gate we cannot run.
    expect(ssh.commands.some((c) => c.command.includes("deps-ensure"))).toBe(false);
    expect(ssh.commands.some((c) => c.command === "pnpm lint")).toBe(false);
  });

  it("memoizes the classification: a SECOND gate call also fails (no re-throw on reuse)", async () => {
    const ssh = new InvalidConfigSsh();
    const gate = buildDefaultGate(gateInput(ssh), target, workspacePath, new FakeEventStore());

    const first = await gate({ when: "per_iteration" });
    const second = await gate({ when: "pre_audit" });

    expect(first.passed).toBe(false);
    expect(second.passed).toBe(false);
    // The config was read ONCE and the classification reused (the memoized result).
    const reads = ssh.commands.filter((c) => c.command.includes(".tanren/ci.yml")).length;
    expect(reads).toBe(1);
  });

  it("the failed gate maps to a P0 finding naming the invalid config (so the loop fixes it)", async () => {
    const gate = buildDefaultGate(gateInput(new InvalidConfigSsh()), target, workspacePath, new FakeEventStore());

    const outcome = await gate({ when: "pre_audit" });
    if (outcome.passed) throw new Error("expected a failed gate");

    const finding = gateFindings(outcome);
    expect(finding.severity).toBe("P0");
    expect(finding.title).toContain(".tanren/ci.yml");
    expect(finding.body).toContain("invalid tanren-ci.yml");
    // Stable id so a recurring invalid config dedupes across loop iterations.
    expect(finding.id).toContain(CI_CONFIG_GATE_TIER);
  });
});
