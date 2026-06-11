// WS-A PR-5 (walker-jj-local-integration-design.md §3.1): the STACKED-PR draft base.
// `resolveDraftPrBaseBranch` bases a dependent's PR on the IMMEDIATE ancestor's PR-head
// branch (the LAST stack entry) ONLY when `WALKER_JJ_LOCAL_BASE` is ON + the stack is
// non-empty; flag-off or empty ⇒ exactly the fallback (`targetBranch`).

import { afterEach, describe, expect, it } from "vitest";
import { vcsProviderOver } from "./helpers/vcsProvider.js";
import { RecordingPool, RecordingSsh, ScriptedGitHubHttp } from "./helpers/githubDraftPrFakes.js";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import { publishDraftPullRequest, resolveDraftPrBaseBranch } from "../src/engine/workflow/githubDraftPr.js";
import type { AncestorStack } from "../src/engine/dag/ancestorStack.js";

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};

const member = (specId: string, branch: string): AncestorStack[number] => ({
  specId,
  runId: `run_${specId}`,
  branch,
  headSha: "a".repeat(40),
});

describe("WS-A PR-5 stacked-PR draft base", () => {
  afterEach(() => {
    delete process.env["WALKER_JJ_LOCAL_BASE"];
  });

  it("flag OFF: base is the fallback (today's targetBranch) even with a stack", () => {
    delete process.env["WALKER_JJ_LOCAL_BASE"];
    const stack: AncestorStack = [member("spec_a", "tanren/run_a"), member("spec_b", "tanren/run_b")];
    expect(resolveDraftPrBaseBranch("tanren/integ/spec_d", stack)).toBe("tanren/integ/spec_d");
  });

  it("flag ON + non-empty stack: base is the IMMEDIATE ancestor (last stack entry) PR-head branch", () => {
    process.env["WALKER_JJ_LOCAL_BASE"] = "1";
    const stack: AncestorStack = [member("spec_a", "tanren/run_a"), member("spec_b", "tanren/run_b")];
    expect(resolveDraftPrBaseBranch("main", stack)).toBe("tanren/run_b");
  });

  it("flag ON + empty/absent stack: base is the fallback (non-speculative run)", () => {
    process.env["WALKER_JJ_LOCAL_BASE"] = "1";
    const absent: AncestorStack | undefined = undefined;
    expect(resolveDraftPrBaseBranch("main", [])).toBe("main");
    expect(resolveDraftPrBaseBranch("main", absent)).toBe("main");
  });

  it("flag ON + a blank-branch (legacy sha-map) immediate ancestor: falls back rather than base on ''", () => {
    process.env["WALKER_JJ_LOCAL_BASE"] = "1";
    const stack: AncestorStack = [{ specId: "spec_a", runId: "", branch: "", headSha: "a".repeat(40) }];
    expect(resolveDraftPrBaseBranch("main", stack)).toBe("main");
  });

  it("flag ON end-to-end: the draft PR opens against the immediate-ancestor branch", async () => {
    process.env["WALKER_JJ_LOCAL_BASE"] = "1";
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: "credential/github/dev", value: "ghp_secretToken" });
    const ssh = new RecordingSsh();
    const http = new ScriptedGitHubHttp([
      { status: 200, body: [] },
      {
        status: 201,
        body: {
          number: 12,
          html_url: "https://github.com/cat-cave/repo/pull/12",
          draft: true,
          base: { ref: "tanren/run_a" },
        },
      },
    ]);
    const events = new FakeEventStore();
    const pool = new RecordingPool();

    await publishDraftPullRequest({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets,
      vcsProvider: vcsProviderOver(http),
      ssh,
      target,
      runId: "run_123",
      specId: "spec_123",
      projectId: "project_123",
      workspacePath: "/workspace/runs/run_123/repo",
      repoUrl: "https://github.com/cat-cave/repo.git",
      // `targetBranch` is the legacy integ base; the stack overrides it to the ancestor.
      targetBranch: "tanren/integ/spec_123",
      ancestorStack: [member("spec_a", "tanren/run_a")],
      runBranch: "tanren/run_123",
      title: "Tanren run run_123",
      projectConfig: { githubCredentialRef: "credential/github/dev" },
      timeoutMs: 500,
    });

    const createReq = http.requests.find((r) => r.method === "POST" && r.path.endsWith("/pulls"));
    expect((createReq?.body as { base?: string } | undefined)?.base).toBe("tanren/run_a");
    // The github.pr.created event records the actual base the PR opened against.
    expect(events.events.find((e) => e.eventType === "github.pr.created")?.payload).toMatchObject({
      targetBranch: "tanren/run_a",
    });
  });
});
