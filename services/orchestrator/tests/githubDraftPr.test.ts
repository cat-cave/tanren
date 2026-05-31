import { describe, expect, it } from "vitest";
import type { SshTarget } from "../src/engine/contracts/allocator.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import type { SshCommand, SshCommandResult, SshSubstrate } from "../src/engine/contracts/sshSubstrate.js";
import { storeGithubToken, validateGithubCredentialRef } from "../src/engine/credentials/githubToken.js";
import { FakeEventStore } from "../src/engine/eventStore.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../src/engine/providers/github.js";
import { GitHubPullRequestService, parseGitHubRepository } from "../src/engine/providers/github.js";
import { publishDraftPullRequest, publishDraftPullRequestForRun } from "../src/engine/workflow/githubDraftPr.js";
import {
  buildGitHubPushCommand,
  draftPrBranchName,
  pushWorkspaceBranchToGitHub,
} from "../src/engine/workspace/githubPush.js";

const target: SshTarget = {
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
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: "credential/github/dev", value: "ghp_secretToken" });
    const ssh = new RecordingSsh();

    await pushWorkspaceBranchToGitHub({
      secrets,
      ssh,
      target,
      workspacePath: "/workspace/runs/run_123/repo",
      repoUrl: "https://github.com/cat-cave/tanren-fixture-easy",
      branch: "tanren/run_123",
      credentialRef: "credential/github/dev",
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
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]?.path).toBe(
      "/repos/cat-cave/repo/pulls?state=open&head=cat-cave%3Atanren%2Frun_123&base=main",
    );
  });

  it("does not reuse open PRs for the wrong base branch or non-draft PRs", async () => {
    const http = new ScriptedGitHubHttp([
      {
        status: 200,
        body: [
          {
            number: 7,
            html_url: "https://github.com/cat-cave/repo/pull/7",
            draft: true,
            base: { ref: "develop" },
          },
          {
            number: 8,
            html_url: "https://github.com/cat-cave/repo/pull/8",
            draft: false,
            base: { ref: "main" },
          },
        ],
      },
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
    expect(http.requests.map((request) => request.method)).toEqual(["GET", "POST"]);
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
      githubHttp: http,
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
      reused: false,
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
      githubHttp: http,
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
});

class RecordingSsh implements SshSubstrate {
  readonly commands: Array<{ target: SshTarget; command: SshCommand }> = [];

  async run(sshTarget: SshTarget, command: SshCommand): Promise<SshCommandResult> {
    this.commands.push({ target: sshTarget, command });
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  }
}

class ScriptedGitHubHttp implements GitHubHttpClient {
  readonly requests: GitHubHttpRequest[] = [];

  constructor(private readonly responses: GitHubHttpResponse[]) {}

  async request(input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    this.requests.push({ ...input, token: "<redacted>" });
    const response = this.responses.shift();
    if (response === undefined) {
      throw new Error(`unexpected GitHub request: ${input.method} ${input.path}`);
    }
    return response;
  }
}

class RecordingPool {
  readonly updates: Array<{ runId: string; prUrl: string }> = [];

  async query(sql: string, params: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
    if (sql === "UPDATE runs SET pr_url = $2 WHERE run_id = $1") {
      this.updates.push({ runId: String(params[0]), prUrl: String(params[1]) });
    }
    return { rows: [], rowCount: 1 };
  }

  asPgPool() {
    return this as never;
  }
}

class RecordingRunPool extends RecordingPool {
  async query(sql: string, params: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
    if (sql.includes("FROM runs r") && sql.includes("JOIN projects p") && sql.includes("LEFT JOIN LATERAL")) {
      if (params[0] !== "run_123") {
        return { rows: [], rowCount: 0 };
      }
      return {
        rowCount: 1,
        rows: [
          {
            run_id: "run_123",
            spec_id: "spec_123",
            project_id: "project_123",
            branch: "tanren/run_123",
            repo_url: "https://github.com/cat-cave/repo.git",
            default_branch: "main",
            config: { githubCredentialRef: "credential/github/dev" },
            spec_title: "Add fixture",
            spec_description: "Create fixture file",
            ssh_host: "runner",
            ssh_port: 22,
            host_key_fingerprint: "SHA256:runner-host",
          },
        ],
      };
    }
    return await super.query(sql, params);
  }
}
