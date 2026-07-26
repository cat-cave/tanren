import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../src/engine/contracts/commandSubstrate.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../src/engine/providers/github.js";
import { publishDraftPullRequest, publishDraftPullRequestForRun } from "../src/engine/workflow/githubDraftPr.js";
import { readDraftPrPushLease, readDurableDraftPrPublishedHead } from "../src/engine/workflow/githubDraftPrLease.js";
import { buildGitHubPushCommand } from "../src/engine/workspace/githubPush.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import { RecordingPool, ScriptedGitHubHttp } from "./helpers/githubDraftPrFakes.js";
import {
  ManualPublicationSsh,
  ManualRouteDurableHeadPool,
  PersistingManualEventStore,
} from "./helpers/githubDraftPrManualLeaseFixtures.js";

const target: RunnerHandle = { backend: "ssh", host: "runner", port: 22, username: "tanren" } as RunnerHandle;
const fetched = "a".repeat(40);
const concurrent = "b".repeat(40);
const reworked = "c".repeat(40);

class DurableHeadPool {
  constructor(private readonly rows: readonly unknown[]) {}

  async query(_sql: string, _params: readonly unknown[]) {
    return { rows: this.rows };
  }
}

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
  readonly requests: GitHubHttpRequest[] = [];
  constructor(private readonly response: GitHubHttpResponse) {}

  async request(input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    this.requests.push(input);
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

  it("retains the exact existing-head SHA only with a durable witness", async () => {
    await expect(
      readDraftPrPushLease(
        new RefResponseHttp({ status: 200, body: { object: { sha: fetched } } }),
        { owner: "cat-cave", name: "repo" },
        "tanren/run_123",
        "ghp_secret",
        fetched,
      ),
    ).resolves.toEqual({ expectedSha: fetched });
  });

  it("rejects an existing remote branch without a durable witness before SSH or PR publication", async () => {
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: "credential/github/org/org_fake/dev", value: "ghp_secret" });
    const ssh = new LeaseRaceSsh();
    const http = new RefResponseHttp({ status: 200, body: { object: { sha: fetched } } });

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
        title: "lease test",
        githubCredentialRef: "credential/github/org/org_fake/dev",
      }),
    ).rejects.toThrow("exists without a durable published-head witness");

    expect(ssh.commands).toHaveLength(0);
    expect(http.requests).toHaveLength(1);
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

  it("rejects a malformed durable prior published head before any re-drive push or PR call", async () => {
    const pool = new DurableHeadPool([{ payload: { headSha: "not-a-sha" } }]);
    await expect(
      readDurableDraftPrPublishedHead(pool, {
        orgId: "org_fake",
        specId: "spec_123",
        branch: "tanren/run_123",
      }),
    ).rejects.toThrow("durable published head is invalid");
  });

  it("rejects a malformed cleaned published head before it can clear a prior lease", async () => {
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: "credential/github/org/org_fake/dev", value: "ghp_secret" });
    const ssh = new LeaseRaceSsh();
    const http = new RefResponseHttp({ status: 200, body: { object: { sha: fetched } } });
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
        title: "lease test",
        publishedHeadSha: "malformed",
        githubCredentialRef: "credential/github/org/org_fake/dev",
        expectedPublishedHeadSha: fetched,
      }),
    ).rejects.toThrow("published head is invalid");
    expect(ssh.commands).toHaveLength(0);
    expect(http.requests).toHaveLength(0);
  });

  it("rejects a mismatched immutable source and durable published head before SSH or PR effects", async () => {
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: "credential/github/org/org_fake/dev", value: "ghp_secret" });
    const ssh = new LeaseRaceSsh();
    const http = new RefResponseHttp({ status: 200, body: { object: { sha: fetched } } });
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
        title: "lease test",
        sourceRef: fetched,
        publishedHeadSha: reworked,
        githubCredentialRef: "credential/github/org/org_fake/dev",
      }),
    ).rejects.toThrow("source ref must equal its published head");
    expect(ssh.commands).toHaveLength(0);
    expect(http.requests).toHaveLength(0);
  });

  it("uses a durable predecessor across a re-drive and refuses a moved remote before push or PR publication", async () => {
    const prior = await readDurableDraftPrPublishedHead(new DurableHeadPool([{ payload: { headSha: fetched } }]), {
      orgId: "org_fake",
      specId: "spec_123",
      branch: "tanren/run_123",
    });
    expect(prior).toBe(fetched);
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: "credential/github/org/org_fake/dev", value: "ghp_secret" });
    const ssh = new LeaseRaceSsh();
    const http = new RefResponseHttp({ status: 200, body: { object: { sha: concurrent } } });

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
        title: "lease test",
        sourceRef: reworked,
        publishedHeadSha: reworked,
        githubCredentialRef: "credential/github/org/org_fake/dev",
        expectedPublishedHeadSha: prior,
      }),
    ).rejects.toThrow("changed since workspace rework");
    expect(ssh.commands).toHaveLength(0);
    expect(http.requests).toHaveLength(1);
  });

  it("manual publication persists its actual head, then leases repeat publication and rejects a moved remote", async () => {
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: "credential/github/org/org_fake/dev", value: "ghp_secret" });
    const pool = new ManualRouteDurableHeadPool();
    const events = new PersistingManualEventStore(pool);
    const ssh = new ManualPublicationSsh([fetched, reworked, reworked], concurrent);
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
      { status: 200, body: { object: { sha: concurrent } } },
    ]);
    const input = {
      pool: pool.asPgPool(),
      eventStore: events,
      secrets,
      githubHttp: http,
      ssh,
      runId: "run_123",
      identitySecretRef: "runner/local/identity",
    };

    await publishDraftPullRequestForRun(input);
    expect(pool.durableReads[0]).toEqual(["org_fake", "spec_123", "tanren/run_123"]);
    expect(pool.publishedHead).toBe(fetched);
    expect(events.events.find((event) => event.eventType === "github.branch.pushed")?.payload).toMatchObject({
      headSha: fetched,
    });
    expect(ssh.commands[1]?.command).toContain("--force-with-lease=refs/heads/tanren/run_123:");
    // The workspace HEAD advanced after the route resolved `fetched`; the push
    // nevertheless names the immutable resolved commit, and the event records it.
    expect(ssh.workspaceHead).toBe(concurrent);
    expect(ssh.commands[1]?.command).toContain(`${fetched}:refs/heads/tanren/run_123`);

    await publishDraftPullRequestForRun(input);
    expect(pool.publishedHead).toBe(reworked);
    expect(ssh.commands[3]?.command).toContain(`--force-with-lease=refs/heads/tanren/run_123:${fetched}`);

    await expect(publishDraftPullRequestForRun(input)).rejects.toThrow("changed since workspace rework");
    expect(ssh.commands).toHaveLength(5);
    expect(ssh.commands.filter((command) => command.command.includes("git push"))).toHaveLength(2);
    expect(http.requests.at(-1)?.path).toBe("/repos/cat-cave/repo/git/ref/heads/tanren%2Frun_123");
  });

  it("manual route refuses an existing reviewer-owned branch without a durable prior publication", async () => {
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: "credential/github/org/org_fake/dev", value: "ghp_secret" });
    const pool = new ManualRouteDurableHeadPool();
    const ssh = new ManualPublicationSsh([fetched]);
    const http = new ScriptedGitHubHttp([{ status: 200, body: { object: { sha: concurrent } } }], []);

    await expect(
      publishDraftPullRequestForRun({
        pool: pool.asPgPool(),
        eventStore: new FakeEventStore(),
        secrets,
        githubHttp: http,
        ssh,
        runId: "run_123",
        identitySecretRef: "runner/local/identity",
      }),
    ).rejects.toThrow("exists without a durable published-head witness");

    expect(pool.publishedHead).toBeUndefined();
    expect(pool.durableReads).toEqual([["org_fake", "spec_123", "tanren/run_123"]]);
    expect(ssh.commands).toHaveLength(1);
    expect(ssh.commands[0]?.command).toBe("git rev-parse HEAD");
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]?.path).toBe("/repos/cat-cave/repo/git/ref/heads/tanren%2Frun_123");
  });

  it.each(["", "not-a-sha"])("manual publication rejects a %j workspace head before GitHub or push", async (head) => {
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: "credential/github/org/org_fake/dev", value: "ghp_secret" });
    const ssh = new ManualPublicationSsh([head]);
    const http = new ScriptedGitHubHttp([], []);
    await expect(
      publishDraftPullRequestForRun({
        pool: new ManualRouteDurableHeadPool().asPgPool(),
        eventStore: new FakeEventStore(),
        secrets,
        githubHttp: http,
        ssh,
        runId: "run_123",
        identitySecretRef: "runner/local/identity",
      }),
    ).rejects.toThrow(/workspace head(?: is invalid| resolution returned invalid sha)/u);
    expect(ssh.commands).toHaveLength(1);
    expect(http.requests).toHaveLength(0);
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
        expectedPublishedHeadSha: fetched,
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
