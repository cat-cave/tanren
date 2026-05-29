import { readFile } from "node:fs/promises";
import type { ServerHostKeyAlgorithm } from "ssh2";
import { describe, expect, it } from "vitest";
import type { SshTarget } from "../src/engine/contracts/allocator.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { storeGithubToken } from "../src/engine/credentials/githubToken.js";
import { FakeEventStore } from "../src/engine/eventStore.js";
import { FetchGitHubHttpClient } from "../src/engine/providers/github.js";
import { Ssh2Substrate } from "../src/engine/ssh/index.js";
import { publishDraftPullRequest } from "../src/engine/workflow/githubDraftPr.js";
import { runWorkspaceSshCommand, workspaceRepoPathForRun } from "../src/engine/workspace/index.js";

const runLive = process.env.TANREN_GITHUB_LIVE === "1";
const describeLive = runLive ? describe : describe.skip;

describeLive("live GitHub draft PR contract", () => {
  it(
    "pushes a runner workspace branch and opens or reuses a draft PR",
    async () => {
      const timeoutMs = Number(process.env.TANREN_GITHUB_LIVE_TIMEOUT_MS ?? "60000");
      const repoUrl = requireEnv("TANREN_GITHUB_REPO_URL");
      const baseBranch = process.env.TANREN_GITHUB_BASE_BRANCH ?? "main";
      const runId = `run_github_live_${Date.now()}`;
      const branch = `tanren/live-${runId.replace(/^run_/, "")}`;
      const workspace = workspaceRepoPathForRun(runId);
      const secrets = new FakeSecretStore();
      await storeGithubToken(secrets, {
        ref: "credential/github/live",
        token: await readFile(requireEnv("TANREN_GITHUB_TOKEN_FILE"), "utf8"),
      });
      await secrets.put({
        ref: "runner/live/identity",
        value: await readFile(requireEnv("TANREN_SSH_KEY_PATH"), "utf8"),
      });
      const ssh = new Ssh2Substrate(secrets, {
        serverHostKeyAlgorithms: parseHostKeyAlgorithms(process.env.TANREN_SSH_HOST_KEY_ALGORITHMS),
      });
      const target = liveTarget();

      await runWorkspaceSshCommand(ssh, target, {
        label: "prepare live GitHub workspace",
        timeoutMs,
        command: [
          "set -eu",
          `rm -rf ${shellQuote(workspace)}`,
          `git clone --depth 1 --branch ${shellQuote(baseBranch)} ${shellQuote(repoUrl)} ${shellQuote(workspace)}`,
          `cd ${shellQuote(workspace)}`,
          "git config user.name 'Tanren Live Smoke'",
          "git config user.email 'tanren-live@tanren.invalid'",
          `printf '%s\\n' ${shellQuote(`tanren github draft pr ok ${runId}`)} > TANREN_GITHUB_LIVE.md`,
          "git add TANREN_GITHUB_LIVE.md",
          `git commit -m ${shellQuote("tanren github draft pr smoke")}`,
        ].join(" && "),
      });

      const events = new FakeEventStore();
      const result = await publishDraftPullRequest({
        pool: new RecordingPool().asPgPool(),
        eventStore: events,
        secrets,
        githubHttp: new FetchGitHubHttpClient(),
        ssh,
        target,
        runId,
        specId: "spec_github_live",
        projectId: "project_github_live",
        workspacePath: workspace,
        repoUrl,
        targetBranch: baseBranch,
        runBranch: branch,
        title: `Tanren live draft PR smoke ${runId}`,
        body: "Created by Tanren's opt-in live GitHub draft PR smoke.",
        githubCredentialRef: "credential/github/live",
        timeoutMs,
      });

      expect(result.prUrl).toMatch(/^https:\/\/github\.com\/.+\/pull\/\d+$/);
      expect(result.branch).toBe(branch);
      expect(events.events.map((event) => event.eventType)).toContain("github.pr.created");
    },
    Number(process.env.TANREN_GITHUB_LIVE_TIMEOUT_MS ?? "60000") + 10_000,
  );
});

class RecordingPool {
  async query(): Promise<{ rows: unknown[]; rowCount: number }> {
    return { rows: [], rowCount: 1 };
  }

  asPgPool() {
    return this as never;
  }
}

function liveTarget(): SshTarget {
  return {
    host: process.env.TANREN_SSH_HOST ?? "127.0.0.1",
    port: Number(process.env.TANREN_SSH_PORT ?? "2222"),
    username: process.env.TANREN_SSH_USER ?? "tanren",
    hostKeyFingerprint: requireEnv("TANREN_SSH_HOST_FINGERPRINT"),
    identitySecretRef: "runner/live/identity",
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function parseHostKeyAlgorithms(value: string | undefined): ServerHostKeyAlgorithm[] | undefined {
  return value
    ?.split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "") as ServerHostKeyAlgorithm[] | undefined;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
