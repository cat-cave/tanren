import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../src/engine/contracts/commandSubstrate.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../src/engine/providers/github.js";
import { publishDraftPullRequest } from "../src/engine/workflow/githubDraftPr.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import { RecordingPool } from "./helpers/githubDraftPrFakes.js";

const target: RunnerHandle = { backend: "ssh", host: "runner", port: 22, username: "tanren" } as RunnerHandle;
const fetched = "a".repeat(40);
const concurrent = "b".repeat(40);

class LeaseRaceSsh implements CommandSubstrate {
  remoteHead = fetched;
  commands: RunnerCommand[] = [];

  async run(_target: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push(command);
    // This fake is the authoritative remote push behavior: the branch changes
    // after the GET and before git executes. A matching lease must reject, never
    // overwrite the reviewer's commit or permit later PR publication.
    const leasesFetched = command.command.includes(`--force-with-lease=refs/heads/tanren/run_123:${fetched}`);
    return leasesFetched && this.remoteHead !== fetched
      ? { exitCode: 1, stdout: "", stderr: "! [rejected] stale info", timedOut: false }
      : { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  }
}

class RefThenRaceHttp implements GitHubHttpClient {
  requests: GitHubHttpRequest[] = [];
  constructor(private readonly ssh: LeaseRaceSsh) {}

  async request(input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    this.requests.push(input);
    if (input.path.includes("/git/ref/heads/")) {
      this.ssh.remoteHead = concurrent;
      return { status: 200, body: { object: { sha: fetched } } };
    }
    throw new Error(`PR API must not be called after rejected publish: ${input.path}`);
  }
}

describe("#1069 draft publication lease", () => {
  it("rejects a changed remote head without overwriting it or falsely publishing the PR", async () => {
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: "credential/github/org/org_fake/dev", value: "ghp_secret" });
    const ssh = new LeaseRaceSsh();
    const http = new RefThenRaceHttp(ssh);
    const events = new FakeEventStore();

    await expect(
      publishDraftPullRequest({
        pool: new RecordingPool().asPgPool(),
        eventStore: events,
        secrets,
        githubHttp: http,
        ssh,
        target,
        runId: "run_123",
        specId: "spec_123",
        projectId: "project_123",
        appendEventOrgId: "org_fake",
        workspacePath: "/workspace/runs/run_123/repo",
        repoUrl: "https://github.com/cat-cave/repo.git",
        targetBranch: "main",
        title: "lease test",
        githubCredentialRef: "credential/github/org/org_fake/dev",
      }),
    ).rejects.toThrow("push workspace branch to GitHub failed");

    expect(ssh.remoteHead).toBe(concurrent);
    expect(ssh.commands[0]?.command).toContain(`--force-with-lease=refs/heads/tanren/run_123:${fetched}`);
    expect(ssh.commands[0]?.command).not.toMatch(/(?:^|\s)--force(?:\s|$)/u);
    expect(events.events.map((event) => event.eventType)).toEqual([
      "credential.requested",
      "credential.loaded",
      "github.failed",
    ]);
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]).toMatchObject({ retryTransient: false, retryRateLimit: false });
  });
});
