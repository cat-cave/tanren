// SELF-HEALING SCAFFOLD (apex v34): a project `just bootstrap` (deps install) failure is
// almost always a defect in the WRITER's OWN authored scaffold (e.g. a `package.json`
// that does not install cleanly — pnpm 11's `ERR_PNPM_IGNORED_BUILDS`). It is WRITER-
// FIXABLE, so it must LOOP BACK to the writer as a P0 finding carrying the bootstrap
// output (exactly like an invalid-`.tanren/ci.yml` or a gate-tier failure) — NOT
// terminally strand the spec. The mise PROVISION step (`mise install`) is NOT writer-
// fixable (the declared toolchain / network / runner) and STAYS a loud terminal halt.
//
// This mirrors gateLoopRouting.test.ts (the gate→writer routing model) + gateConfig
// Failure.test.ts (the boundary that projects a workspace throw onto a failed gate
// outcome). Two levels:
//   (1) the BOUNDARY: buildDefaultGate projects a WorkspaceDepsInstallError onto a
//       fail-closed `{ passed:false }` gate outcome (no throw, output fed to the
//       writer) while a WorkspaceMiseProvisionError / substrate fault STAYS a throw;
//   (2) the LOOP: a recurring bootstrap-failure routed through triage is bounded by the
//       CONVERGENCE answerer (terminates as convergence_stalled), never an infinite loop.
import { describe, expect, it } from "vitest";
import type { CiWhen } from "../src/engine/ci/index.js";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import { BOOTSTRAP_GATE_TIER, type GateOutcome } from "../src/engine/workflow/gate/index.js";
import { provisionMiseToolchain, WorkspaceMiseProvisionError } from "../src/engine/workspace/index.js";
import { prepareRunWorkspace } from "../src/engine/workflow/plannerRunWorkspace.js";
import { buildDefaultGate } from "../src/engine/workflow/plannerRunAdapters.js";
import type { PlannerRunContext, RunPlannerLoopInput } from "../src/engine/workflow/plannerRun.js";
import { gateFindings } from "../src/engine/workflow/loopFindings.js";
import { runSubtaskLoop } from "../src/engine/workflow/subtaskLoop.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import {
  buildPlan,
  convergenceStalled,
  defaultLoopInput,
  makeConvergence,
  makePlanner,
  makeTriage,
  triageAllTasks,
} from "./helpers/plannerLoopHelpers.js";

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};
const workspacePath = "/workspace/runs/run_boot/repo";

// The pnpm-11 evidence: `just bootstrap` exits 1 because pnpm ignored a build script.
// Tanren is stack-agnostic — it routes THIS output to the writer; it does not parse it.
const PNPM_IGNORED_BUILDS =
  "tanren: deps-ensure installing\n" +
  " ERR_PNPM_IGNORED_BUILDS  Ignored build scripts: esbuild@0.21.5.\n" +
  'Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.';

function context(): PlannerRunContext {
  return {
    runId: "run_boot",
    specId: "spec_boot",
    projectId: "project_boot",
    repoUrl: "https://github.com/cat-cave/greenfield",
    targetBranch: "main",
    runBranch: "tanren/boot",
    specTitle: "scaffold",
    specDescription: "stand up the toolchain",
    acceptanceCriteria: ["the pipeline is green"],
    runnerImage: "ghcr.io/cat-cave/tanren-runner:test",
    identitySecretRef: "runner/test/identity",
    githubCredentialRef: "credential/github/dev",
    greenfield: true,
  };
}

// Interprets buildDefaultGate's small SSH vocabulary, FAILING the deps-ensure guard
// (the writer's `just bootstrap`) with exit 1 + the pnpm output. The `.tanren/ci.yml`
// read returns empty ⇒ the resolver yields the stack-agnostic default config (a valid
// gate), so the failure is the deps install, NOT the config.
class BootstrapFailsSsh implements CommandSubstrate {
  readonly commands: RunnerCommand[] = [];
  async run(_t: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push(command);
    const ok = { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    if (command.command.includes(".tanren/ci.yml") && command.command.includes("cat ")) return ok;
    if (command.command === "git rev-parse HEAD") return { ...ok, stdout: "" };
    // The deps-ensure guard (the project's `just bootstrap`) FAILS — exit 1 + pnpm output.
    if (command.command.includes("deps-ensure")) {
      return { exitCode: 1, stdout: PNPM_IGNORED_BUILDS, stderr: "", timedOut: false };
    }
    return ok;
  }
}

function gateInput(ssh: CommandSubstrate): RunPlannerLoopInput {
  return { ssh, context: context(), timeoutMs: 100 } as unknown as RunPlannerLoopInput;
}

describe("buildDefaultGate — a `just bootstrap` failure is a fail-closed gate failure (not a terminal throw)", () => {
  it("returns a FAILED gate (does NOT throw) and emits gate.failed carrying the bootstrap output", async () => {
    const ssh = new BootstrapFailsSsh();
    const events = new FakeEventStore();
    const gate = buildDefaultGate(gateInput(ssh), target, workspacePath, events);

    // Today this throw escaped the gate callback and terminally stranded the spec; the
    // fix makes it a returned failed outcome routed back to the writer.
    const outcome = await gate({ when: "per_iteration", taskId: "task_w" });

    expect(outcome.passed).toBe(false);
    expect(outcome).toMatchObject({ failure: { tier: BOOTSTRAP_GATE_TIER } });
    if (outcome.passed) throw new Error("unreachable");
    // The bootstrap output (the ERR_PNPM_… detail) rides in the step's outputTail so the
    // writer is fed EXACTLY what to fix.
    expect(outcome.failure.steps[0]?.outputTail).toContain("ERR_PNPM_IGNORED_BUILDS");
    expect(outcome.failure.exitCode).toBe(1);
    // A gate.failed event records the broken scaffold loudly on the run timeline.
    const failed = events.events.find((e) => e.eventType === "gate.failed");
    expect(failed).toBeDefined();
    expect((failed!.payload as { tier: string }).tier).toBe(BOOTSTRAP_GATE_TIER);
    // No tier step ran (the deps install failed before the gate could execute).
    expect(ssh.commands.some((c) => c.command.includes("just tier-"))).toBe(false);
  });

  it("the failed gate maps to a P0 finding that NAMES the scaffold + feeds the writer the bootstrap output", async () => {
    const gate = buildDefaultGate(gateInput(new BootstrapFailsSsh()), target, workspacePath, new FakeEventStore());

    const outcome = await gate({ when: "per_iteration" });
    if (outcome.passed) throw new Error("expected a failed gate");

    const finding = gateFindings(outcome);
    expect(finding.severity).toBe("P0");
    expect(finding.title).toContain("just bootstrap");
    // The writer's re-author context: the concrete bootstrap error.
    expect(finding.body).toContain("ERR_PNPM_IGNORED_BUILDS");
    // Stable id so a recurring bootstrap failure dedupes across loops (the convergence
    // answerer reasons over it → the loop is bounded).
    expect(finding.id).toBe(`gate-${BOOTSTRAP_GATE_TIER}-deps-install`);
  });
});

// The interpreting SSH for prepareRunWorkspace's mise PROVISION step. mise provision runs
// at workspace-prep BEFORE the writer loop; a failed `mise install` is NOT writer-fixable
// (declared toolchain / network / runner) and STAYS a loud terminal throw.
class MiseFailsSsh implements CommandSubstrate {
  async run(_t: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    if (command.command.includes("mise")) {
      return { exitCode: 1, stdout: "", stderr: "mise: failed to install node@22 (network)", timedOut: false };
    }
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  }
}

describe("the mise PROVISION step stays a TERMINAL halt (NOT writer-fixable)", () => {
  it("provisionMiseToolchain throws WorkspaceMiseProvisionError (never routed to the writer)", async () => {
    await expect(
      provisionMiseToolchain({ ssh: new MiseFailsSsh(), target, workspacePath, timeoutMs: 100 }),
    ).rejects.toBeInstanceOf(WorkspaceMiseProvisionError);
  });

  it("prepareRunWorkspace propagates the mise-provision failure (terminal — the run halts before the writer loop)", async () => {
    const input = {
      ssh: new MiseFailsSsh(),
      context: context(),
      timeoutMs: 100,
      // Bypass the GitHub credential resolution (test seam): a pre-resolved clone token.
      githubToken: "ghs_test",
    } as unknown as RunPlannerLoopInput;
    // The mise provision is the FIRST workspace-prep step that fails ⇒ a loud throw,
    // never a deps-install gate finding routed to the writer.
    await expect(prepareRunWorkspace(input, target, workspacePath)).rejects.toBeInstanceOf(WorkspaceMiseProvisionError);
  });
});

// A scripted gate for the loop-level boundedness test: returns the bootstrap-failure
// outcome on the pre_audit spec gate EVERY loop (a recurring writer-unfixable scaffold).
function failGate(tier: string, when: CiWhen, failedStep: string): Extract<GateOutcome, { passed: false }> {
  return {
    passed: false,
    results: [],
    failure: { passed: false, tier, when, failedStep, exitCode: 1, steps: [] },
  };
}

describe("a recurring `just bootstrap` failure routed to the writer is BOUNDED by convergence (never infinite)", () => {
  it("terminates as convergence_stalled, not an infinite loop", async () => {
    const passGate: GateOutcome = { passed: true, results: [] };
    // Every loop: per_iteration passes (so the inner writer loop completes), then the
    // pre_audit spec gate FAILS with the bootstrap tier (→ P0 finding kept in-spec). The
    // writer cannot fix the scaffold, so the gate keeps failing — and the CONVERGENCE
    // answerer (the sole loop bound) reports `stalled` and HALTS. Without the bound this
    // would loop forever.
    let call = 0;
    const runGate = async ({ when }: { when: CiWhen }): Promise<GateOutcome> => {
      call += 1;
      if (when === "pre_audit") return failGate(BOOTSTRAP_GATE_TIER, "pre_audit", "deps-install");
      return passGate;
    };
    const { input } = defaultLoopInput({
      runGate,
      escapeHatches: { maxWriterIterPerSubtask: 1 },
      convergencePolicy: {
        maxConsecutiveStalls: 1,
        demoRunEnabled: false,
        velocityDeferEnabled: false,
        velocityDeferMaxSeverity: "P3",
        velocityDeferAfterStalls: 0,
      },
      adapters: {
        ...defaultLoopInput().input.adapters,
        planner: makePlanner([buildPlan([{ title: "T", intent: "fix scaffold", behaviorIds: ["B1"] }])]),
        triage: makeTriage([triageAllTasks]),
        // The bootstrap failure recurs unchanged ⇒ the convergence answerer stalls.
        convergence: makeConvergence([convergenceStalled]),
      },
    });

    const outcome = await runSubtaskLoop(input);

    // Bounded: it HALTED (convergence_stalled), it did not loop forever.
    expect(outcome.kind).toBe("convergence_stalled");
    // The gate ran a BOUNDED number of times (not unbounded).
    expect(call).toBeGreaterThan(0);
    expect(call).toBeLessThan(20);
  });
});
