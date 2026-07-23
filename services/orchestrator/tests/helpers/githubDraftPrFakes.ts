// Shared test fakes for the GitHub draft-PR / PR-reuse suite, extracted from
// `githubDraftPr.test.ts` so that suite stays under the 500-line file cap. These are
// TEST FIXTURES ONLY (a scripted HTTP client + recording SSH/pg doubles) — never used
// in production.
import type { RunnerHandle } from "../../src/engine/contracts/allocator.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../../src/engine/contracts/commandSubstrate.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../../src/engine/providers/github.js";

export class RecordingSsh implements CommandSubstrate {
  readonly commands: Array<{ target: RunnerHandle; command: RunnerCommand }> = [];

  constructor(private readonly result: Partial<CommandResult> = {}) {}

  async run(sshTarget: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push({ target: sshTarget, command });
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...this.result };
  }
}

export class ScriptedGitHubHttp implements GitHubHttpClient {
  readonly requests: GitHubHttpRequest[] = [];

  constructor(private readonly responses: GitHubHttpResponse[]) {}

  async request(input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    this.requests.push({ ...input, token: "<redacted>" });
    // Most draft-PR tests do not care about the publication lease. Treat an
    // un-scripted ref lookup as a proven-absent first write without consuming
    // their PR-operation script; lease-focused tests script the SHA response.
    if (input.path.includes("/git/ref/heads/") && !hasRefSha(this.responses[0])) {
      return { status: 404, body: { message: "Not Found" } };
    }
    const response = this.responses.shift();
    if (response === undefined) {
      throw new Error(`unexpected GitHub request: ${input.method} ${input.path}`);
    }
    return response;
  }
}

function hasRefSha(response: GitHubHttpResponse | undefined): boolean {
  return (
    typeof response?.body === "object" &&
    response.body !== null &&
    typeof (response.body as { object?: { sha?: unknown } }).object?.sha === "string"
  );
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
  // a speculative run's ordered ancestor stack (the jj-local base source); absent/empty ⇒
  // a normal run (default_branch base).
  ancestorStack?: unknown;
  specTitle?: string;
  specDescription?: string;
}

export class RecordingRunPool extends RecordingPool {
  private readonly ancestorStack: unknown;
  private readonly specTitle: string;
  private readonly specDescription: string;

  // A positional ancestor-stack (or null) OR an overrides object — the title/description
  // tests inject blank spec fields via the latter.
  constructor(overrides?: unknown | RunPoolSpecOverrides) {
    super();
    const isOverridesObj =
      typeof overrides === "object" &&
      overrides !== null &&
      !Array.isArray(overrides) &&
      ("ancestorStack" in overrides || "specTitle" in overrides || "specDescription" in overrides);
    const o = isOverridesObj ? (overrides as RunPoolSpecOverrides) : { ancestorStack: overrides ?? null };
    this.ancestorStack = o.ancestorStack ?? null;
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
            // v68 fix: the loader now selects runs.org_id (NOT NULL on the table).
            org_id: "org_fake",
            branch: "tanren/run_123",
            ancestor_stack: this.ancestorStack,
            repo_url: "https://github.com/cat-cave/repo.git",
            default_branch: "main",
            config: {
              version: 1,
              credentials: { githubCredentialRef: "credential/github/org/org_fake/dev" },
            },
            // LEFT JOIN organizations — SQL always returns the key (null when absent).
            org_config: null,
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
