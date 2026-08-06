import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../src/engine/contracts/commandSubstrate.js";
import {
  accounting,
  approvingReview,
  buildPlan,
  cleanAudit,
  cleanHeadStdout,
  completeCheck,
  fakeProbe,
  healthyWindow,
  loopStageAdapters,
  makeAuditor,
  makeChecker,
  makePlanner,
  noopMerge,
  passingGitHub,
  runPlannerLoopScoped,
  setup,
} from "./plannerRun.fixtures.js";

const PASSING_JUNIT_XML =
  '<?xml version="1.0"?><testsuites><testsuite name="t"><testcase name="ok"/></testsuite></testsuites>';

function isJunitHarvestRead(command: string): boolean {
  return command.includes("__TANREN_FILE_ABSENT__");
}

class CloneHeadSsh implements CommandSubstrate {
  readonly commands: string[] = [];

  constructor(private readonly cloneHead: string) {}

  async run(_target: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push(command.command);
    if (isJunitHarvestRead(command.command)) {
      return { exitCode: 0, stdout: PASSING_JUNIT_XML, stderr: "", timedOut: false };
    }
    return { exitCode: 0, stdout: cleanHeadStdout(command.command, this.cloneHead), stderr: "", timedOut: false };
  }
}

describe("planner immutable cleaned-PR publication", () => {
  it("threads the post-bootstrap commit as writer base and pushes the resolved cleaned SHA", async () => {
    const { ctx, pool, events, secrets, allocator } = await setup();
    const cloneHead = "1".repeat(40);
    const bootstrapSha = "2".repeat(40);
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

    expect(writerBaseShas).toEqual([bootstrapSha]);
    const cleanPrep = ssh.commands.find(
      (command) => command.includes("git read-tree") && command.includes("git commit-tree"),
    );
    expect(cleanPrep).toContain(`git read-tree '${cloneHead}'`);
    expect(cleanPrep).toContain(`git diff-tree -r --name-status --no-renames '${bootstrapSha}' HEAD`);
    expect(cleanPrep).toContain(`git commit-tree "$clean_tree" -p '${cloneHead}'`);
    expect(cleanPrep).not.toContain("git rebase");
    const push = ssh.commands.find((command) => command.includes("git push"));
    expect(push).toContain(`${cloneHead}:refs/heads/${ctx.runBranch}`);
    expect(push).not.toContain("refs/tanren/pr-clean:refs/heads/");
    expect(push).toContain(`--force-with-lease=refs/heads/${ctx.runBranch}:`);
  });
});
