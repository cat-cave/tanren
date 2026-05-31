// P2A-0015: runPlannerLoopWorkflow integration tests. The workflow is driven
// with fake adapters + a fake usage probe (so no real SSH/Codex), asserting on
// the persisted run state, the PR/CI tail on a passing loop, the halted
// mapping for non-pass outcomes, and the CodexUsageLimitError → window
// escalation path. Allocator release always runs (finally). Shared fakes +
// builders live in plannerRun.fixtures.ts (500-line cap split).
import { describe, expect, it } from "vitest";
import type { SshTarget } from "../src/engine/contracts/allocator.js";
import type { SshCommand, SshCommandResult, SshSubstrate } from "../src/engine/contracts/sshSubstrate.js";
import { CodexUsageLimitError } from "../src/engine/providers/codex.js";
import { runPlannerLoopWorkflow } from "../src/engine/workflow/plannerRun.js";
import { WorkspaceBootstrapError } from "../src/engine/workspace/index.js";
import {
  accounting,
  approvingReview,
  buildPlan,
  exhaustedWindow,
  failingCheck,
  fakeProbe,
  healthyWindow,
  makeAuditor,
  makeChecker,
  makePlanner,
  makeWriter,
  noopMerge,
  passingAudit,
  passingCheck,
  passingGitHub,
  ScriptedGitHubHttp,
  setup,
  twoSubtaskAdapters,
} from "./plannerRun.fixtures.js";

describe("runPlannerLoopWorkflow", () => {
  it("drives the loop, publishes a PR, polls CI, and records a passing run on the happy path", async () => {
    const { ctx, pool, events, secrets, allocator, ssh } = await setup();
    const github = passingGitHub();

    const result = await runPlannerLoopWorkflow({
      pool: pool.asPgPool(),
      eventStore: events,
      allocator,
      ssh,
      secrets,
      githubHttp: github,
      context: ctx,
      escapeHatches: {
        maxPlannerRerunsPerSpec: 3,
        maxWriterIterPerSubtask: 5,
        maxRetriesPerTransientFailure: 3,
      },
      timeoutMs: 100,
      maxCiPolls: 1,
      sleep: async () => {},
      buildAdapters: () => twoSubtaskAdapters([passingCheck, passingCheck]),
      buildUsageProbe: () => fakeProbe(healthyWindow(), accounting(0.5)),
      reviewProbe: approvingReview(),
      mergeProbe: noopMerge(),
    });

    expect(result.outcome.kind).toBe("passed");
    expect(result.pullRequest?.prNumber).toBe(7);
    expect(result.ci?.status).toBe("passed");
    expect(pool.runStatus).toEqual({ status: "done", outcome: "ok" });
    expect(allocator.releases).toEqual(["runner_planner"]);

    const names = events.events.map((event) => event.eventType);
    expect(names).toContain("runner.allocated");
    expect(names).toContain("workspace.prepared");
    expect(names).toContain("usage.window.observed");
    expect(names).toContain("usage.accounting.observed");
    expect(names).toContain("runner.released");
    expect(ssh.commands[0]?.command.command).toContain("git clone --depth 1");
    // Two subtasks → two write tasks persisted.
    expect(pool.taskKinds.filter((kind) => kind === "write")).toHaveLength(2);
    expect(JSON.stringify(events.events)).not.toContain("ghp_secretToken");
  });

  it("re-plans on a checker rejection and still completes (medium-tier loop shape)", async () => {
    const { ctx, pool, events, secrets, allocator, ssh } = await setup();
    const adapters = {
      planner: makePlanner([
        buildPlan([
          { title: "T1", intent: "ok", behaviorIds: [] },
          { title: "T2", intent: "fail", behaviorIds: [] },
        ]),
        buildPlan([
          { title: "T1b", intent: "ok again", behaviorIds: [] },
          { title: "T2b", intent: "fail again", behaviorIds: [] },
        ]),
      ]) as AnswererAdapter<PlanAnswer>,
      writer: makeWriter(["d1\n", "d2\n", "d3\n", "d4\n"]),
      checker: makeChecker([failingCheck, passingCheck, passingCheck]) as AnswererAdapter<CheckAnswer>,
      auditor: makeAuditor([passingAudit]) as AnswererAdapter<AuditAnswer>,
    };

    const result = await runPlannerLoopWorkflow({
      pool: pool.asPgPool(),
      eventStore: events,
      allocator,
      ssh,
      secrets,
      githubHttp: passingGitHub(),
      context: ctx,
      escapeHatches: {
        maxPlannerRerunsPerSpec: 3,
        maxWriterIterPerSubtask: 5,
        maxRetriesPerTransientFailure: 3,
      },
      timeoutMs: 100,
      maxCiPolls: 1,
      sleep: async () => {},
      buildAdapters: () => adapters,
      buildUsageProbe: () => fakeProbe(healthyWindow(), accounting(null)),
      reviewProbe: approvingReview(),
      mergeProbe: noopMerge(),
    });

    expect(result.outcome.kind).toBe("passed");
    expect(events.events.filter((event) => event.eventType === "planner.rerequested")).toHaveLength(1);
    expect(pool.runStatus.outcome).toBe("ok");
  });

  it("halts on window pressure without publishing a PR", async () => {
    const { ctx, pool, events, secrets, allocator, ssh } = await setup();
    // any request would throw
    const github = new ScriptedGitHubHttp([]);

    const result = await runPlannerLoopWorkflow({
      pool: pool.asPgPool(),
      eventStore: events,
      allocator,
      ssh,
      secrets,
      githubHttp: github,
      context: ctx,
      escapeHatches: {
        maxPlannerRerunsPerSpec: 3,
        maxWriterIterPerSubtask: 5,
        maxRetriesPerTransientFailure: 3,
      },
      timeoutMs: 100,
      buildAdapters: () => twoSubtaskAdapters([passingCheck, passingCheck]),
      buildUsageProbe: () => fakeProbe(exhaustedWindow(), accounting(null)),
    });

    expect(result.outcome.kind).toBe("window_exhausted");
    expect(result.pullRequest).toBeUndefined();
    expect(pool.runStatus).toEqual({ status: "halted", outcome: "window_exhausted" });
    expect(github.requests).toHaveLength(0);
    expect(allocator.releases).toEqual(["runner_planner"]);
  });

  it("bootstraps the workspace after clone and before the writer loop on the happy path", async () => {
    const { ctx, pool, events, secrets, allocator, ssh } = await setup();
    const bootstrapCalls: string[] = [];

    await runPlannerLoopWorkflow({
      pool: pool.asPgPool(),
      eventStore: events,
      allocator,
      ssh,
      secrets,
      githubHttp: passingGitHub(),
      context: ctx,
      escapeHatches: {
        maxPlannerRerunsPerSpec: 3,
        maxWriterIterPerSubtask: 5,
        maxRetriesPerTransientFailure: 3,
      },
      timeoutMs: 100,
      maxCiPolls: 1,
      sleep: async () => {},
      bootstrapCommand: "pnpm install --frozen-lockfile",
      runBootstrap: async (input) => {
        bootstrapCalls.push(input.command ?? "<default>");
      },
      buildAdapters: () => twoSubtaskAdapters([passingCheck, passingCheck]),
      buildUsageProbe: () => fakeProbe(healthyWindow(), accounting(0.5)),
      reviewProbe: approvingReview(),
      mergeProbe: noopMerge(),
    });

    expect(bootstrapCalls).toEqual(["pnpm install --frozen-lockfile"]);
    const names = events.events.map((event) => event.eventType);
    expect(names.indexOf("workspace.prepared")).toBeLessThan(names.indexOf("writer.subtask.started"));
  });

  it("resolves the repo's tanren-ci.yml bootstrap.run and feeds it to the bootstrap step", async () => {
    const { ctx, pool, events, secrets, allocator } = await setup();
    // SSH that returns a repo tanren-ci.yml on the config read; everything else
    // (clone, etc.) succeeds with empty output. No explicit bootstrapCommand is
    // passed, so the resolver must source the command from this file.
    const ssh = new ConfigReadingSsh(
      [
        "version: 1",
        "bootstrap:",
        "  run: make deps",
        "tiers:",
        "  fast:",
        "    - name: lint",
        "      run: make lint",
        "  slow:",
        "    - name: build",
        "      run: make build",
        "when:",
        "  fast:",
        "    - per_iteration",
        "  slow:",
        "    - pre_merge",
      ].join("\n"),
    );
    const bootstrapCalls: Array<string | undefined> = [];

    await runPlannerLoopWorkflow({
      pool: pool.asPgPool(),
      eventStore: events,
      allocator,
      ssh,
      secrets,
      githubHttp: passingGitHub(),
      context: ctx,
      escapeHatches: { maxPlannerRerunsPerSpec: 3, maxWriterIterPerSubtask: 5, maxRetriesPerTransientFailure: 3 },
      timeoutMs: 100,
      maxCiPolls: 1,
      sleep: async () => {},
      runBootstrap: async (input) => {
        bootstrapCalls.push(input.command);
      },
      buildAdapters: () => twoSubtaskAdapters([passingCheck, passingCheck]),
      buildUsageProbe: () => fakeProbe(healthyWindow(), accounting(0.5)),
      reviewProbe: approvingReview(),
      mergeProbe: noopMerge(),
    });

    expect(bootstrapCalls).toEqual(["make deps"]);
  });

  it("falls back to the default bootstrap command when the repo ships no tanren-ci.yml", async () => {
    const { ctx, pool, events, secrets, allocator } = await setup();
    // Default fixture SSH returns empty output for every command, so the config
    // read yields no tanren-ci.yml → the resolver returns undefined → the
    // bootstrap step applies DEFAULT_BOOTSTRAP_COMMAND (command left undefined).
    // no config file present
    const ssh = new ConfigReadingSsh("");
    const bootstrapCalls: Array<string | undefined> = [];

    await runPlannerLoopWorkflow({
      pool: pool.asPgPool(),
      eventStore: events,
      allocator,
      ssh,
      secrets,
      githubHttp: passingGitHub(),
      context: ctx,
      escapeHatches: { maxPlannerRerunsPerSpec: 3, maxWriterIterPerSubtask: 5, maxRetriesPerTransientFailure: 3 },
      timeoutMs: 100,
      maxCiPolls: 1,
      sleep: async () => {},
      runBootstrap: async (input) => {
        bootstrapCalls.push(input.command);
      },
      buildAdapters: () => twoSubtaskAdapters([passingCheck, passingCheck]),
      buildUsageProbe: () => fakeProbe(healthyWindow(), accounting(0.5)),
      reviewProbe: approvingReview(),
      mergeProbe: noopMerge(),
    });

    // command undefined → bootstrapWorkspace would apply DEFAULT_BOOTSTRAP_COMMAND.
    expect(bootstrapCalls).toEqual([undefined]);
  });

  it("halts on a workspace bootstrap failure and surfaces it as a recoverable run", async () => {
    const { ctx, pool, events, secrets, allocator, ssh } = await setup();

    await expect(
      runPlannerLoopWorkflow({
        pool: pool.asPgPool(),
        eventStore: events,
        allocator,
        ssh,
        secrets,
        githubHttp: new ScriptedGitHubHttp([]),
        context: ctx,
        escapeHatches: {
          maxPlannerRerunsPerSpec: 3,
          maxWriterIterPerSubtask: 5,
          maxRetriesPerTransientFailure: 3,
        },
        timeoutMs: 100,
        runBootstrap: async (input) => {
          throw new WorkspaceBootstrapError(input.workspacePath, "pnpm install", 1, "vitest: not found", false);
        },
        buildAdapters: () => twoSubtaskAdapters([passingCheck, passingCheck]),
        buildUsageProbe: () => fakeProbe(healthyWindow(), accounting(null)),
      }),
    ).rejects.toBeInstanceOf(WorkspaceBootstrapError);

    expect(pool.runStatus).toEqual({ status: "halted", outcome: "halted" });
    const failure = events.events.find((event) => event.eventType === "workspace.failed");
    expect(failure?.payload).toMatchObject({
      message: expect.stringContaining("vitest: not found"),
    });
    expect(allocator.releases).toEqual(["runner_planner"]);
  });

  it("maps a Codex usage-limit thrown mid-loop to a halted window_exhausted run", async () => {
    const { ctx, pool, events, secrets, allocator, ssh } = await setup();
    const throwingPlanner: AnswererAdapter<PlanAnswer> = {
      kind: "answerer",
      cli: "codex",
      authRef: "credential/codex/dev",
      async runAnswerer() {
        throw new CodexUsageLimitError("tanren.plan_answer.v1", "You've hit your usage limit.");
      },
    };

    await expect(
      runPlannerLoopWorkflow({
        pool: pool.asPgPool(),
        eventStore: events,
        allocator,
        ssh,
        secrets,
        githubHttp: new ScriptedGitHubHttp([]),
        context: ctx,
        escapeHatches: {
          maxPlannerRerunsPerSpec: 3,
          maxWriterIterPerSubtask: 5,
          maxRetriesPerTransientFailure: 3,
        },
        timeoutMs: 100,
        buildAdapters: () => ({
          planner: throwingPlanner,
          writer: makeWriter(["d\n"]),
          checker: makeChecker([passingCheck]) as AnswererAdapter<CheckAnswer>,
          auditor: makeAuditor([passingAudit]) as AnswererAdapter<AuditAnswer>,
        }),
        buildUsageProbe: () => fakeProbe(healthyWindow(), accounting(null)),
      }),
    ).rejects.toBeInstanceOf(CodexUsageLimitError);

    expect(pool.runStatus).toEqual({ status: "halted", outcome: "window_exhausted" });
    expect(allocator.releases).toEqual(["runner_planner"]);
  });
});

// SSH fake that returns the given tanren-ci.yml text when the bootstrap-command
// resolver cats the repo config, and an empty success for every other command
// (clone, etc.). An empty `configYaml` models a repo with no tanren-ci.yml — the
// `cat`-if-present command simply prints nothing.
class ConfigReadingSsh implements SshSubstrate {
  constructor(private readonly configYaml: string) {}

  async run(_target: SshTarget, command: SshCommand): Promise<SshCommandResult> {
    const stdout = command.command.includes("tanren-ci.yml") ? this.configYaml : "";
    return { exitCode: 0, stdout, stderr: "", timedOut: false };
  }
}
