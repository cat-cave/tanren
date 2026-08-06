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
    return {
      exitCode: 0,
      stdout: command.command === "git rev-parse HEAD" ? `${"a".repeat(40)}\n` : "",
      stderr: "",
      timedOut: false,
    };
  }
}

const DEFAULT_FIRST_PUBLICATION_ABSENT_REFS = [
  "/repos/cat-cave/repo/git/ref/heads/tanren%2Frun_123",
  "/repos/cat-cave/repo/git/ref/heads/tanren%2Fscaffold-8973ab2b",
  "/repos/cat-cave/linky86/git/ref/heads/tanren%2Fscaffold-8973ab2b",
  "/repos/cat-cave/repo/git/ref/heads/tanren%2Frun_legacy",
  "/repos/cat-cave/repo/git/ref/heads/tanren%2Frun_42",
] as const;

export class ScriptedGitHubHttp implements GitHubHttpClient {
  readonly requests: GitHubHttpRequest[] = [];
  private readonly firstPublicationAbsentRefs: Set<string>;

  constructor(
    private readonly responses: GitHubHttpResponse[],
    firstPublicationAbsentRefs: readonly string[] = DEFAULT_FIRST_PUBLICATION_ABSENT_REFS,
  ) {
    this.firstPublicationAbsentRefs = new Set(firstPublicationAbsentRefs);
  }

  async request(input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    this.requests.push({ ...input, token: "<redacted>" });
    // Only explicitly declared first-publication refs are absent. Any other
    // branch read remains in the strict response queue, so wrong refs, rework
    // heads, malformed bodies, and non-404 responses cannot be hidden here.
    if (input.method === "GET" && this.firstPublicationAbsentRefs.delete(input.path)) {
      return { status: 404, body: { message: "Not Found" } };
    }
    const response = this.responses.shift();
    if (response === undefined) {
      throw new Error(`unexpected GitHub request: ${input.method} ${input.path}`);
    }
    return response;
  }
}

export class RecordingPool {
  readonly updates: Array<{ runId: string; prUrl: string }> = [];
  readonly pushIntents = new Map<string, Record<string, unknown>>();

  async query(sql: string, params: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
    if (sql.includes("FROM github_push_intents") && sql.includes("status = 'pending'")) {
      const match = [...this.pushIntents.values()].find(
        (row) =>
          row.org_id === params[0] && row.spec_id === params[1] && row.branch === params[2] && row.status === "pending",
      );
      return { rows: match === undefined ? [] : [match], rowCount: match === undefined ? 0 : 1 };
    }
    if (sql.includes("FROM github_push_intents") && sql.includes("intent_id = $2")) {
      const row = this.pushIntents.get(String(params[1]));
      return { rows: row === undefined ? [] : [row], rowCount: row === undefined ? 0 : 1 };
    }
    if (sql.startsWith("INSERT INTO github_push_intents")) {
      const intentId = String(params[0]);
      const hasPending = [...this.pushIntents.values()].some(
        (row) =>
          row.org_id === params[1] && row.spec_id === params[4] && row.branch === params[6] && row.status === "pending",
      );
      if (!this.pushIntents.has(intentId) && !hasPending) {
        this.pushIntents.set(intentId, {
          intent_id: intentId,
          org_id: params[1],
          project_id: params[2],
          run_id: params[3],
          spec_id: params[4],
          repo_url: params[5],
          branch: params[6],
          intended_sha: params[7],
          source_ref: params[8],
          lease_predecessor_sha: params[9],
          status: "pending",
        });
      }
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE github_push_intents")) {
      const row = this.pushIntents.get(String(params[1]));
      if (row !== undefined && row.status === "pending" && row.intended_sha === params[2]) {
        row.status = "completed";
      }
      return { rows: [], rowCount: 1 };
    }
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
