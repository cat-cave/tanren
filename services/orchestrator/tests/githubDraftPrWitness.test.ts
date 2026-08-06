import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { publishDraftPullRequest } from "../src/engine/workflow/githubDraftPr.js";
import type { PriorEventInput } from "../src/engine/eventStore.js";
import { readDraftPrPushLease } from "../src/engine/workflow/githubDraftPrLease.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import { RecordingPool, RecordingSsh, ScriptedGitHubHttp } from "./helpers/githubDraftPrFakes.js";

const target: RunnerHandle = { backend: "ssh", host: "runner", port: 22, username: "tanren" } as RunnerHandle;

class AmbiguousPriorAppendStore extends FakeEventStore {
  priorAppendCalls = 0;

  async appendPriorIfAbsent(input: PriorEventInput): Promise<boolean> {
    this.priorAppendCalls += 1;
    if (this.priorAppendCalls === 1) {
      await this.append(input);
      throw new Error("event-store response lost after commit");
    }
    return false;
  }
}

class RecordingSecrets extends FakeSecretStore {
  getCalls = 0;

  override async get(ref: string) {
    this.getCalls += 1;
    return await super.get(ref);
  }
}

describe("GitHub draft PR immutable publication witness", () => {
  it("reconciles a remote intended head after a crashed witness append", async () => {
    const sha = "c".repeat(40);
    await expect(
      readDraftPrPushLease(
        new ScriptedGitHubHttp([{ status: 200, body: { object: { sha } } }], []),
        { owner: "cat-cave", name: "repo" },
        "tanren/run_123",
        "ghp_secret",
        undefined,
        sha,
      ),
    ).resolves.toEqual({ expectedSha: sha, alreadyPublished: true });
  });

  it("reconciles the intended head even when the durable ledger still names its predecessor", async () => {
    const predecessor = "a".repeat(40);
    const intended = "b".repeat(40);
    await expect(
      readDraftPrPushLease(
        new ScriptedGitHubHttp([{ status: 200, body: { object: { sha: intended } } }], []),
        { owner: "cat-cave", name: "repo" },
        "tanren/run_123",
        "ghp_secret",
        predecessor,
        intended,
      ),
    ).resolves.toEqual({ expectedSha: intended, alreadyPublished: true });
  });

  it("does not duplicate the pushed witness when the first append response is lost", async () => {
    const secrets = new RecordingSecrets();
    await secrets.put({ ref: "credential/github/org/org_fake/dev", value: "ghp_secret" });
    const events = new AmbiguousPriorAppendStore();
    const sha = "a".repeat(40);
    const http = new ScriptedGitHubHttp([
      { status: 200, body: { object: { sha } } },
      { status: 200, body: [] },
      {
        status: 201,
        body: { number: 9, html_url: "https://github.com/cat-cave/repo/pull/9", draft: true, base: { ref: "main" } },
      },
    ]);

    await publishDraftPullRequest({
      pool: new RecordingPool().asPgPool(),
      eventStore: events,
      secrets,
      githubHttp: http,
      ssh: new RecordingSsh(),
      target,
      runId: "run_123",
      specId: "spec_123",
      projectId: "project_123",
      appendEventOrgId: "org_fake",
      workspacePath: "/workspace/runs/run_123/repo",
      repoUrl: "https://github.com/cat-cave/repo.git",
      targetBranch: "main",
      sourceRef: sha,
      publishedHeadSha: sha,
      title: "witness retry",
      githubCredentialRef: "credential/github/org/org_fake/dev",
    });

    expect(events.priorAppendCalls).toBe(2);
    expect(events.events.filter((event) => event.eventType === "github.branch.pushed")).toHaveLength(1);
  });

  it("rejects a missing witness before credential, ref, SSH, or PR effects", async () => {
    const secrets = new RecordingSecrets();
    await secrets.put({ ref: "credential/github/org/org_fake/dev", value: "ghp_secret" });
    const events = new FakeEventStore();
    const http = new ScriptedGitHubHttp([]);
    const ssh = new RecordingSsh();

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
        title: "witness test",
        githubCredentialRef: "credential/github/org/org_fake/dev",
      }),
    ).rejects.toThrow("immutable source/head witness is required");

    expect(events.events).toEqual([]);
    expect(secrets.getCalls).toBe(0);
    expect(http.requests).toEqual([]);
    expect(ssh.commands).toEqual([]);
  });
});
