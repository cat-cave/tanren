// Shared test fakes for the GitHub draft-PR / PR-reuse suite, extracted from
// `githubDraftPr.test.ts` so that suite stays under the 500-line file cap. These are
// TEST FIXTURES ONLY (a scripted HTTP client + recording SSH/pg doubles) — never used
// in production.
import type { SshTarget } from "../../src/engine/contracts/allocator.js";
import type { SshCommand, SshCommandResult, SshSubstrate } from "../../src/engine/contracts/sshSubstrate.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../../src/engine/providers/github.js";

export class RecordingSsh implements SshSubstrate {
  readonly commands: Array<{ target: SshTarget; command: SshCommand }> = [];

  async run(sshTarget: SshTarget, command: SshCommand): Promise<SshCommandResult> {
    this.commands.push({ target: sshTarget, command });
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  }
}

export class ScriptedGitHubHttp implements GitHubHttpClient {
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

export class RecordingPool {
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

export class RecordingRunPool extends RecordingPool {
  // P2c-1: a speculative run's dynamic base; null ⇒ a normal run (default_branch).
  constructor(readonly speculativeBase: string | null = null) {
    super();
  }

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
            speculative_base: this.speculativeBase,
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
