import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { publishDraftPullRequest } from "../src/engine/workflow/githubDraftPr.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import { RecordingPool, RecordingSsh, ScriptedGitHubHttp } from "./helpers/githubDraftPrFakes.js";

const target: RunnerHandle = { backend: "ssh", host: "runner", port: 22, username: "tanren" } as RunnerHandle;

class RecordingSecrets extends FakeSecretStore {
  getCalls = 0;

  override async get(ref: string) {
    this.getCalls += 1;
    return await super.get(ref);
  }
}

describe("GitHub draft PR immutable publication witness", () => {
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
