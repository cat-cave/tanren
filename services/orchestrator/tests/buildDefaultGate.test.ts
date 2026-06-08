// buildDefaultGate: the production gate callback's greenfield deps-ensure +
// lenient-posture wiring. Drives buildDefaultGate against an interpreting SSH
// fake (a virtual workspace whose manifest/node_modules/tool availability change
// over the run) so we exercise the REAL ensure-before-tier ordering, the
// idempotent re-install EVERY gate (the P0 fix — no install latch), and the
// lenient advisory semantics end-to-end — without a live runner. No DB: a
// FakeEventStore captures the emitted gate.* / gate.advisory_failed events.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import type { GovernancePosture } from "../src/engine/config/shared.js";
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

const workspacePath = "/workspace/runs/run_greenfield/repo";

function context(opts?: { governancePosture?: GovernancePosture; greenfield?: boolean }): PlannerRunContext {
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
    ...(opts?.governancePosture === undefined ? {} : { governancePosture: opts.governancePosture }),
    ...(opts?.greenfield === undefined ? {} : { greenfield: opts.greenfield }),
  };
}

// A virtual workspace the SSH fake interprets. `manifest`/`nodeModules` model the
// greenfield timeline; `toolsAvailable` is false until deps are installed (so a
// `pnpm lint` against an uninstalled tree fails like the real `turbo: not found`).
interface WorkspaceState {
  manifest: boolean;
  nodeModules: boolean;
  // When the deps install runs (manifest present), the gate's lint step would
  // otherwise fail until node_modules exists; once installed, the lint outcome is
  // governed by `lintExit`.
  lintExit: number;
  // How many times the deps-ensure install actually ran (manifest present). The
  // P0 fix re-runs the install every gate, so this counts each gate's ensure.
  installRuns: number;
  // The workspace HEAD sha `git rev-parse HEAD` returns — the verdict anchor the
  // gate uses ABSENT a headShaOverride. Absent ⇒ "" ⇒ no verdict event (the existing
  // tests don't assert on the verdict; only the commit-binding test sets it).
  workspaceHead?: string;
}

// Interprets the small command vocabulary buildDefaultGate issues over SSH:
//   - the `cat tanren-ci.yml` config read (no file ⇒ default config)
//   - the deps-ensure guard (install WHENEVER a manifest exists — no node_modules gate)
//   - the gate steps `pnpm lint` / `pnpm typecheck` / `pnpm build` / `pnpm test ...`
class InterpretingSsh implements CommandSubstrate {
  readonly commands: RunnerCommand[] = [];
  constructor(private readonly state: WorkspaceState) {}
  async run(_target: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push(command);
    const cmd = command.command;
    const ok = { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    // tanren-ci.yml read (`if [ -f .../tanren-ci.yml ]; then cat ...; fi`): no file.
    if (cmd.includes("tanren-ci.yml")) return ok;
    // The native JUnit ingest read (`if [ -f .../reports/junit.xml ]; then cat ...; else
    // echo __TANREN_JUNIT_ABSENT__; fi`). The virtual workspace writes no report, so the
    // file is ABSENT — model the shell's else-branch marker. A tier with a junit-writing
    // test step (slow/merge) ⇒ the gate surfaces this as the LOUD `missing_expected`.
    if (cmd.includes("reports/junit.xml")) return { ...ok, stdout: "__TANREN_JUNIT_ABSENT__\n" };
    // The verdict-anchor read: the workspace HEAD the gate binds gate.verdict to
    // when no headShaOverride is given. A configured `workspaceHead` lets the
    // commit-binding test prove the override is preferred over THIS sha.
    if (cmd === "git rev-parse HEAD") return { ...ok, stdout: `${this.state.workspaceHead ?? ""}\n` };
    // The deps-ensure guard, recognized by its sentinel marker. The P0 guard runs
    // the install WHENEVER a manifest exists (it no longer probes node_modules), so
    // it installs even when node_modules is already present — re-running every gate.
    if (cmd.includes("deps-ensure")) {
      if (this.state.manifest) {
        this.state.installRuns += 1;
        // The install (re-)populates node_modules; counted so a later gate's
        // re-install is observable.
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

function gateInput(ssh: CommandSubstrate, ctx: PlannerRunContext): RunPlannerLoopInput {
  // buildDefaultGate only reads ssh / context / timeoutMs / bootstrapCommand /
  // appEnv off the input; the rest of RunPlannerLoopInput is irrelevant here.
  return { ssh, context: ctx, timeoutMs: 100 } as unknown as RunPlannerLoopInput;
}

// The verbatim deps-ensure guard command the gate issued (it embeds the resolved
// install command), so install-mode tests can assert on `--frozen-lockfile`.
function depsEnsureCommand(ssh: InterpretingSsh): string {
  const cmd = ssh.commands.find((c) => c.command.includes("deps-ensure"));
  expect(cmd).toBeDefined();
  return cmd!.command;
}

describe("buildDefaultGate — greenfield deps-ensure", () => {
  it("installs deps before the tier so the first post-writer gate passes (not turbo-not-found)", async () => {
    // Greenfield: the writer has authored a manifest, but deps were never installed
    // (the cold bootstrap skipped install on the manifest-less clone HEAD).
    const state: WorkspaceState = { manifest: true, nodeModules: false, lintExit: 0, installRuns: 0 };
    const ssh = new InterpretingSsh(state);
    const events = new FakeEventStore();
    const gate = buildDefaultGate(gateInput(ssh, context({ greenfield: true })), target, workspacePath, events);

    const outcome = await gate({ when: "per_iteration", taskId: "task_w" });

    expect(outcome.passed).toBe(true);
    // The ensure guard ran BEFORE the first `pnpm lint` (ordering is load-bearing).
    const ensureIdx = ssh.commands.findIndex((c) => c.command.includes("deps-ensure"));
    const lintIdx = ssh.commands.findIndex((c) => c.command === "pnpm lint");
    expect(ensureIdx).toBeGreaterThanOrEqual(0);
    expect(lintIdx).toBeGreaterThan(ensureIdx);
    // No gate.failed: deps installed, so lint/typecheck/test all exit 0.
    expect(events.events.some((e) => e.eventType === "gate.failed")).toBe(false);
    expect(events.events.some((e) => e.eventType === "gate.passed")).toBe(true);
  });

  // P0 FIX: the install latch is gone — the ensure re-runs before EVERY gate, so a
  // writer-added devDep authored after an earlier install still gets installed. The
  // old "cache the installed flag" behavior would have skipped the second gate's
  // install (and the run would die on `vitest: not found`).
  it("re-runs the deps install before a later gate (pre_audit), not just the first", async () => {
    const state: WorkspaceState = { manifest: true, nodeModules: false, lintExit: 0, installRuns: 0 };
    const ssh = new InterpretingSsh(state);
    const gate = buildDefaultGate(
      gateInput(ssh, context({ greenfield: true })),
      target,
      workspacePath,
      new FakeEventStore(),
    );

    await gate({ when: "per_iteration" });
    const ensureCallsAfterFirst = ssh.commands.filter((c) => c.command.includes("deps-ensure")).length;
    await gate({ when: "pre_audit" });
    const ensureCallsAfterSecond = ssh.commands.filter((c) => c.command.includes("deps-ensure")).length;

    // The ensure guard ran on BOTH gates (no latch) — and both actually installed
    // (manifest present), so the install ran twice, not once.
    expect(ensureCallsAfterFirst).toBe(1);
    expect(ensureCallsAfterSecond).toBe(2);
    expect(state.installRuns).toBe(2);
  });
});

// The greenfield-vs-brownfield INSTALL MODE: with no explicit install command,
// buildDefaultGate must pass the FROZEN DEFAULT_BOOTSTRAP_COMMAND for a brownfield
// run (so a committed lockfile is never mutated) and the NON-FROZEN deps-ensure
// default for a greenfield run (so a writer-added devDep installs without a
// regenerated lockfile). The deps-ensure guard embeds the chosen install command
// verbatim, so we assert on its presence/absence of `--frozen-lockfile`.
describe("buildDefaultGate — deps-ensure install mode (greenfield vs brownfield)", () => {
  it("a BROWNFIELD run (no greenfield flag, no explicit command) uses the FROZEN default — committed lockfile is never mutated", async () => {
    const state: WorkspaceState = { manifest: true, nodeModules: false, lintExit: 0, installRuns: 0 };
    const ssh = new InterpretingSsh(state);
    // context() with no greenfield flag ⇒ brownfield (the safe default = main's behavior).
    const gate = buildDefaultGate(gateInput(ssh, context()), target, workspacePath, new FakeEventStore());

    await gate({ when: "per_iteration" });

    const cmd = depsEnsureCommand(ssh);
    // The FROZEN brownfield default: `pnpm install --frozen-lockfile` / `npm ci`.
    expect(cmd).toContain("--frozen-lockfile");
    expect(cmd).toContain("npm ci");
  });

  it("a GREENFIELD run (greenfield flag, no explicit command) uses the NON-FROZEN default — writer-added devDeps install", async () => {
    const state: WorkspaceState = { manifest: true, nodeModules: false, lintExit: 0, installRuns: 0 };
    const ssh = new InterpretingSsh(state);
    const gate = buildDefaultGate(
      gateInput(ssh, context({ greenfield: true })),
      target,
      workspacePath,
      new FakeEventStore(),
    );

    await gate({ when: "per_iteration" });

    const cmd = depsEnsureCommand(ssh);
    // The NON-FROZEN greenfield default: a plain `pnpm install` / `npm install`,
    // never `--frozen-lockfile` / `npm ci`.
    expect(cmd).not.toContain("--frozen-lockfile");
    expect(cmd).not.toContain("npm ci");
    expect(cmd).toContain("pnpm install");
  });

  it("an explicit input.bootstrapCommand wins verbatim in BOTH greenfield and brownfield", async () => {
    for (const greenfield of [true, false]) {
      const state: WorkspaceState = { manifest: true, nodeModules: false, lintExit: 0, installRuns: 0 };
      const ssh = new InterpretingSsh(state);
      const input = {
        ssh,
        context: context({ greenfield }),
        timeoutMs: 100,
        bootstrapCommand: "corepack pnpm install --frozen-lockfile",
      } as unknown as RunPlannerLoopInput;
      const gate = buildDefaultGate(input, target, workspacePath, new FakeEventStore());

      await gate({ when: "per_iteration" });

      const cmd = depsEnsureCommand(ssh);
      expect(cmd).toContain("corepack pnpm install --frozen-lockfile");
    }
  });
});

describe("buildDefaultGate — lenient posture", () => {
  it("a failing lint (advisory) → the gate PASSES with a gate.advisory_failed warning", async () => {
    // Deps install, but lint genuinely fails. Under lenient, lint is advisory.
    const state: WorkspaceState = { manifest: true, nodeModules: false, lintExit: 2, installRuns: 0 };
    const ssh = new InterpretingSsh(state);
    const events = new FakeEventStore();
    const gate = buildDefaultGate(
      gateInput(ssh, context({ governancePosture: "lenient" })),
      target,
      workspacePath,
      events,
    );

    const outcome = await gate({ when: "per_iteration" });

    expect(outcome.passed).toBe(true);
    const advisory = events.events.find((e) => e.eventType === "gate.advisory_failed");
    expect(advisory).toBeDefined();
    expect((advisory!.payload as { advisoryStep: string }).advisoryStep).toBe("lint");
    expect(events.events.some((e) => e.eventType === "gate.failed")).toBe(false);
    // The tier still ran the later steps (advisory lint did not short-circuit). The
    // per_iteration fast tier is lint+typecheck (NO tests — the 3-tier default keeps
    // tests to tier-2+), so the proof the later step ran is `pnpm typecheck`.
    expect(ssh.commands.some((c) => c.command === "pnpm typecheck")).toBe(true);
  });

  it("under the strict default the same failing lint FAILS the gate", async () => {
    const state: WorkspaceState = { manifest: true, nodeModules: false, lintExit: 2, installRuns: 0 };
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

// COMMIT-BINDING (the gate↔land TOCTOU guard, tanren-owns-the-engine.md §5): the
// `pre_merge` merge gate runs on the live workspace whose HEAD is left at the WRITER
// TIP (bootstrap commit and all), but the PR was pushed from the CLEANED ref (bootstrap
// dropped) — a DIFFERENT sha. The merge authority resolves the landing head from the
// forge PR head, so the `gate.verdict` MUST be anchored on the PUSHED PR head, not the
// workspace HEAD, or `gatedHeadSha != landing head` blocks the merge forever. The gate
// honors a `headShaOverride` for exactly this — these tests prove it is preferred over
// (and the workspace-HEAD read is the absent-override default of) the verdict anchor.
describe("buildDefaultGate — gate.verdict commit-binding (headShaOverride)", () => {
  // WORKSPACE_HEAD = the writer tip (with the bootstrap commit); PR_HEAD = the cleaned
  // ref the PR was pushed from (bootstrap dropped) — the commit the authority lands.
  const WORKSPACE_HEAD = "a".repeat(40);
  const PR_HEAD = "b".repeat(40);

  it("anchors the pre_merge gate.verdict on the PUSHED PR head when a headShaOverride is given (not the workspace HEAD)", async () => {
    const state: WorkspaceState = {
      manifest: true,
      nodeModules: false,
      lintExit: 0,
      installRuns: 0,
      workspaceHead: WORKSPACE_HEAD,
    };
    const ssh = new InterpretingSsh(state);
    const events = new FakeEventStore();
    const gate = buildDefaultGate(gateInput(ssh, context({ greenfield: true })), target, workspacePath, events);

    // The merge authority calls the closure with the PUSHED PR head (the cleaned ref).
    const outcome = await gate({ when: "pre_merge", headShaOverride: PR_HEAD });

    expect(outcome.passed).toBe(true);
    const verdict = events.events.find((e) => e.eventType === "gate.verdict");
    expect(verdict).toBeDefined();
    // The verdict is bound to the PR head (what the authority lands), NOT the writer tip.
    expect((verdict!.payload as { headSha: string }).headSha).toBe(PR_HEAD);
    expect((verdict!.payload as { headSha: string }).headSha).not.toBe(WORKSPACE_HEAD);
  });

  it("falls back to the workspace HEAD as the verdict anchor when no override is given (per_iteration / pre_audit)", async () => {
    const state: WorkspaceState = {
      manifest: true,
      nodeModules: false,
      lintExit: 0,
      installRuns: 0,
      workspaceHead: WORKSPACE_HEAD,
    };
    const ssh = new InterpretingSsh(state);
    const events = new FakeEventStore();
    const gate = buildDefaultGate(gateInput(ssh, context({ greenfield: true })), target, workspacePath, events);

    // The writer-loop gates (no override) bind the verdict to the live workspace HEAD.
    await gate({ when: "per_iteration" });

    const verdict = events.events.find((e) => e.eventType === "gate.verdict");
    expect(verdict).toBeDefined();
    expect((verdict!.payload as { headSha: string }).headSha).toBe(WORKSPACE_HEAD);
  });

  // RESIDUAL #3 — FAIL-CLOSED at the gate boundary (no-silent-fallback doctrine). The
  // pre_merge gate EXPECTS a pushed PR-head override. An empty/absent override there
  // would silently fall back to the workspace HEAD (the writer tip) — the exact
  // wrong-commit binding the fix prevents. So pre_merge + (absent/empty/invalid
  // override) is a LOUD throw the moment the workspace HEAD is a real sha, never a
  // silent fallback.
  it("THROWS on a pre_merge gate with an EMPTY override (no silent workspace-HEAD fallback)", async () => {
    const state: WorkspaceState = {
      manifest: true,
      nodeModules: false,
      lintExit: 0,
      installRuns: 0,
      workspaceHead: WORKSPACE_HEAD,
    };
    const ssh = new InterpretingSsh(state);
    const events = new FakeEventStore();
    const gate = buildDefaultGate(gateInput(ssh, context({ greenfield: true })), target, workspacePath, events);

    // pre_merge with an empty override + a REAL workspace HEAD: must fail closed.
    await expect(gate({ when: "pre_merge", headShaOverride: "" })).rejects.toThrow(/pushed PR-head sha override/u);
    // No verdict was bound to the wrong (workspace HEAD) commit.
    expect(events.events.some((e) => e.eventType === "gate.verdict")).toBe(false);
  });

  it("THROWS on a pre_merge gate with NO override at all (absent ⇒ same fail-closed as empty)", async () => {
    const state: WorkspaceState = {
      manifest: true,
      nodeModules: false,
      lintExit: 0,
      installRuns: 0,
      workspaceHead: WORKSPACE_HEAD,
    };
    const ssh = new InterpretingSsh(state);
    const events = new FakeEventStore();
    const gate = buildDefaultGate(gateInput(ssh, context({ greenfield: true })), target, workspacePath, events);

    await expect(gate({ when: "pre_merge" })).rejects.toThrow(/pushed PR-head sha override/u);
    expect(events.events.some((e) => e.eventType === "gate.verdict")).toBe(false);
  });

  it("THROWS on a NON-40-hex override (corrupt read) at ANY when — never anchors on a bogus commit", async () => {
    const state: WorkspaceState = {
      manifest: true,
      nodeModules: false,
      lintExit: 0,
      installRuns: 0,
      workspaceHead: WORKSPACE_HEAD,
    };
    const ssh = new InterpretingSsh(state);
    const events = new FakeEventStore();
    const gate = buildDefaultGate(gateInput(ssh, context({ greenfield: true })), target, workspacePath, events);

    // A truncated/garbage override is corrupt — reject it (here on the pre_merge path).
    await expect(gate({ when: "pre_merge", headShaOverride: "not-a-sha" })).rejects.toThrow(/not a 40-hex sha/u);
    expect(events.events.some((e) => e.eventType === "gate.verdict")).toBe(false);
  });

  it("the fake-SSH unit path (workspace HEAD resolves to '') is tolerated on pre_merge — no throw, no verdict", async () => {
    // workspaceHead omitted ⇒ `git rev-parse HEAD` yields "" (the fake-SSH unit path).
    // pre_merge + empty override + empty workspace HEAD is the ONLY tolerated no-override
    // case: there is no real commit to bind, so the gate emits no verdict (not a throw).
    const state: WorkspaceState = { manifest: true, nodeModules: false, lintExit: 0, installRuns: 0 };
    const ssh = new InterpretingSsh(state);
    const events = new FakeEventStore();
    const gate = buildDefaultGate(gateInput(ssh, context({ greenfield: true })), target, workspacePath, events);

    const outcome = await gate({ when: "pre_merge", headShaOverride: "" });

    expect(outcome.passed).toBe(true);
    expect(events.events.some((e) => e.eventType === "gate.verdict")).toBe(false);
  });
});

// NO-SILENT-FALLBACK: the native JUnit ingest must DISCRIMINATE "no test step ran"
// (quiet) from "a junit-writing test step ran but produced no report" (LOUD). The
// virtual workspace writes no report, so a tier with a junit test step (slow/merge,
// `pnpm test --reporter=junit --outputFile=reports/junit.xml`) is the expected-but-
// missing case; the fast tier (lint+typecheck) is the quiet case. The loud mechanism
// is a structured `console.error` (non-merge-gating — visibility, not a blocker).
describe("buildDefaultGate — native JUnit ingest (expected-but-missing is LOUD)", () => {
  // A fuller input than gateInput: a fake pool + an org so the best-effort ingest runs.
  function ingestInput(ssh: CommandSubstrate): RunPlannerLoopInput {
    const fakePool = { query: async () => ({ rows: [], rowCount: 0 }) };
    return {
      ssh,
      context: { ...context({ greenfield: true }), orgId: "org_1" },
      timeoutMs: 100,
      pool: fakePool,
    } as unknown as RunPlannerLoopInput;
  }

  afterEach(() => vi.restoreAllMocks());

  it("pre_audit (junit-writing test step ran) + absent report → a LOUD console.error", async () => {
    // node_modules present so the gate steps pass; the report is absent (the fake echoes
    // the absent marker), and pre_audit runs the slow tier's junit-writing test step.
    const state: WorkspaceState = {
      manifest: true,
      nodeModules: true,
      lintExit: 0,
      installRuns: 0,
      workspaceHead: "c".repeat(40),
    };
    const errs = vi.spyOn(console, "error").mockImplementation(() => {});
    const gate = buildDefaultGate(ingestInput(new InterpretingSsh(state)), target, workspacePath, new FakeEventStore());

    const outcome = await gate({ when: "pre_audit" });

    expect(outcome.passed).toBe(true);
    const loud = errs.mock.calls.map((c) => String(c[0])).find((m) => m.includes("native JUnit report EXPECTED"));
    expect(loud).toBeDefined();
    // The signal names the reason (absent) + the tier — never a silent degrade.
    expect(loud).toContain("absent");
    expect(loud).toContain("tier=slow");
  });

  it("per_iteration (no junit-writing test step) + absent report → QUIET (no loud signal)", async () => {
    const state: WorkspaceState = {
      manifest: true,
      nodeModules: true,
      lintExit: 0,
      installRuns: 0,
      workspaceHead: "c".repeat(40),
    };
    const errs = vi.spyOn(console, "error").mockImplementation(() => {});
    const gate = buildDefaultGate(ingestInput(new InterpretingSsh(state)), target, workspacePath, new FakeEventStore());

    const outcome = await gate({ when: "per_iteration" });

    expect(outcome.passed).toBe(true);
    // The fast tier ran no junit-writing test step ⇒ no loud "expected but missing" log.
    expect(errs.mock.calls.map((c) => String(c[0])).some((m) => m.includes("native JUnit report EXPECTED"))).toBe(
      false,
    );
  });
});
