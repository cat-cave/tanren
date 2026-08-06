import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../src/engine/contracts/commandSubstrate.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { publishCleanedDraftPr } from "../src/engine/workflow/plannerRunCi.js";
import type { PlannerRunContext, RunPlannerLoopInput } from "../src/engine/workflow/plannerRun.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import { RecordingPool, ScriptedGitHubHttp } from "./helpers/githubDraftPrFakes.js";

const CLEAN_SHA = "c".repeat(40);
const MOVED_REF_SHA = "d".repeat(40);
const target = { backend: "ssh", host: "runner", port: 22, username: "tanren" } as RunnerHandle;

class CleanThenMoveRefSsh implements CommandSubstrate {
  readonly commands: RunnerCommand[] = [];
  cleanRefSha = CLEAN_SHA;
  headSha = CLEAN_SHA;
  pushedSha: string | undefined;

  async run(_target: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push(command);
    if (command.command.includes("git write-tree")) {
      // The compose step resolved PR_CLEAN_REF to CLEAN_SHA, then the mutable
      // refs advance before the later publish command is evaluated.
      this.cleanRefSha = MOVED_REF_SHA;
      this.headSha = MOVED_REF_SHA;
      return { exitCode: 0, stdout: `${CLEAN_SHA}\n`, stderr: "", timedOut: false };
    }
    if (command.command.includes("git push")) {
      this.pushedSha = command.command.includes(CLEAN_SHA)
        ? CLEAN_SHA
        : command.command.includes("refs/tanren/clean")
          ? this.cleanRefSha
          : this.headSha;
    }
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  }
}

describe("planner draft publication source binding", () => {
  it("pushes and witnesses the captured cleaned SHA after the cleaned ref and HEAD move", async () => {
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: "credential/github/org/org_fake/dev", value: "ghp_test" });
    const ssh = new CleanThenMoveRefSsh();
    const events = new FakeEventStore();
    const http = new ScriptedGitHubHttp([
      { status: 200, body: [] },
      {
        status: 201,
        body: { number: 1, html_url: "https://github.com/cat-cave/repo/pull/1", draft: true, base: { ref: "main" } },
      },
    ]);
    const input = {
      pool: new RecordingPool().asPgPool(),
      secrets,
      githubHttp: http,
      ssh,
    } as unknown as RunPlannerLoopInput;
    const context = {
      runId: "run_123",
      specId: "spec_123",
      projectId: "project_123",
      orgId: "org_fake",
      repoUrl: "https://github.com/cat-cave/repo.git",
      targetBranch: "main",
      runBranch: "tanren/run_123",
      specTitle: "lease test",
      specDescription: "",
      githubCredentialRef: "credential/github/org/org_fake/dev",
    } as PlannerRunContext;

    await publishCleanedDraftPr(
      input,
      { target, workspacePath: "/workspace/runs/run_123/repo", eventStore: events },
      context,
      { cloneHeadSha: "a".repeat(40), bootstrapSha: "b".repeat(40) },
    );

    const push = ssh.commands.find((command) => command.command.includes("git push"))?.command ?? "";
    expect(ssh.cleanRefSha).toBe(MOVED_REF_SHA);
    expect(ssh.headSha).toBe(MOVED_REF_SHA);
    expect(push).toContain(`${CLEAN_SHA}:refs/heads/tanren/run_123`);
    expect(push).not.toContain(`HEAD:refs/heads/tanren/run_123`);
    expect(push).not.toContain(`${MOVED_REF_SHA}:refs/heads/tanren/run_123`);
    expect(ssh.pushedSha).toBe(CLEAN_SHA);
    expect(events.events.find((event) => event.eventType === "github.branch.pushed")?.payload).toMatchObject({
      headSha: CLEAN_SHA,
    });
  });
});
