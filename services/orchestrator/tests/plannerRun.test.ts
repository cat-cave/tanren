// runPlannerLoopWorkflow integration tests. The workflow is driven with fake adapters + a fake usage
// probe (so no real SSH/Codex), asserting on the persisted run state, the PR/CI tail on a passing loop,
// the halted mapping for non-pass outcomes, and the CodexUsageLimitError → window escalation path.
// Allocator release always runs (finally). Shared fakes + builders live in plannerRun.fixtures.ts.
import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import { CodexUsageLimitError } from "../src/engine/providers/codex.js";
import { WorkspaceBootstrapError } from "../src/engine/workspace/index.js";
import {
  accounting,
  approvingReview,
  buildPlan,
  directMergeConfig,
  exhaustedWindow,
  incompleteCheck,
  fakeProbe,
  healthyWindow,
  loopStageAdapters,
  makeAuditor,
  makeChecker,
  makePlanner,
  makeWriter,
  noopMerge,
  plannerAuthorityBundle,
  plannerAuthorityHost,
  cleanAudit,
  completeCheck,
  passingGitHub,
  runPlannerLoopScoped,
  ScriptedGitHubHttp,
  setup,
  twoSubtaskAdapters,
} from "./plannerRun.fixtures.js";

describe("runPlannerLoopWorkflow", () => {
  it("drives the loop, publishes a PR, passes the native merge gate, and records a passing run", async () => {
    const { ctx, pool, events, secrets, allocator, ssh } = await setup(directMergeConfig());
    const github = passingGitHub();

    const result = await runPlannerLoopScoped({
      pool: pool.asPgPool(),
      eventStore: events,
      allocator,
      ssh,
      secrets,
      githubHttp: github,
      context: ctx,
      timeoutMs: 100,
      sleep: async () => {},
      buildAdapters: () => twoSubtaskAdapters([completeCheck, completeCheck]),
      buildUsageProbe: () => fakeProbe(healthyWindow(), accounting(0.5)),
      reviewProbe: approvingReview(),
      mergeProbe: noopMerge(),
      // direct_merge lands via the unconditional MergeAuthority (seed the in-memory host).
      mergeAuthority: plannerAuthorityBundle(plannerAuthorityHost()),
    });

    expect(result.outcome.kind).toBe("passed");
    expect(result.pullRequest?.prNumber).toBe(7);
    // The native merge gate (the merge authority) passed — no forge CI poll.
    expect(result.mergeGate?.passed).toBe(true);
    expect(pool.runStatus).toEqual({ status: "completed", outcome: "ok" });
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

  it("re-iterates the writer on a checker incompleteness and still completes (medium-tier loop shape)", async () => {
    const { ctx, pool, events, secrets, allocator, ssh } = await setup(directMergeConfig());
    // SPEC-LOOP REDESIGN: a checker incompleteness loops back to the WRITER (not the planner). The first
    // subtask's checker reports incomplete once, then complete; the writer re-iterates IN-TASK (no re-plan).
    const adapters = {
      planner: makePlanner([
        buildPlan([
          { title: "T1", intent: "ok", behaviorIds: [] },
          { title: "T2", intent: "fail", behaviorIds: [] },
        ]),
      ]) as AnswererAdapter<PlanAnswer>,
      writer: makeWriter(["d1\n", "d2\n", "d3\n"]),
      checker: makeChecker([incompleteCheck, completeCheck, completeCheck]) as AnswererAdapter<CheckAnswer>,
      auditor: makeAuditor([cleanAudit]) as AnswererAdapter<AuditAnswer>,
      ...loopStageAdapters(),
    };

    const result = await runPlannerLoopScoped({
      pool: pool.asPgPool(),
      eventStore: events,
      allocator,
      ssh,
      secrets,
      githubHttp: passingGitHub(),
      context: ctx,
      timeoutMs: 100,
      sleep: async () => {},
      buildAdapters: () => adapters,
      buildUsageProbe: () => fakeProbe(healthyWindow(), accounting(null)),
      reviewProbe: approvingReview(),
      mergeProbe: noopMerge(),
      // direct_merge lands via the unconditional MergeAuthority (seed the in-memory host).
      mergeAuthority: plannerAuthorityBundle(plannerAuthorityHost()),
    });

    expect(result.outcome.kind).toBe("passed");
    // The checker incompleteness re-ran the WRITER in-task — never re-planned.
    expect(events.events.filter((event) => event.eventType === "planner.rerequested")).toHaveLength(0);
    expect(pool.runStatus.outcome).toBe("ok");
  });

  it("PAUSES on window pressure (task #82 — NEW non-terminal status, not halted) without publishing a PR", async () => {
    const { ctx, pool, events, secrets, allocator, ssh } = await setup();
    // any request would throw
    const github = new ScriptedGitHubHttp([]);

    const result = await runPlannerLoopScoped({
      pool: pool.asPgPool(),
      eventStore: events,
      allocator,
      ssh,
      secrets,
      githubHttp: github,
      context: ctx,
      timeoutMs: 100,
      buildAdapters: () => twoSubtaskAdapters([completeCheck, completeCheck]),
      buildUsageProbe: () => fakeProbe(exhaustedWindow(), accounting(null)),
    });

    expect(result.outcome.kind).toBe("window_exhausted");
    expect(result.pullRequest).toBeUndefined();
    // task #82: window pressure flips the run to the NEW non-terminal `paused`
    // status (outcome `window_paused`) instead of `halted` — the background
    // prober owns the resume (spec stays `in_flight`, no successor enqueue).
    expect(pool.runStatus).toEqual({ status: "paused", outcome: "window_paused" });
    // No PR/CI/merge request was made. The ONLY GitHub call is the authenticated clone's MERGE-SAFETY
    // identity read (`GET /user`), during clone before the window-pressure pause; everything else skipped.
    expect(github.requests.filter((r) => !(r.method === "GET" && r.path.startsWith("/user")))).toHaveLength(0);
    expect(allocator.releases).toEqual(["runner_planner"]);
  });

  it("bootstraps the workspace after clone and before the writer loop on the happy path", async () => {
    const { ctx, pool, events, secrets, allocator, ssh } = await setup();
    const bootstrapCalls: string[] = [];

    await runPlannerLoopScoped({
      pool: pool.asPgPool(),
      eventStore: events,
      allocator,
      ssh,
      secrets,
      githubHttp: passingGitHub(),
      context: ctx,
      timeoutMs: 100,
      sleep: async () => {},
      bootstrapCommand: "just bootstrap",
      runBootstrap: async (input) => {
        bootstrapCalls.push(input.command ?? "<default>");
      },
      buildAdapters: () => twoSubtaskAdapters([completeCheck, completeCheck]),
      buildUsageProbe: () => fakeProbe(healthyWindow(), accounting(0.5)),
      reviewProbe: approvingReview(),
      mergeProbe: noopMerge(),
    });

    expect(bootstrapCalls).toEqual(["just bootstrap"]);
    const names = events.events.map((event) => event.eventType);
    expect(names.indexOf("workspace.prepared")).toBeLessThan(names.indexOf("writer.subtask.started"));
  });

  it("commits the bootstrap state after bootstrap and before the writer loop", async () => {
    const { ctx, pool, events, secrets, allocator, ssh } = await setup();
    const order: string[] = [];

    await runPlannerLoopScoped({
      pool: pool.asPgPool(),
      eventStore: events,
      allocator,
      ssh,
      secrets,
      githubHttp: passingGitHub(),
      context: ctx,
      timeoutMs: 100,
      sleep: async () => {},
      runBootstrap: async () => {
        order.push("bootstrap");
      },
      // The synthetic post-bootstrap commit; its sha is what the writer diffs
      // against. The fake writers ignore baseSha, so we only assert ordering here.
      commitBootstrap: async () => {
        order.push("commit-bootstrap");
        return "b".repeat(40);
      },
      buildAdapters: () => twoSubtaskAdapters([completeCheck, completeCheck]),
      buildUsageProbe: () => fakeProbe(healthyWindow(), accounting(0.5)),
      reviewProbe: approvingReview(),
      mergeProbe: noopMerge(),
    });

    // Bootstrap install runs first, THEN its state is committed (the writer's diff base), THEN the writer loop runs.
    expect(order).toEqual(["bootstrap", "commit-bootstrap"]);
    const names = events.events.map((event) => event.eventType);
    expect(names.indexOf("workspace.prepared")).toBeLessThan(names.indexOf("writer.subtask.started"));
  });

  it("threads the post-bootstrap commit as the writer's diff base and pushes the cleaned PR ref", async () => {
    const { ctx, pool, events, secrets, allocator } = await setup();
    const cloneHead = "1".repeat(40);
    const bootstrapSha = "2".repeat(40);
    // SSH that returns the clone HEAD on the workspace-prep rev-parse and records
    // every command so the PR push refspec can be inspected.
    const ssh = new CloneHeadSsh(cloneHead);
    const writerBaseShas: Array<string | undefined> = [];
    const recordingWriter = {
      kind: "writer" as const,
      cli: "fake",
      authRef: "credential/codex/dev",
      async runWriter(opts: { prompt: string; workspace: string; timeoutMs: number; baseSha?: string }) {
        writerBaseShas.push(opts.baseSha);
        return {
          diff: "diff ok\n",
          commits: [{ sha: "a".repeat(40), message: "writer" }],
          exitReason: "completed" as const,
          tokenUsage: {
            inputTokens: 1,
            cachedInputTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: 1,
            reasoningOutputTokens: 0,
            totalTokens: 2,
          },
        };
      },
    };

    await runPlannerLoopScoped({
      pool: pool.asPgPool(),
      eventStore: events,
      allocator,
      ssh,
      secrets,
      githubHttp: passingGitHub(),
      context: ctx,
      timeoutMs: 100,
      sleep: async () => {},
      runBootstrap: async () => {},
      // The post-bootstrap commit sha — what the writer must diff against.
      commitBootstrap: async () => bootstrapSha,
      buildAdapters: () => ({
        planner: makePlanner([buildPlan([{ title: "T1", intent: "ok", behaviorIds: [] }])]) as never,
        writer: recordingWriter,
        checker: makeChecker([completeCheck]) as never,
        auditor: makeAuditor([cleanAudit]) as never,
        ...loopStageAdapters(),
      }),
      buildUsageProbe: () => fakeProbe(healthyWindow(), accounting(0.5)),
      reviewProbe: approvingReview(),
      mergeProbe: noopMerge(),
    });

    // The writer diffs against the POST-BOOTSTRAP commit, not the clone HEAD.
    expect(writerBaseShas).toEqual([bootstrapSha]);
    // The PR branch is the direct-overlay composed commit (apex v85): cloneHead +
    // (writer − bootstrap), parented on cloneHead — bootstrap artifacts dropped, no rebase.
    const cleanPrep = ssh.commands.find((c) => c.includes("git read-tree") && c.includes("git commit-tree"));
    expect(cleanPrep).toContain(`git read-tree '${cloneHead}'`);
    expect(cleanPrep).toContain(`git diff-tree -r --name-status --no-renames '${bootstrapSha}' HEAD`);
    expect(cleanPrep).toContain(`git commit-tree "$clean_tree" -p '${cloneHead}'`);
    expect(cleanPrep).not.toContain("git rebase");
    const push = ssh.commands.find((c) => c.includes("git push"));
    expect(push).toContain("refs/tanren/pr-clean:refs/heads/");
  });

  it("resolves the repo's .tanren/ci.yml bootstrap.run and feeds it to the bootstrap step", async () => {
    const { ctx, pool, events, secrets, allocator } = await setup();
    // SSH that returns a repo .tanren/ci.yml on the config read; everything else
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
        // apex v57 task #64: a tier mapped to pre_merge MUST declare positive evidence
        // (the schema validator rejects a vacuous merge gate). `junitReport` is the legacy
        // back-compat path → promotes to a junit-evidence contract with `minTests: 1`; the
        // ConfigReadingSsh returns a one-test JUnit XML on the harvester's read so the gate passes.
        "      junitReport: reports/junit.xml",
        "when:",
        "  fast:",
        "    - per_iteration",
        "  slow:",
        "    - pre_merge",
      ].join("\n"),
    );
    const bootstrapCalls: Array<string | undefined> = [];

    await runPlannerLoopScoped({
      pool: pool.asPgPool(),
      eventStore: events,
      allocator,
      ssh,
      secrets,
      githubHttp: passingGitHub(),
      context: ctx,
      timeoutMs: 100,
      sleep: async () => {},
      runBootstrap: async (input) => {
        bootstrapCalls.push(input.command);
      },
      buildAdapters: () => twoSubtaskAdapters([completeCheck, completeCheck]),
      buildUsageProbe: () => fakeProbe(healthyWindow(), accounting(0.5)),
      reviewProbe: approvingReview(),
      mergeProbe: noopMerge(),
    });

    expect(bootstrapCalls).toEqual(["make deps"]);
  });

  it("falls back to the default bootstrap command when the repo ships no .tanren/ci.yml", async () => {
    const { ctx, pool, events, secrets, allocator } = await setup();
    // Default fixture SSH returns empty output for every command, so the config read yields no
    // .tanren/ci.yml → the resolver returns undefined → the bootstrap step applies
    // DEFAULT_BOOTSTRAP_COMMAND (command left undefined; no config file present).
    const ssh = new ConfigReadingSsh("");
    const bootstrapCalls: Array<string | undefined> = [];

    await runPlannerLoopScoped({
      pool: pool.asPgPool(),
      eventStore: events,
      allocator,
      ssh,
      secrets,
      githubHttp: passingGitHub(),
      context: ctx,
      timeoutMs: 100,
      sleep: async () => {},
      runBootstrap: async (input) => {
        bootstrapCalls.push(input.command);
      },
      buildAdapters: () => twoSubtaskAdapters([completeCheck, completeCheck]),
      buildUsageProbe: () => fakeProbe(healthyWindow(), accounting(0.5)),
      reviewProbe: approvingReview(),
      mergeProbe: noopMerge(),
    });

    // command undefined → bootstrapWorkspace would apply DEFAULT_BOOTSTRAP_COMMAND.
    expect(bootstrapCalls).toEqual([undefined]);
  });

  it("SELF-HEALS a workspace-PREP bootstrap failure: defers to the gate, does NOT strand the spec (apex v35)", async () => {
    // apex v35 (mirroring #562's gate-bootstrap self-heal): a writer-fixable PREP bootstrap
    // failure is DEFERRED to the gate's self-healing path (a loud `workspace.bootstrap_deferred`,
    // the writer loop proceeds) instead of escaping → workspace.failed → stranding the spec.
    const { ctx, pool, events, secrets, allocator, ssh } = await setup();

    await runPlannerLoopScoped({
      pool: pool.asPgPool(),
      eventStore: events,
      allocator,
      ssh,
      secrets,
      githubHttp: passingGitHub(),
      context: ctx,
      timeoutMs: 100,
      sleep: async () => {},
      runBootstrap: async (input) => {
        throw new WorkspaceBootstrapError(input.workspacePath, "just bootstrap", 1, "tier-1 tool: not found", false);
      },
      buildAdapters: () => twoSubtaskAdapters([completeCheck, completeCheck]),
      buildUsageProbe: () => fakeProbe(healthyWindow(), accounting(0.5)),
      reviewProbe: approvingReview(),
      mergeProbe: noopMerge(),
    });

    // The deferral is recorded LOUDLY, carrying the (prelude-free) bootstrap output.
    const deferred = events.events.find((event) => event.eventType === "workspace.bootstrap_deferred");
    expect(deferred?.payload).toMatchObject({
      command: "just bootstrap",
      exitCode: 1,
      timedOut: false,
      outputTail: expect.stringContaining("tier-1 tool: not found"),
    });
    // NOT the old terminal strand: no workspace.failed, and the writer loop ran (after the defer).
    expect(events.events.some((event) => event.eventType === "workspace.failed")).toBe(false);
    const names = events.events.map((event) => event.eventType);
    expect(names).toContain("writer.subtask.started");
    expect(names.indexOf("workspace.bootstrap_deferred")).toBeLessThan(names.indexOf("writer.subtask.started"));
    expect(allocator.releases).toEqual(["runner_planner"]);
  });

  it("PAUSES a Codex usage-limit thrown mid-loop (task #82 — pause_for_capacity bucket, NOT a re-drive; spec stays in_flight)", async () => {
    const { ctx, pool, events, secrets, allocator, ssh } = await setup();
    const throwingPlanner: AnswererAdapter<PlanAnswer> = {
      kind: "answerer",
      cli: "codex",
      authRef: "credential/codex/dev",
      async runAnswerer() {
        throw new CodexUsageLimitError("tanren.plan_answer.v1", "You've hit your usage limit.");
      },
    };

    // task #82 — window-pause auto-resume: a usage-limit is TRANSIENT WINDOW PRESSURE ⇒
    // route to the NEW `pause_for_capacity` bucket, NOT re-drive. The run flips to the
    // non-terminal `paused` status (outcome `window_paused`), the spec stays `in_flight`
    // (no `dag.spec.redriven`), and the workflow returns NORMALLY (no throw). The
    // background prober owns the resume when capacity returns.
    const run = runPlannerLoopScoped({
      pool: pool.asPgPool(),
      eventStore: events,
      allocator,
      ssh,
      secrets,
      githubHttp: new ScriptedGitHubHttp([]),
      context: ctx,
      timeoutMs: 100,
      buildAdapters: () => ({
        planner: throwingPlanner,
        writer: makeWriter(["d\n"]),
        checker: makeChecker([completeCheck]) as AnswererAdapter<CheckAnswer>,
        auditor: makeAuditor([cleanAudit]) as AnswererAdapter<AuditAnswer>,
        ...loopStageAdapters(),
      }),
      buildUsageProbe: () => fakeProbe(healthyWindow(), accounting(null)),
    });
    // PAUSE-FOR-CAPACITY returns NORMALLY (no throw, treated like re-drive).
    const result = await run;
    expect(result.reDriven).toBe(true);
    expect(pool.runStatus).toEqual({ status: "paused", outcome: "window_paused" });
    // Spec stays `in_flight` (no `open` flip, no `dag.spec.redriven`) — the prober owns resume.
    expect(pool.specStatuses.at(-1)).not.toBe("open");
    expect(events.events.find((e) => e.eventType === "dag.spec.redriven")).toBeUndefined();
    const paused = events.events.find((e) => e.eventType === "run.paused");
    expect(paused?.payload).toMatchObject({ usedPercent: 100 });
    expect(allocator.releases).toEqual(["runner_planner"]);
  });
});

// Minimal valid one-test JUnit XML the runtime gate's evidence harvester accepts as
// `total: 1` — passes the default-config's `minTests: 1` evidence contract on
// pre_audit/pre_merge (apex v57 task #64). The harvester's workspace-file read script
// (`if [ -f X ]; then cat X; else echo __TANREN_FILE_ABSENT__; fi`) is uniquely
// identifiable by the marker sentinel, so non-harvest commands never match.
const PASSING_JUNIT_XML =
  '<?xml version="1.0"?><testsuites><testsuite name="t"><testcase name="ok"/></testsuite></testsuites>';
function isJunitHarvestRead(command: string): boolean {
  return command.includes("__TANREN_FILE_ABSENT__");
}

// SSH fake that returns the given .tanren/ci.yml text when the bootstrap-command resolver cats the repo
// config, an empty success for every other command (clone, etc.), and a valid one-test JUnit XML when
// the runtime gate's evidence harvester reads the JUnit report path (so the v57 evidence gate passes
// instead of the writer looping forever on evidence_insufficient). An empty `configYaml` models a repo
// with no .tanren/ci.yml — the `cat`-if-present command simply prints nothing.
class ConfigReadingSsh implements CommandSubstrate {
  constructor(private readonly configYaml: string) {}

  async run(_target: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    if (isJunitHarvestRead(command.command)) {
      return { exitCode: 0, stdout: PASSING_JUNIT_XML, stderr: "", timedOut: false };
    }
    const stdout = command.command.includes(".tanren/ci.yml") ? this.configYaml : "";
    return { exitCode: 0, stdout, stderr: "", timedOut: false };
  }
}

// SSH fake that returns the clone HEAD sha on the workspace-prep `git rev-parse`
// (so the run captures a real cloneHeadSha and the PR-branch cleanup actually
// runs), a valid one-test JUnit XML when the runtime gate's evidence harvester reads
// the JUnit report path (apex v57 task #64), empty for everything else, and records
// every command issued.
class CloneHeadSsh implements CommandSubstrate {
  readonly commands: string[] = [];

  constructor(private readonly cloneHead: string) {}

  async run(_target: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push(command.command);
    if (isJunitHarvestRead(command.command)) {
      return { exitCode: 0, stdout: PASSING_JUNIT_XML, stderr: "", timedOut: false };
    }
    const isClonePrep = command.command.includes("git clone") && command.command.includes("git rev-parse HEAD");
    return { exitCode: 0, stdout: isClonePrep ? `${this.cloneHead}\n` : "", stderr: "", timedOut: false };
  }
}
