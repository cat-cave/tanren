import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../src/engine/contracts/commandSubstrate.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../src/engine/providers/github.js";
import { publishDraftPullRequest } from "../src/engine/workflow/githubDraftPr.js";
import { readDraftPrPushLease } from "../src/engine/workflow/githubDraftPrLease.js";
import { buildGitHubPushCommand } from "../src/engine/workspace/githubPush.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import { RecordingPool, ScriptedGitHubHttp } from "./helpers/githubDraftPrFakes.js";

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

class RefResponseHttp implements GitHubHttpClient {
  constructor(private readonly response: GitHubHttpResponse) {}

  async request(input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    if (input.path !== "/repos/cat-cave/repo/git/ref/heads/tanren%2Frun_123") {
      throw new Error(`unexpected GitHub request: ${input.path}`);
    }
    return this.response;
  }
}

describe("#1069 draft publication lease", () => {
  it("uses an explicit empty expected-sha lease for a proven-absent first branch", () => {
    expect(
      buildGitHubPushCommand({
        repoUrl: "https://github.com/cat-cave/repo.git",
        branch: "tanren/run_123",
        forceWithLease: { expectedAbsent: true },
      }),
    ).toContain("--force-with-lease=refs/heads/tanren/run_123:");
  });

  it("retains the exact existing-head SHA instead of treating every ref as absent", async () => {
    await expect(
      readDraftPrPushLease(
        new RefResponseHttp({ status: 200, body: { object: { sha: fetched } } }),
        { owner: "cat-cave", name: "repo" },
        "tanren/run_123",
        "ghp_secret",
      ),
    ).resolves.toEqual({ expectedSha: fetched });
  });

  it.each([
    ["malformed 200", { status: 200, body: { object: { sha: "not-a-sha" } } }],
    ["forbidden", { status: 403, body: { message: "Forbidden" } }],
  ])("fails closed for a %s ref response", async (_name, response) => {
    await expect(
      readDraftPrPushLease(
        new RefResponseHttp(response),
        { owner: "cat-cave", name: "repo" },
        "tanren/run_123",
        "ghp_secret",
      ),
    ).rejects.toThrow("GitHub draft branch read failed");
  });

  it("does not let an undeclared ref read bypass an ordered fixture queue", async () => {
    await expect(
      new ScriptedGitHubHttp([], []).request({
        method: "GET",
        path: "/repos/cat-cave/repo/git/ref/heads/tanren%2Funexpected",
        token: "ghp_secret",
      }),
    ).rejects.toThrow("unexpected GitHub request");
  });

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

  it("rejects a remote change seen before the exact ref read without push or PR publication", async () => {
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: "credential/github/org/org_fake/dev", value: "ghp_secret" });
    const ssh = new LeaseRaceSsh();
    const http = new RefResponseHttp({ status: 200, body: { object: { sha: concurrent } } });
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
        expectedPublishedHeadSha: fetched,
      }),
    ).rejects.toThrow("changed since workspace rework");

    expect(ssh.commands).toHaveLength(0);
    expect(events.events.map((event) => event.eventType)).toEqual([
      "credential.requested",
      "credential.loaded",
      "github.failed",
    ]);
  });

  it("uses the pre-rework published head for a stateful repeat publication", async () => {
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: "credential/github/org/org_fake/dev", value: "ghp_secret" });
    const ssh = new LeaseRaceSsh();
    const http = new ScriptedGitHubHttp([
      { status: 200, body: [] },
      {
        status: 201,
        body: { number: 9, html_url: "https://github.com/cat-cave/repo/pull/9", draft: true, base: { ref: "main" } },
      },
      { status: 200, body: { object: { sha: fetched } } },
      {
        status: 200,
        body: [{ number: 9, html_url: "https://github.com/cat-cave/repo/pull/9", draft: true, base: { ref: "main" } }],
      },
    ]);
    const input = (expectedPublishedHeadSha?: string) => ({
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
      title: "lease test",
      githubCredentialRef: "credential/github/org/org_fake/dev",
      ...(expectedPublishedHeadSha === undefined ? {} : { expectedPublishedHeadSha }),
    });

    await publishDraftPullRequest(input());
    await publishDraftPullRequest(input(fetched));

    const refReads = http.requests.filter((request) => request.path.endsWith("/git/ref/heads/tanren%2Frun_123"));
    expect(refReads).toHaveLength(2);
    expect(ssh.commands[0]?.command).toContain("--force-with-lease=refs/heads/tanren/run_123:");
    expect(ssh.commands[1]?.command).toContain(`--force-with-lease=refs/heads/tanren/run_123:${fetched}`);
  });
});
