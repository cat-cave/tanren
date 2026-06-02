/**
 * reviewMerge.fixtures — shared fake HTTP/review/merge probes and the scripted
 * pool for the review→merge stage tests. Extracted from reviewMerge.test.ts to
 * keep that file under the 500-line architecture cap.
 */
import type { GovernancePosture, MergeIntegration, ReviewPolicy } from "../src/engine/config/shared.js";
import type { MergeProbe, ReviewProbe } from "../src/engine/workflow/reviewMerge/index.js";
import type { PullRequestMergeability, UpdateBranchResult } from "../src/engine/contracts/vcsProvider.js";

export function unusedHttp() {
  return {
    request: async () => {
      throw new Error("HTTP should not be called when a probe is injected");
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
  // P2a: by default the probe reports the branch CLEAN + up to date, so existing
  // merge tests exercise the unchanged "merge once" path. The freshness tests
  // override these to drive the behind / dirty branches.
  freshness: {
    mergeability?: PullRequestMergeability;
    updateBranch?: UpdateBranchResult;
  } = {},
) {
  const mergeability: PullRequestMergeability = freshness.mergeability ?? {
    state: "clean",
    behind: false,
    baseBranch: "main",
    headBranch: "tanren/run_1",
  };
  const update: UpdateBranchResult = freshness.updateBranch ?? { outcome: "up_to_date", message: "up to date" };
  return {
    labels: [] as string[],
    mergeCalls: 0,
    mergeabilityCalls: 0,
    updateBranchCalls: 0,
    async applyQueueLabel(label: string) {
      this.labels.push(label);
    },
    async merge() {
      this.mergeCalls += 1;
      return result;
    },
    async readMergeability() {
      this.mergeabilityCalls += 1;
      return mergeability;
    },
    async updateBranch() {
      this.updateBranchCalls += 1;
      return update;
    },
  } satisfies MergeProbe & {
    labels: string[];
    mergeCalls: number;
    mergeabilityCalls: number;
    updateBranchCalls: number;
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

  async query(sql: string, params: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
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
      // Plane-split P3c: the ensure-system-task SELECT now binds kind as a
      // parameter (`kind = $2`), so read it from params rather than the SQL literal.
      const kind = String(params[1]);
      const task = this.tasks.find((t) => t.run_id === params[0] && t.kind === kind);
      return { rows: task === undefined ? [] : [task], rowCount: task === undefined ? 0 : 1 };
    }
    if (sql.startsWith("INSERT INTO tasks")) {
      // Plane-split P3c: the ensure-system-task INSERT now binds kind/title as
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
