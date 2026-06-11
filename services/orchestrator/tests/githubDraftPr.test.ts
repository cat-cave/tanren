import { describe, expect, it } from "vitest";
import { vcsProviderOver } from "./helpers/vcsProvider.js";
import { RecordingPool, RecordingRunPool, RecordingSsh, ScriptedGitHubHttp } from "./helpers/githubDraftPrFakes.js";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { storeGithubToken, validateGithubCredentialRef } from "../src/engine/credentials/githubToken.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import { GitHubPullRequestService } from "../src/engine/providers/githubPullRequestReuse.js";
import { parseGitHubRepository } from "../src/engine/providers/github.js";
import { publishDraftPullRequest, publishDraftPullRequestForRun } from "../src/engine/workflow/githubDraftPr.js";
import {
  buildGitHubPushCommand,
  draftPrBranchName,
  PR_CLEAN_REF,
  pushWorkspaceBranchToGitHub,
} from "../src/engine/workspace/githubPush.js";

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};

describe("GitHub draft PR contract", () => {
  it("validates managed GitHub credential refs and redacts token import results", async () => {
    const secrets = new FakeSecretStore();

    const result = await storeGithubToken(secrets, {
      ref: "credential/github/dev",
      token: "ghp_secretToken",
    });

    expect(result).toEqual({
      credentialKind: "github_token",
      ref: "credential/github/dev",
      redacted: true,
    });
    expect(JSON.stringify(result)).not.toContain("ghp_secretToken");
    await expect(secrets.get("credential/github/dev")).resolves.toEqual({
      ref: "credential/github/dev",
      value: "ghp_secretToken",
    });
    expect(() => validateGithubCredentialRef("credential/codex/dev")).toThrow("credential/github/");
    await expect(storeGithubToken(secrets, { ref: "credential/github/bad", token: "has whitespace" })).rejects.toThrow(
      "whitespace",
    );
  });

  it("builds deterministic safe branch names", () => {
    expect(draftPrBranchName({ runId: "run_123" })).toBe("tanren/run_123");
    expect(draftPrBranchName({ runId: "run_123", requestedBranch: "tanren/add-health-check-abcd1234" })).toBe(
      "tanren/add-health-check-abcd1234",
    );
    expect(() => draftPrBranchName({ runId: "run_bad/path" })).toThrow("unsafe run id");
    expect(() => draftPrBranchName({ runId: "run_123", requestedBranch: "../main" })).toThrow("unsafe git branch");
    expect(() => draftPrBranchName({ runId: "run_123", requestedBranch: "tanren/bad token" })).toThrow(
      "unsafe git branch",
    );
  });

  it("constructs runner git push commands without embedding the token", async () => {
    const ssh = new RecordingSsh();

    // The caller (the VcsProvider) always passes a pre-resolved push token; the
    // push feeds it over stdin, never embedding it in the command string.
    await pushWorkspaceBranchToGitHub({
      ssh,
      target,
      workspacePath: "/workspace/runs/run_123/repo",
      repoUrl: "https://github.com/cat-cave/tanren-fixture-easy",
      branch: "tanren/run_123",
      token: "ghp_secretToken",
      timeoutMs: 500,
    });

    expect(ssh.commands[0]?.command.cwd).toBe("/workspace/runs/run_123/repo");
    expect(ssh.commands[0]?.command.stdin).toBe("ghp_secretToken");
    expect(ssh.commands[0]?.command.command).toContain("GIT_ASKPASS");
    expect(ssh.commands[0]?.command.command).toContain("https://github.com/cat-cave/tanren-fixture-easy.git");
    expect(ssh.commands[0]?.command.command).not.toContain("ghp_secretToken");
    expect(ssh.commands[0]?.command.command).not.toContain(Buffer.from("ghp_secretToken", "utf8").toString("base64"));
  });

  it("parses GitHub repo URLs and rejects non-GitHub remotes", () => {
    expect(parseGitHubRepository("https://github.com/cat-cave/tanren-fixture-easy.git")).toEqual({
      owner: "cat-cave",
      name: "tanren-fixture-easy",
    });
    expect(parseGitHubRepository("git@github.com:cat-cave/tanren-fixture-easy.git")).toEqual({
      owner: "cat-cave",
      name: "tanren-fixture-easy",
    });
    expect(() => buildGitHubPushCommand({ repoUrl: "https://example.com/repo.git", branch: "tanren/run_123" })).toThrow(
      "unsupported GitHub",
    );
  });

  it("pushes the working HEAD by default and the cleaned PR ref when asked", () => {
    const head = buildGitHubPushCommand({
      repoUrl: "https://github.com/cat-cave/tanren-fixture-easy",
      branch: "tanren/run_123",
    });
    expect(head).toContain("HEAD:refs/heads/tanren/run_123");

    const clean = buildGitHubPushCommand({
      repoUrl: "https://github.com/cat-cave/tanren-fixture-easy",
      branch: "tanren/run_123",
      sourceRef: PR_CLEAN_REF,
    });
    expect(clean).toContain(`${PR_CLEAN_REF}:refs/heads/tanren/run_123`);
    // The run's own branch is force-updated (the cleaned ref is rebuilt on each
    // review-rework re-entry).
    expect(clean).toContain("--force");

    // Only the working HEAD or the cleaned ref are valid push sources.
    expect(() =>
      buildGitHubPushCommand({
        repoUrl: "https://github.com/cat-cave/tanren-fixture-easy",
        branch: "tanren/run_123",
        sourceRef: "refs/heads/main",
      }),
    ).toThrow("unsafe push source ref");
  });

  it("reuses an existing open PR instead of creating duplicates", async () => {
    const http = new ScriptedGitHubHttp([
      {
        status: 200,
        body: [
          {
            number: 7,
            html_url: "https://github.com/cat-cave/repo/pull/7",
            draft: true,
            base: { ref: "main" },
          },
        ],
      },
    ]);
    const service = new GitHubPullRequestService(http);

    const result = await service.ensureDraftPullRequest({
      repo: { owner: "cat-cave", name: "repo" },
      token: "ghp_secretToken",
      headBranch: "tanren/run_123",
      baseBranch: "main",
      title: "Tanren run run_123",
    });

    expect(result).toEqual({
      number: 7,
      url: "https://github.com/cat-cave/repo/pull/7",
      draft: true,
      baseBranch: "main",
      reused: true,
    });
    // The lookup queries by HEAD ONLY (no &base=...): a spec maps to one head branch, so
    // we must surface its open PR regardless of the PR's current base (see §2c re-exec).
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]?.path).toBe("/repos/cat-cave/repo/pulls?state=open&head=cat-cave%3Atanren%2Frun_123");
  });

  it("no existing PR for the head → POSTs a new draft (unchanged first-PR path)", async () => {
    const http = new ScriptedGitHubHttp([
      { status: 200, body: [] },
      {
        status: 201,
        body: {
          number: 9,
          html_url: "https://github.com/cat-cave/repo/pull/9",
          draft: true,
          base: { ref: "main" },
        },
      },
    ]);
    const service = new GitHubPullRequestService(http);

    const result = await service.ensureDraftPullRequest({
      repo: { owner: "cat-cave", name: "repo" },
      token: "ghp_secretToken",
      headBranch: "tanren/run_123",
      baseBranch: "main",
      title: "Tanren run run_123",
    });

    expect(result).toMatchObject({ number: 9, reused: false, draft: true, baseBranch: "main" });
    // find-by-head (no base) → POST new; no PATCH.
    expect(http.requests.map((request) => request.method)).toEqual(["GET", "POST"]);
    expect(http.requests[0]?.path).toBe("/repos/cat-cave/repo/pulls?state=open&head=cat-cave%3Atanren%2Frun_123");
    const createBody = http.requests[1]?.body as { draft?: boolean; base?: string } | undefined;
    expect(createBody?.draft).toBe(true);
    expect(createBody?.base).toBe("main");
  });

  it("existing open PR with the SAME base → reused, no POST and no PATCH", async () => {
    const http = new ScriptedGitHubHttp([
      {
        status: 200,
        body: [
          {
            number: 7,
            html_url: "https://github.com/cat-cave/repo/pull/7",
            draft: true,
            base: { ref: "main" },
          },
        ],
      },
    ]);
    const service = new GitHubPullRequestService(http);

    const result = await service.ensureDraftPullRequest({
      repo: { owner: "cat-cave", name: "repo" },
      token: "ghp_secretToken",
      headBranch: "tanren/run_123",
      baseBranch: "main",
      title: "Tanren run run_123",
    });

    expect(result).toEqual({
      number: 7,
      url: "https://github.com/cat-cave/repo/pull/7",
      draft: true,
      baseBranch: "main",
      reused: true,
    });
    // Single find-by-head request — no POST, no PATCH.
    expect(http.requests.map((request) => request.method)).toEqual(["GET"]);
  });

  it("§2c: existing open PR with a DIFFERENT base → PATCH base onto the re-exec base, reused (no 422, no second POST)", async () => {
    // The prior run was speculative: its PR is based on the integration branch. The
    // re-exec is non-speculative and pushes the SAME spec-derived head with base=main.
    const http = new ScriptedGitHubHttp([
      {
        status: 200,
        body: [
          {
            number: 7,
            html_url: "https://github.com/cat-cave/repo/pull/7",
            draft: true,
            base: { ref: "tanren/integ/spec_123" },
          },
        ],
      },
      {
        status: 200,
        body: {
          number: 7,
          html_url: "https://github.com/cat-cave/repo/pull/7",
          draft: true,
          base: { ref: "main" },
        },
      },
    ]);
    const service = new GitHubPullRequestService(http);

    const result = await service.ensureDraftPullRequest({
      repo: { owner: "cat-cave", name: "repo" },
      token: "ghp_secretToken",
      headBranch: "tanren/run_123",
      baseBranch: "main",
      title: "Tanren run run_123",
    });

    // Reused the SAME PR (#7), now re-pointed onto main.
    expect(result).toEqual({
      number: 7,
      url: "https://github.com/cat-cave/repo/pull/7",
      draft: true,
      baseBranch: "main",
      reused: true,
    });
    // find-by-head, then PATCH /pulls/7 with the new base — no POST (so no 422).
    expect(http.requests.map((request) => request.method)).toEqual(["GET", "PATCH"]);
    expect(http.requests[1]?.path).toBe("/repos/cat-cave/repo/pulls/7");
    expect((http.requests[1]?.body as { base?: string } | undefined)?.base).toBe("main");
  });

  it("422 race on POST → re-find by head returns the racing PR (no throw)", async () => {
    // First find-by-head sees no PR (race window); POST races and loses with a 422;
    // the re-find by head now surfaces the PR the racer created.
    const http = new ScriptedGitHubHttp([
      { status: 200, body: [] },
      { status: 422, body: { message: "A pull request already exists for cat-cave:tanren/run_123." } },
      {
        status: 200,
        body: [
          {
            number: 11,
            html_url: "https://github.com/cat-cave/repo/pull/11",
            draft: true,
            base: { ref: "main" },
          },
        ],
      },
    ]);
    const service = new GitHubPullRequestService(http);

    const result = await service.ensureDraftPullRequest({
      repo: { owner: "cat-cave", name: "repo" },
      token: "ghp_secretToken",
      headBranch: "tanren/run_123",
      baseBranch: "main",
      title: "Tanren run run_123",
    });

    expect(result).toEqual({
      number: 11,
      url: "https://github.com/cat-cave/repo/pull/11",
      draft: true,
      baseBranch: "main",
      reused: true,
    });
    // find-by-head → POST (422) → re-find-by-head (returns the racing PR). Same base, so
    // no PATCH.
    expect(http.requests.map((request) => request.method)).toEqual(["GET", "POST", "GET"]);
    expect(http.requests[2]?.path).toBe("/repos/cat-cave/repo/pulls?state=open&head=cat-cave%3Atanren%2Frun_123");
  });

  it("non-already-exists 422 (no open PR after re-find) → throws WITH the GitHub response body surfaced (apex v31)", async () => {
    // The apex v31 case: a 422 that is NOT "already exists" (here an empty-title
    // `missing_field`). The re-find by head still sees no PR → we must throw, and the
    // thrown message must include GitHub's body detail (not just `HTTP 422`), or the
    // real cause is invisible (the swallowed-body diagnosis that derailed v31).
    const http = new ScriptedGitHubHttp([
      { status: 200, body: [] },
      {
        status: 422,
        body: {
          message: "Validation Failed",
          errors: [{ resource: "PullRequest", field: "title", code: "missing_field" }],
        },
      },
      { status: 200, body: [] },
    ]);
    const service = new GitHubPullRequestService(http);

    const promise = service.ensureDraftPullRequest({
      repo: { owner: "cat-cave", name: "repo" },
      token: "ghp_secretToken",
      headBranch: "tanren/run_123",
      baseBranch: "main",
      title: "",
    });

    await expect(promise).rejects.toThrow("HTTP 422");
    // The body detail — the missing_field / errors content — is surfaced, not swallowed.
    await expect(promise).rejects.toThrow(/missing_field/u);
    await expect(promise).rejects.toThrow(/title/u);
    // find-by-head → POST (422) → re-find-by-head (still none) → throw.
    expect(http.requests.map((request) => request.method)).toEqual(["GET", "POST", "GET"]);
  });

  it("creates a draft PR, persists its URL, and appends redacted events", async () => {
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: "credential/github/dev", value: "ghp_secretToken" });
    const ssh = new RecordingSsh();
    const http = new ScriptedGitHubHttp([
      { status: 200, body: [] },
      {
        status: 201,
        body: {
          number: 9,
          html_url: "https://github.com/cat-cave/repo/pull/9",
          draft: true,
          base: { ref: "main" },
        },
      },
    ]);
    const events = new FakeEventStore();
    const pool = new RecordingPool();

    const result = await publishDraftPullRequest({
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
      targetBranch: "main",
      runBranch: "tanren/run_123",
      title: "Tanren run run_123",
      projectConfig: { githubCredentialRef: "credential/github/dev" },
      timeoutMs: 500,
    });

    expect(result).toEqual({
      branch: "tanren/run_123",
      prUrl: "https://github.com/cat-cave/repo/pull/9",
      prNumber: 9,
    });
    expect(pool.updates).toEqual([{ runId: "run_123", prUrl: "https://github.com/cat-cave/repo/pull/9" }]);
    expect(events.events.map((event) => event.eventType)).toEqual([
      "credential.requested",
      "credential.loaded",
      "github.branch.pushed",
      "github.pr.created",
    ]);
    expect(JSON.stringify(events.events)).not.toContain("ghp_secretToken");
    expect(JSON.stringify(http.requests)).not.toContain("ghp_secretToken");
    expect(ssh.commands[0]?.command.command).not.toContain("ghp_secretToken");
  });

  it("loads persisted run context before publishing a draft PR", async () => {
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: "credential/github/dev", value: "ghp_secretToken" });
    const ssh = new RecordingSsh();
    const http = new ScriptedGitHubHttp([
      { status: 200, body: [] },
      {
        status: 201,
        body: {
          number: 10,
          html_url: "https://github.com/cat-cave/repo/pull/10",
          draft: true,
          base: { ref: "main" },
        },
      },
    ]);
    const events = new FakeEventStore();
    const pool = new RecordingRunPool();

    const result = await publishDraftPullRequestForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets,
      vcsProvider: vcsProviderOver(http),
      ssh,
      runId: "run_123",
      identitySecretRef: "runner/local/identity",
      timeoutMs: 500,
    });

    expect(result).toMatchObject({ branch: "tanren/run_123", prNumber: 10 });
    expect(ssh.commands[0]?.target).toMatchObject({
      host: "runner",
      port: 22,
      username: "tanren",
      identitySecretRef: "runner/local/identity",
    });
    expect(ssh.commands[0]?.command.cwd).toBe("/workspace/runs/run_123/repo");
    expect(pool.updates).toEqual([{ runId: "run_123", prUrl: "https://github.com/cat-cave/repo/pull/10" }]);
  });

  it("§3.1: the operator publish route stacks the PR on the IMMEDIATE ancestor's PR-head branch (a true stacked PR)", async () => {
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: "credential/github/dev", value: "ghp_secretToken" });
    const ssh = new RecordingSsh();
    const http = new ScriptedGitHubHttp([
      { status: 200, body: [] },
      {
        status: 201,
        body: {
          number: 10,
          html_url: "https://github.com/cat-cave/repo/pull/10",
          draft: true,
          base: { ref: "tanren/run_anc" },
        },
      },
    ]);
    const events = new FakeEventStore();
    // A DEPENDENT speculative run: the operator route must stack the PR on the immediate
    // ancestor's PR-head branch (the LAST stack entry), NOT default_branch.
    const pool = new RecordingRunPool({
      ancestorStack: [{ specId: "spec_anc", runId: "run_anc", branch: "tanren/run_anc", headSha: "a".repeat(40) }],
    });

    await publishDraftPullRequestForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets,
      vcsProvider: vcsProviderOver(http),
      ssh,
      runId: "run_123",
      identitySecretRef: "runner/local/identity",
      timeoutMs: 500,
    });

    // The create-PR request body's `base` is the immediate ancestor's PR-head branch.
    const createReq = http.requests.find((r) => r.method === "POST" && r.path.endsWith("/pulls"));
    expect((createReq?.body as { base?: string } | undefined)?.base).toBe("tanren/run_anc");
    // The github.pr.created event records the stacked base as the targetBranch.
    expect(events.events.find((e) => e.eventType === "github.pr.created")?.payload).toMatchObject({
      targetBranch: "tanren/run_anc",
    });
  });
});
