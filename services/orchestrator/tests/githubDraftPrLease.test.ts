import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../src/engine/contracts/commandSubstrate.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../src/engine/providers/github.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import { RecordingPool } from "./helpers/githubDraftPrFakes.js";
import { publishDraftPullRequest } from "../src/engine/workflow/githubDraftPr.js";

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};

class LeaseRaceSsh implements CommandSubstrate {
  public readonly commands: RunnerCommand[] = [];

  public constructor(public remoteHead: string) {}

  public async run(_target: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push(command);
    const match = /--force-with-lease=refs\/heads\/[^:]+:([0-9a-f]{40})/u.exec(command.command);
    if (match?.[1] !== this.remoteHead) {
      return { exitCode: 1, stdout: "", stderr: "stale info: remote ref updated" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

class RefRaceHttp implements GitHubHttpClient {
  public readonly requests: GitHubHttpRequest[] = [];

  public constructor(
    private readonly fetchedHead: string,
    private readonly ssh: LeaseRaceSsh,
    private readonly concurrentHead: string,
  ) {}

  public async request(input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    this.requests.push({ ...input, token: "<redacted>" });
    if (input.path.includes("/git/ref/heads/")) {
      this.ssh.remoteHead = this.concurrentHead;
      return { status: 200, body: { object: { sha: this.fetchedHead } } };
    }
    throw new Error(`unexpected GitHub request after lease rejection: ${input.method} ${input.path}`);
  }
}

describe("draft PR publication lease", () => {
  it("#1069 rejects a rework when its fetched remote head moved and never constructs a blind force push", async () => {
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: "credential/github/org/org_fake/dev", value: "ghp_secretToken" });
    const fetchedHead = "a".repeat(40);
    const concurrentHead = "b".repeat(40);
    const ssh = new LeaseRaceSsh(fetchedHead);
    const http = new RefRaceHttp(fetchedHead, ssh, concurrentHead);

    await expect(
      publishDraftPullRequest({
        pool: new RecordingPool().asPgPool(),
        eventStore: new FakeEventStore(),
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
        runBranch: "tanren/run_123",
        title: "Tanren run run_123",
        githubCredentialRef: "credential/github/org/org_fake/dev",
      }),
    ).rejects.toThrow("push workspace branch to GitHub failed");

    expect(ssh.remoteHead).toBe(concurrentHead);
    const command = ssh.commands[0]?.command ?? "";
    expect(command).toContain(`--force-with-lease=refs/heads/tanren/run_123:${fetchedHead}`);
    expect(command).not.toContain("git push --force ");
    expect(http.requests.map((request) => request.path)).toEqual([
      "/repos/cat-cave/repo/git/ref/heads/tanren%2Frun_123",
    ]);
  });
});
