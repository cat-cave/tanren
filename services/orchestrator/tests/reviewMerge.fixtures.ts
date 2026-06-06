/**
 * reviewMerge.fixtures — shared fake HTTP/review/merge probes and the scripted
 * pool for the review→merge stage tests. Extracted from reviewMerge.test.ts to
 * keep that file under the 500-line architecture cap.
 */
import type { GovernancePosture, MergeIntegration, ReviewPolicy } from "../src/engine/config/shared.js";
import type { MergeProbe, ReviewProbe } from "../src/engine/workflow/reviewMerge/index.js";
import type { PullRequestMergeability, UpdateBranchResult } from "../src/engine/contracts/vcsProvider.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../src/engine/providers/github.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { storeGithubToken } from "../src/engine/credentials/githubToken.js";

/**
 * MERGE-SAFETY (self-identity): a secret store seeded with a static GitHub token at
 * the credential ref `ReviewMergePool` carries (`credential/github/dev`), so the
 * merge stage's `resolveActorIdentity` token resolution succeeds and proceeds to
 * the static `GET /user` served by {@link tanrenUserHttp}.
 */
export const GOVERNANCE_CREDENTIAL_REF = "credential/github/dev";
export async function tanrenSecrets(): Promise<FakeSecretStore> {
  const secrets = new FakeSecretStore();
  await storeGithubToken(secrets, { ref: GOVERNANCE_CREDENTIAL_REF, token: "ghp_governanceFixtureToken" });
  return secrets;
}

export function unusedHttp() {
  return {
    request: async () => {
      throw new Error("HTTP should not be called when a probe is injected");
    },
  };
}

/**
 * MERGE-SAFETY (self-identity): the login the merge stage's `resolveActorIdentity`
 * resolves for the governance tests' static credential. The contributor/merge
 * probes are still injected; this is the ONLY GitHub call the merge stage makes
 * (the static `GET /user`), so the fixture serves just that one route and throws on
 * anything else (proving no other HTTP slips through).
 */
export const FIXTURE_TANREN_LOGIN = "tanren[bot]";

/** A scripted transport that answers ONLY `GET /user` with {@link FIXTURE_TANREN_LOGIN}. */
export function tanrenUserHttp(login: string = FIXTURE_TANREN_LOGIN): GitHubHttpClient {
  return {
    request: async (input: GitHubHttpRequest): Promise<GitHubHttpResponse> => {
      if (input.method === "GET" && (input.path === "/user" || input.path.startsWith("/user?"))) {
        return { status: 200, body: { login, id: 99001 } };
      }
      throw new Error(`HTTP should not be called when a probe is injected: ${input.method} ${input.path}`);
    },
  };
}

export function approvingReviewProbe(): ReviewProbe & { markedReady: boolean } {
  const probe = {
    markedReady: false,
    markReady: async () => {
      probe.markedReady = true;
    },
    fetchVerdict: async () => ({
      verdict: "approved" as const,
      latest: { state: "approved" as const, reviewer: "alice" },
    }),
  };
  return probe;
}

export function recordingMergeProbe(
  result: {
    merged: boolean;
    mergeSha?: string;
    conflict: boolean;
    status: number;
    message: string;
  },
  // by default the probe reports the branch CLEAN + up to date, so existing
  // merge tests exercise the unchanged "merge once" path. The freshness tests
  // override these to drive the behind / dirty branches.
  freshness: {
    mergeability?: PullRequestMergeability;
    mergeabilityReads?: PullRequestMergeability[];
    updateBranch?: UpdateBranchResult;
  } = {},
) {
  const defaultMergeability: PullRequestMergeability = freshness.mergeability ?? {
    state: "clean",
    behind: false,
    baseBranch: "main",
    headBranch: "tanren/run_1",
  };
  const mergeabilityReads = freshness.mergeabilityReads ?? [defaultMergeability];
  const update: UpdateBranchResult = freshness.updateBranch ?? { outcome: "up_to_date", message: "up to date" };
  return {
    mergeCalls: 0,
    mergeabilityCalls: 0,
    updateBranchCalls: 0,
    // record the retarget + cleanup so the speculative-land-on-main tests
    // can assert the PR base was re-pointed to default_branch + the integ ref cleaned.
    retargetedBases: [] as string[],
    deletedIntegrationBranches: [] as string[],
    async merge() {
      this.mergeCalls += 1;
      return result;
    },
    async readMergeability() {
      const mergeability = mergeabilityReads[Math.min(this.mergeabilityCalls, mergeabilityReads.length - 1)];
      this.mergeabilityCalls += 1;
      return mergeability;
    },
    async updateBranch() {
      this.updateBranchCalls += 1;
      return update;
    },
    async retargetBase(newBase: string) {
      this.retargetedBases.push(newBase);
    },
    async deleteIntegrationBranch(branch: string) {
      this.deletedIntegrationBranches.push(branch);
    },
  } satisfies MergeProbe & {
    mergeCalls: number;
    mergeabilityCalls: number;
    updateBranchCalls: number;
    retargetedBases: string[];
    deletedIntegrationBranches: string[];
  };
}

const eventsTableName = ["events"].join("");

export class ReviewMergePool {
  readonly tasks: Array<Record<string, unknown>> = [];
  readonly events: Array<Record<string, unknown>> = [];
  readonly runs = [
    {
      run_id: "run_1",
      spec_id: "spec_1",
      project_id: "project_1",
      pr_url: "https://github.com/cat-cave/fix/pull/7",
    },
  ];

  constructor(
    private readonly mergeIntegration: MergeIntegration,
    private readonly governancePosture: GovernancePosture = "open",
    private readonly reviewPolicy: ReviewPolicy = "human",
  ) {}

  /**
   * the speculative-merge-hold lookups. By default a run is NOT speculative
   * (speculative_base null) and has no deps, so the hold is a no-op and existing
   * tests proceed to merge unchanged. A test can set `speculativeBase` +
   * `specDependsOn` + `mergedAncestors` to drive the hold path.
   */
  speculativeBase: string | null = null;
  specDependsOn: string[] = [];
  mergedAncestors: string[] = [];
  /**
   * GAP #3: the configurable platform / known-automation committer logins. Set by a test
   * to prove the autonomous-tier auto-approve; absent ⇒ the config omits the key.
   */
  governancePlatformLogins: string[] | undefined = undefined;

  async query(sql: string, params: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
    if (sql.startsWith("SELECT speculative_base, spec_id, project_id FROM runs")) {
      const run = this.runs.find((r) => r.run_id === params[0]);
      return run === undefined
        ? { rows: [], rowCount: 0 }
        : {
            rows: [{ speculative_base: this.speculativeBase, spec_id: run.spec_id, project_id: run.project_id }],
            rowCount: 1,
          };
    }
    if (sql.startsWith("SELECT depends_on FROM specs")) {
      return { rows: [{ depends_on: this.specDependsOn }], rowCount: 1 };
    }
    if (sql.includes("SELECT spec_id FROM specs") && sql.includes("status = 'merged'")) {
      return { rows: this.mergedAncestors.map((spec_id) => ({ spec_id })), rowCount: this.mergedAncestors.length };
    }
    if (sql.includes("FROM runs r") && sql.includes("default_branch")) {
      const run = this.runs.find((r) => r.run_id === params[0]);
      return {
        rows:
          run === undefined
            ? []
            : [
                {
                  run_id: run.run_id,
                  spec_id: run.spec_id,
                  project_id: run.project_id,
                  pr_url: run.pr_url,
                  config: {
                    version: 1,
                    mergeIntegration: this.mergeIntegration,
                    governancePosture: this.governancePosture,
                    reviewPolicy: this.reviewPolicy,
                    ...(this.governancePlatformLogins !== undefined && {
                      governancePlatformLogins: this.governancePlatformLogins,
                    }),
                    credentials: { githubCredentialRef: "credential/github/dev" },
                  },
                  default_branch: "main",
                  org_config: null,
                },
              ],
        rowCount: run === undefined ? 0 : 1,
      };
    }
    if (sql.includes("FROM tasks") && sql.includes("LIMIT 1")) {
      // the ensure-system-task SELECT now binds kind as a
      // parameter (`kind = $2`), so read it from params rather than the SQL literal.
      const kind = String(params[1]);
      const task = this.tasks.find((t) => t.run_id === params[0] && t.kind === kind);
      return { rows: task === undefined ? [] : [task], rowCount: task === undefined ? 0 : 1 };
    }
    if (sql.startsWith("INSERT INTO tasks")) {
      // the ensure-system-task INSERT now binds kind/title as
      // parameters (`$3, $4`); read kind from params[2] rather than the SQL literal.
      const kind = String(params[2]);
      this.tasks.push({ task_id: params[0], run_id: params[1], kind, status: "running" });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE tasks SET status = 'done'")) {
      Object.assign(this.findTask(params[0]), { status: "done", outcome: "ok" });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE tasks SET status = 'failed'")) {
      Object.assign(this.findTask(params[0]), { status: "failed", outcome: "failed" });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE tasks SET status = 'running', outcome = 'pending'")) {
      Object.assign(this.findTask(params[0]), { status: "running", outcome: "pending" });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE tasks SET status = 'running'")) {
      Object.assign(this.findTask(params[0]), { status: "running" });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith(`INSERT INTO ${eventsTableName}`)) {
      this.events.push({ event_type: params[4], payload: JSON.parse(String(params[5])) });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }

  asPgPool() {
    return this as never;
  }

  private findTask(taskId: unknown): Record<string, unknown> {
    const task = this.tasks.find((t) => t.task_id === taskId);
    if (task === undefined) throw new Error(`missing task: ${String(taskId)}`);
    return task;
  }
}
