// Shared test fakes for the GitHub draft-PR / PR-reuse suite, extracted from
// `githubDraftPr.test.ts` so that suite stays under the 500-line file cap. These are
// TEST FIXTURES ONLY (a scripted HTTP client + recording SSH/pg doubles) — never used
// in production.
import type { RunnerHandle } from "../../src/engine/contracts/allocator.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../../src/engine/contracts/commandSubstrate.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../../src/engine/providers/github.js";

export class RecordingSsh implements CommandSubstrate {
  readonly commands: Array<{ target: RunnerHandle; command: RunnerCommand }> = [];

  async run(sshTarget: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
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

/** Overridable bits of the loaded run-context row (spec title/description). */
export interface RunPoolSpecOverrides {
  // a speculative run's dynamic base; null ⇒ a normal run (default_branch).
  speculativeBase?: string | null;
  specTitle?: string;
  specDescription?: string;
}

export class RecordingRunPool extends RecordingPool {
  private readonly speculativeBase: string | null;
  private readonly specTitle: string;
  private readonly specDescription: string;

  // Back-compat-free positional form (speculativeBase only) OR an overrides
  // object — the title/description tests inject blank spec fields via the latter.
  constructor(overrides?: string | null | RunPoolSpecOverrides) {
    super();
    const o = typeof overrides === "object" && overrides !== null ? overrides : { speculativeBase: overrides ?? null };
    this.speculativeBase = o.speculativeBase ?? null;
    this.specTitle = o.specTitle ?? "Add fixture";
    this.specDescription = o.specDescription ?? "Create fixture file";
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
            spec_title: this.specTitle,
            spec_description: this.specDescription,
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
