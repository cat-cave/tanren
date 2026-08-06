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
import {
  commitBootstrapState,
  provisionMiseToolchain,
  runWorkspaceSshCommand,
  WorkspaceBootstrapError,
  WorkspaceMiseProvisionError,
} from "../src/engine/workspace/index.js";
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
    orgId: "org_boot",
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

// A minimal SSH that succeeds every workspace-prep round-trip (clone / identity / seed
// ignore / `.tanren/ci.yml` read / commit / contract files). It returns a 40-hex sha for
// the clone + commit `git rev-parse HEAD` so the prep proceeds to the bootstrap step,
// which the test drives through the `runBootstrap` seam (not this SSH).
class PrepOkSsh implements CommandSubstrate {
  readonly commands: RunnerCommand[] = [];
  async run(_t: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push(command);
    const ok = { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    // `.tanren/ci.yml` read returns empty ⇒ the resolver yields no explicit bootstrap
    // command (the stack-agnostic default), keeping the prep path simple.
    if (command.command.includes(".tanren/ci.yml")) return ok;
    // Clone + commit-bootstrap-state `git rev-parse HEAD` ⇒ a real 40-hex sha.
    if (command.command.includes("git rev-parse HEAD")) return { ...ok, stdout: `${"a".repeat(40)}\n` };
    return ok;
  }
}

// The pnpm-11 evidence at workspace-PREP: the prep `just bootstrap` exits 1. Mirrors the
// gate-bootstrap case above, but for the prep step (`bootstrapWorkspace`, before the writer
// loop). #562 self-healed the GATE bootstrap; apex v35 self-heals the PREP bootstrap too.
const PREP_BOOTSTRAP_COMMAND = "just bootstrap";
function prepBootstrapError(): WorkspaceBootstrapError {
  return new WorkspaceBootstrapError(workspacePath, PREP_BOOTSTRAP_COMMAND, 1, PNPM_IGNORED_BUILDS, false);
}

describe("the workspace-PREP `just bootstrap` deps-install self-heals via the gate (NOT a terminal strand)", () => {
  it("prepareRunWorkspace does NOT throw on a prep bootstrap deps-install failure — it DEFERS to the gate", async () => {
    const input = {
      ssh: new PrepOkSsh(),
      context: context(),
      timeoutMs: 100,
      githubToken: "ghs_test",
      // The mise provision is a no-op here (the FIXABLE thing is the project's bootstrap).
      provisionMise: async () => {},
      // The PREP `just bootstrap` (deps install) FAILS — the writer-fixable scaffold defect.
      runBootstrap: async () => {
        throw prepBootstrapError();
      },
      // The bootstrap commit still lands (--allow-empty); return a concrete base sha.
      commitBootstrap: async () => "b".repeat(40),
    } as unknown as RunPlannerLoopInput;

    // Today this throw escaped prepareRunWorkspace → workspace.failed → the spec stranded
    // at needs_attention. The fix DEFERS it: prepareRunWorkspace returns normally, carrying
    // a `prepBootstrapDeferred` signal so the caller emits `workspace.bootstrap_deferred`
    // and the writer loop runs (the gate's `ensureWorkspaceDepsInstalled` re-runs + #562
    // self-heals a still-broken scaffold).
    const prepared = await prepareRunWorkspace(input, target, workspacePath);

    expect(prepared.prepBootstrapDeferred).toBeDefined();
    expect(prepared.prepBootstrapDeferred?.exitCode).toBe(1);
    expect(prepared.prepBootstrapDeferred?.timedOut).toBe(false);
    expect(prepared.prepBootstrapDeferred?.command).toBe(PREP_BOOTSTRAP_COMMAND);
    // The bootstrap output (the ERR_PNPM_… detail) rides in the signal so the caller's
    // `workspace.bootstrap_deferred` event surfaces exactly what the gate will route.
    expect(prepared.prepBootstrapDeferred?.outputTail).toContain("ERR_PNPM_IGNORED_BUILDS");
    // The prep still produced a base sha (the writer loop has a diff base to run against).
    expect(prepared.baseSha).toBe("b".repeat(40));
  });

  it("a NON-deps-install prep throw (a substrate fault) still propagates LOUDLY (no silent defer)", async () => {
    const input = {
      ssh: new PrepOkSsh(),
      context: context(),
      timeoutMs: 100,
      githubToken: "ghs_test",
      provisionMise: async () => {},
      // A generic (non-WorkspaceBootstrapError) throw is NOT writer-fixable — it must
      // propagate, never be recast as a defer (no-silent-fallback).
      runBootstrap: async () => {
        throw new Error("ssh transport reset");
      },
      commitBootstrap: async () => "b".repeat(40),
    } as unknown as RunPlannerLoopInput;

    await expect(prepareRunWorkspace(input, target, workspacePath)).rejects.toThrow("ssh transport reset");
  });

  it("the mise PROVISION failure stays terminal even on the prep path (NOT deferred to the writer)", async () => {
    // The mise provision runs BEFORE the prep bootstrap; a failed one throws
    // WorkspaceMiseProvisionError and never reaches the deps-install defer. Symmetric with
    // #562: only the project's `just bootstrap` is writer-fixable, the toolchain is not.
    const input = {
      ssh: new PrepOkSsh(),
      context: context(),
      timeoutMs: 100,
      githubToken: "ghs_test",
      provisionMise: async () => {
        throw new WorkspaceMiseProvisionError(workspacePath, 1, "mise: failed to install node@22", false);
      },
      // The bootstrap would defer, but the mise provision fails FIRST ⇒ a terminal throw.
      runBootstrap: async () => {
        throw prepBootstrapError();
      },
      commitBootstrap: async () => "b".repeat(40),
    } as unknown as RunPlannerLoopInput;

    await expect(prepareRunWorkspace(input, target, workspacePath)).rejects.toBeInstanceOf(WorkspaceMiseProvisionError);
  });
});

// The target repo's commit hooks, simulated. A repo whose hook shells out to its package
// manager (the near-universal husky/lefthook shape) FAILS every `git commit` while the
// toolchain is absent — and the runner ships no project toolchain by design. The substrate
// refuses any `git commit` that does not disable the repo's hook path, standing in for
// ANY hook class (pre-commit, commit-msg, prepare-commit-msg), and mirrors `set -eu`
// aborting the commit chain.
const HUSKY_TOOLCHAIN_FAILURE =
  ".husky/pre-commit: line 3: pnpm: command not found\nhusky - pre-commit script failed (code 127)";
class PreCommitHookNeedsToolchainSsh implements CommandSubstrate {
  readonly commands: RunnerCommand[] = [];
  async run(_t: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push(command);
    const ok = { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    if (command.command.includes(".tanren/ci.yml")) return ok;
    if (command.command.includes("commit -q --allow-empty")) {
      if (!command.command.includes("core.hooksPath=/dev/null")) {
        // The hook ran and died on the missing toolchain; `set -eu &&` aborts the chain
        // before `git rev-parse HEAD`, so the whole command exits nonzero with no sha.
        return { exitCode: 127, stdout: "", stderr: HUSKY_TOOLCHAIN_FAILURE, timedOut: false };
      }
      return { ...ok, stdout: `${"c".repeat(40)}\n` };
    }
    if (command.command.includes("git rev-parse HEAD")) return { ...ok, stdout: `${"a".repeat(40)}\n` };
    return ok;
  }
}

// REGRESSION — the deferred-bootstrap self-heal must be REACHABLE on a repo whose
// pre-commit hook needs the toolchain.
//
// The self-heal test above proves prep DEFERS a failed deps install, but it stubs the
// `commitBootstrap` seam — so the REAL `commitBootstrapState`, the step that actually
// runs the repo's hook, never executes on the deferred path. In production it does: prep
// catches the deps-install failure to defer it, then unconditionally commits the
// bootstrap tree. With the repo hook path live, the hook demands the package manager the deferred
// bootstrap did not install, `git commit` exits nonzero, `runWorkspaceSshCommand` throws
// `WorkspaceCommandError`, and NOTHING catches it — the run dies in prep and the deliberate
// self-heal is dead code on every such repo.
describe("the deferred-bootstrap self-heal survives a target repo whose pre-commit hook needs the toolchain", () => {
  it("commitBootstrapState runs NONE of the target repo's commit hooks", async () => {
    const ssh = new PreCommitHookNeedsToolchainSsh();

    const sha = await commitBootstrapState({ ssh, target, workspacePath });

    expect(sha).toBe("c".repeat(40));
    const commit = ssh.commands.find((c) => c.command.includes("commit -q --allow-empty"));
    // The whole hook path is disabled for this one invocation, not just the two hooks
    // `--no-verify` covers: a toolchain-dependent `prepare-commit-msg` would still fire
    // under `--no-verify` and kill prep exactly the same way.
    expect(commit?.command).toContain("-c core.hooksPath=/dev/null");
    expect(commit?.command).not.toContain("--no-verify");
  });

  it("prepareRunWorkspace completes the DEFERRED path through the REAL bootstrap commit (no stubbed seam)", async () => {
    const ssh = new PreCommitHookNeedsToolchainSsh();
    const input = {
      ssh,
      context: context(),
      timeoutMs: 100,
      githubToken: "ghs_test",
      provisionMise: async () => {},
      // The prep deps install fails — the deferred self-heal path. The workspace now has
      // NO package manager, so the repo's pre-commit hook cannot run.
      runBootstrap: async () => {
        throw prepBootstrapError();
      },
      // NOTE: no `commitBootstrap` seam — the real commit path runs.
    } as unknown as RunPlannerLoopInput;

    const prepared = await prepareRunWorkspace(input, target, workspacePath);

    // The defer survived to the writer loop instead of being killed in prep...
    expect(prepared.prepBootstrapDeferred?.exitCode).toBe(1);
    expect(prepared.prepBootstrapDeferred?.outputTail).toContain("ERR_PNPM_IGNORED_BUILDS");
    // ...and the run still has a concrete diff base.
    expect(prepared.baseSha).toBe("c".repeat(40));
  });

  it("NEGATIVE CONTROL: the same prep DIES when the bootstrap commit runs the repo's hooks", async () => {
    // Drive the identical scenario through a commit seam that reproduces the pre-fix
    // behaviour (a hook-verified commit). The failure must still be LOUD — this fix
    // removes the hook from the bootstrap commit, it does NOT make prep swallow a failed
    // commit. Any other commit failure still kills the run, as it should.
    const ssh = new PreCommitHookNeedsToolchainSsh();
    const input = {
      ssh,
      context: context(),
      timeoutMs: 100,
      githubToken: "ghs_test",
      provisionMise: async () => {},
      runBootstrap: async () => {
        throw prepBootstrapError();
      },
      commitBootstrap: async (stepInput: { ssh: CommandSubstrate; target: RunnerHandle; workspacePath: string }) =>
        runWorkspaceSshCommand(stepInput.ssh, stepInput.target, {
          label: "commit bootstrap state",
          cwd: stepInput.workspacePath,
          command: "set -eu && git add -A && git commit -q --allow-empty -m 'tanren: bootstrap'",
        }).then((r) => r.stdout.trim()),
    } as unknown as RunPlannerLoopInput;

    await expect(prepareRunWorkspace(input, target, workspacePath)).rejects.toThrow("commit bootstrap state failed");
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
