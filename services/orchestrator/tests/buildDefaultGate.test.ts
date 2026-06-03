// buildDefaultGate: the production gate callback's greenfield deps-ensure +
// lenient-posture wiring. Drives buildDefaultGate against an interpreting SSH
// fake (a virtual workspace whose manifest/node_modules/tool availability change
// over the run) so we exercise the REAL ensure-before-tier ordering, the
// idempotent install caching, and the lenient advisory semantics end-to-end —
// without a live runner. No DB: a FakeEventStore captures the emitted gate.* /
// gate.advisory_failed events.
import { describe, expect, it } from "vitest";
import type { SshTarget } from "../src/engine/contracts/allocator.js";
import type { SshCommand, SshCommandResult, SshSubstrate } from "../src/engine/contracts/sshSubstrate.js";
import type { GovernancePosture } from "../src/engine/config/shared.js";
import { buildDefaultGate } from "../src/engine/workflow/plannerRunAdapters.js";
import type { PlannerRunContext, RunPlannerLoopInput } from "../src/engine/workflow/plannerRun.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";

const target: SshTarget = {
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};

const workspacePath = "/workspace/runs/run_greenfield/repo";

function context(governancePosture?: GovernancePosture): PlannerRunContext {
  return {
    runId: "run_greenfield",
    specId: "spec_greenfield",
    projectId: "project_greenfield",
    repoUrl: "https://github.com/cat-cave/greenfield",
    targetBranch: "main",
    runBranch: "tanren/greenfield",
    specTitle: "monorepo scaffold",
    specDescription: "stand up the toolchain",
    acceptanceCriteria: ["the pipeline is green"],
    runnerImage: "ghcr.io/cat-cave/tanren-runner:test",
    identitySecretRef: "runner/test/identity",
    githubCredentialRef: "credential/github/dev",
    ...(governancePosture === undefined ? {} : { governancePosture }),
  };
}

// A virtual workspace the SSH fake interprets. `manifest`/`nodeModules` model the
// greenfield timeline; `toolsAvailable` is false until deps are installed (so a
// `pnpm lint` against an uninstalled tree fails like the real `turbo: not found`).
interface WorkspaceState {
  manifest: boolean;
  nodeModules: boolean;
  // When the deps install runs (manifest present, node_modules absent), the
  // gate's lint step would otherwise fail; once installed, the lint outcome is
  // governed by `lintExit`.
  lintExit: number;
}

// Interprets the small command vocabulary buildDefaultGate issues over SSH:
//   - the `cat tanren-ci.yml` config read (no file ⇒ default config)
//   - the deps-ensure guard (install only if manifest && !node_modules)
//   - the gate steps `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm build`
class InterpretingSsh implements SshSubstrate {
  readonly commands: SshCommand[] = [];
  constructor(private readonly state: WorkspaceState) {}
  async run(_target: SshTarget, command: SshCommand): Promise<SshCommandResult> {
    this.commands.push(command);
    const cmd = command.command;
    const ok = { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    // tanren-ci.yml read (`if [ -f .../tanren-ci.yml ]; then cat ...; fi`): no file.
    if (cmd.includes("tanren-ci.yml")) return ok;
    // The deps-ensure guard: install only when a manifest exists + node_modules absent.
    if (cmd.includes("node_modules")) {
      if (this.state.manifest && !this.state.nodeModules) {
        // The install populated node_modules.
        this.state.nodeModules = true;
        return { ...ok, stdout: "tanren: deps-ensure installing\nPackages: +120" };
      }
      return { ...ok, stdout: "tanren: deps-ensure no-op" };
    }
    // Gate steps. Without node_modules, lint/typecheck/test/build all "tool not
    // found" (exit 127). With node_modules, lint's outcome is governed by lintExit;
    // typecheck/test/build pass.
    if (cmd.startsWith("pnpm ")) {
      if (!this.state.nodeModules) {
        return { exitCode: 127, stdout: "", stderr: "sh: 1: turbo: not found", timedOut: false };
      }
      if (cmd === "pnpm lint") {
        return this.state.lintExit === 0 ? ok : { ...ok, exitCode: this.state.lintExit, stderr: "lint error" };
      }
      return ok;
    }
    return ok;
  }
}

function gateInput(ssh: SshSubstrate, ctx: PlannerRunContext): RunPlannerLoopInput {
  // buildDefaultGate only reads ssh / context / timeoutMs / bootstrapCommand /
  // appEnv off the input; the rest of RunPlannerLoopInput is irrelevant here.
  return { ssh, context: ctx, timeoutMs: 100 } as unknown as RunPlannerLoopInput;
}

describe("buildDefaultGate — greenfield deps-ensure", () => {
  it("installs deps before the tier so the first post-writer gate passes (not turbo-not-found)", async () => {
    // Greenfield: the writer has authored a manifest, but deps were never installed
    // (the cold bootstrap skipped install on the manifest-less clone HEAD).
    const state: WorkspaceState = { manifest: true, nodeModules: false, lintExit: 0 };
    const ssh = new InterpretingSsh(state);
    const events = new FakeEventStore();
    const gate = buildDefaultGate(gateInput(ssh, context()), target, workspacePath, events);

    const outcome = await gate({ when: "per_iteration", taskId: "task_w" });

    expect(outcome.passed).toBe(true);
    // The ensure guard ran BEFORE the first `pnpm lint` (ordering is load-bearing).
    const ensureIdx = ssh.commands.findIndex((c) => c.command.includes("node_modules"));
    const lintIdx = ssh.commands.findIndex((c) => c.command === "pnpm lint");
    expect(ensureIdx).toBeGreaterThanOrEqual(0);
    expect(lintIdx).toBeGreaterThan(ensureIdx);
    // No gate.failed: deps installed, so lint/typecheck/test all exit 0.
    expect(events.events.some((e) => e.eventType === "gate.failed")).toBe(false);
    expect(events.events.some((e) => e.eventType === "gate.passed")).toBe(true);
  });

  it("caches the installed flag: a later gate (pre_audit) does NOT re-run the install", async () => {
    const state: WorkspaceState = { manifest: true, nodeModules: false, lintExit: 0 };
    const ssh = new InterpretingSsh(state);
    const gate = buildDefaultGate(gateInput(ssh, context()), target, workspacePath, new FakeEventStore());

    await gate({ when: "per_iteration" });
    const ensureCallsAfterFirst = ssh.commands.filter((c) => c.command.includes("node_modules")).length;
    await gate({ when: "pre_audit" });
    const ensureCallsAfterSecond = ssh.commands.filter((c) => c.command.includes("node_modules")).length;

    // The ensure guard ran exactly once (the first gate); pre_audit skipped it
    // because the install latched the cached `depsInstalled` flag.
    expect(ensureCallsAfterFirst).toBe(1);
    expect(ensureCallsAfterSecond).toBe(1);
  });
});

describe("buildDefaultGate — lenient posture", () => {
  it("a failing lint (advisory) → the gate PASSES with a gate.advisory_failed warning", async () => {
    // Deps install, but lint genuinely fails. Under lenient, lint is advisory.
    const state: WorkspaceState = { manifest: true, nodeModules: false, lintExit: 2 };
    const ssh = new InterpretingSsh(state);
    const events = new FakeEventStore();
    const gate = buildDefaultGate(gateInput(ssh, context("lenient")), target, workspacePath, events);

    const outcome = await gate({ when: "per_iteration" });

    expect(outcome.passed).toBe(true);
    const advisory = events.events.find((e) => e.eventType === "gate.advisory_failed");
    expect(advisory).toBeDefined();
    expect((advisory!.payload as { advisoryStep: string }).advisoryStep).toBe("lint");
    expect(events.events.some((e) => e.eventType === "gate.failed")).toBe(false);
    // The tier still ran the later steps (lint did not short-circuit).
    expect(ssh.commands.some((c) => c.command === "pnpm test")).toBe(true);
  });

  it("under the strict default the same failing lint FAILS the gate", async () => {
    const state: WorkspaceState = { manifest: true, nodeModules: false, lintExit: 2 };
    const ssh = new InterpretingSsh(state);
    const events = new FakeEventStore();
    // No governancePosture ⇒ strict default ⇒ every step blocks.
    const gate = buildDefaultGate(gateInput(ssh, context()), target, workspacePath, events);

    const outcome = await gate({ when: "per_iteration" });

    expect(outcome.passed).toBe(false);
    expect(events.events.some((e) => e.eventType === "gate.failed")).toBe(true);
    expect(events.events.some((e) => e.eventType === "gate.advisory_failed")).toBe(false);
  });
});
