import { describe, expect, it } from "vitest";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { FakeEventStore } from "../src/engine/eventStore.js";
import type { GovernancePosture, MergeIntegration } from "../src/engine/config/shared.js";
import { reduceReviewVerdict } from "../src/engine/providers/githubReviewMerge.js";
import {
  assessExternalChange,
  decidePosture,
  dispatchedIntegrationFor,
  mergeForRun,
  noopConflictResolver,
  reviewerRejection,
  tanrenIdentity,
  type ContributorProbe,
  type MergeProbe,
  type ReviewProbe
} from "../src/engine/workflow/reviewMerge/index.js";
import { pollReviewForRun } from "../src/engine/workflow/reviewMerge/reviewPolling.js";

describe("review verdict reduction", () => {
  it("changes_requested blocks even when a later approval exists from another reviewer", () => {
    expect(
      reduceReviewVerdict([
        { state: "approved", reviewer: "alice" },
        { state: "changes_requested", reviewer: "bob" }
      ]).verdict
    ).toBe("changes_requested");
  });

  it("uses the latest review per reviewer", () => {
    expect(
      reduceReviewVerdict([
        { state: "changes_requested", reviewer: "bob" },
        { state: "approved", reviewer: "bob" },
        { state: "approved", reviewer: "alice" }
      ]).verdict
    ).toBe("approved");
  });

  it("ignores comment/dismissed reviews and reports pending with none standing", () => {
    expect(reduceReviewVerdict([{ state: "commented", reviewer: "a" }]).verdict).toBe("pending");
    expect(reduceReviewVerdict([]).verdict).toBe("pending");
  });
});

describe("merge integration selection", () => {
  it("maps configured modes and treats not_configured as a hand-off", () => {
    expect(dispatchedIntegrationFor("direct_merge")).toBe("direct_merge");
    expect(dispatchedIntegrationFor("mergify_queue")).toBe("mergify_queue");
    expect(dispatchedIntegrationFor("external_reviewer")).toBe("external_reviewer");
    expect(dispatchedIntegrationFor("not_configured")).toBe("external_reviewer");
  });
});

describe("review polling stage", () => {
  it("marks ready, emits review.requested + review.approved on approval", async () => {
    const pool = new ReviewMergePool("direct_merge");
    const events = new FakeEventStore();
    const probe = approvingReviewProbe();

    const result = await pollReviewForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: new FakeSecretStore(),
      githubHttp: unusedHttp(),
      runId: "run_1",
      reviewProbe: probe
    });

    expect(result.verdict).toBe("approved");
    expect(probe.markedReady).toBe(true);
    const types = events.events.map((e) => e.eventType);
    expect(types).toContain("github.pr.ready");
    expect(types).toContain("review.requested");
    expect(types).toContain("review.approved");
    expect(pool.tasks.find((t) => t.kind === "review")?.status).toBe("done");
  });

  it("emits review.changes_requested carrying the reviewer feedback as steering", async () => {
    const pool = new ReviewMergePool("direct_merge");
    const events = new FakeEventStore();
    const probe: ReviewProbe = {
      markReady: async () => undefined,
      fetchVerdict: async () => ({ verdict: "changes_requested", latest: { state: "changes_requested", reviewer: "carol", body: "fix the edge case" } })
    };

    const result = await pollReviewForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: new FakeSecretStore(),
      githubHttp: unusedHttp(),
      runId: "run_1",
      reviewProbe: probe
    });

    expect(result.verdict).toBe("changes_requested");
    expect(result.feedback).toBe("fix the edge case");
    const changes = events.events.find((e) => e.eventType === "review.changes_requested");
    expect(changes?.payload).toMatchObject({ reviewer: "carol", message: "fix the edge case" });

    // The reviewer feedback becomes a planner-steering rejection.
    const rejection = reviewerRejection(result, "tanren/run_1");
    expect(rejection.producer).toBe("reviewer");
    expect(rejection.rejectionReason).toContain("fix the edge case");
    expect(rejection.rejectionReason).toContain("@carol");
  });
});

describe("merge dispatch stage", () => {
  it("direct_merge → GitHub merge → merge.completed", async () => {
    const pool = new ReviewMergePool("direct_merge");
    const events = new FakeEventStore();
    const probe = recordingMergeProbe({ merged: true, mergeSha: "deadbeef", conflict: false, status: 200, message: "merged" });

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: new FakeSecretStore(),
      githubHttp: unusedHttp(),
      runId: "run_1",
      mergeProbe: probe
    });

    expect(result.outcome).toBe("merged");
    expect(result.mergeSha).toBe("deadbeef");
    expect(probe.mergeCalls).toBe(1);
    const types = events.events.map((e) => e.eventType);
    expect(types).toContain("merge.queued");
    expect(types).toContain("merge.completed");
    expect(pool.tasks.find((t) => t.kind === "merge")?.status).toBe("done");
  });

  it("mergify_queue → applies the label → merge.queued only", async () => {
    const pool = new ReviewMergePool("mergify_queue");
    const events = new FakeEventStore();
    const probe = recordingMergeProbe({ merged: true, conflict: false, status: 200, message: "" });

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: new FakeSecretStore(),
      githubHttp: unusedHttp(),
      runId: "run_1",
      mergeProbe: probe,
      mergifyQueueLabel: "tanren:merge"
    });

    expect(result.outcome).toBe("queued");
    expect(probe.labels).toEqual(["tanren:merge"]);
    expect(probe.mergeCalls).toBe(0);
    const queued = events.events.find((e) => e.eventType === "merge.queued");
    expect(queued?.payload).toMatchObject({ integration: "mergify_queue", queueLabel: "tanren:merge" });
  });

  it("external_reviewer → hand-off, no merge call", async () => {
    const pool = new ReviewMergePool("external_reviewer");
    const events = new FakeEventStore();
    const probe = recordingMergeProbe({ merged: true, conflict: false, status: 200, message: "" });

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: new FakeSecretStore(),
      githubHttp: unusedHttp(),
      runId: "run_1",
      mergeProbe: probe
    });

    expect(result.outcome).toBe("handed_off");
    expect(probe.mergeCalls).toBe(0);
    expect(probe.labels).toEqual([]);
    expect(events.events.find((e) => e.eventType === "merge.queued")?.payload).toMatchObject({ integration: "external_reviewer" });
  });

  it("merge conflict → merge.conflict + recoverable (running) task, resolver hook invoked", async () => {
    const pool = new ReviewMergePool("direct_merge");
    const events = new FakeEventStore();
    const probe = recordingMergeProbe({ merged: false, conflict: true, status: 409, message: "merge conflict" });
    let hookCalls = 0;

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: new FakeSecretStore(),
      githubHttp: unusedHttp(),
      runId: "run_1",
      mergeProbe: probe,
      resolveConflict: async (ctx) => {
        hookCalls += 1;
        expect(ctx.baseBranch).toBe("main");
        return { resolved: false };
      }
    });

    expect(result.outcome).toBe("conflict");
    expect(hookCalls).toBe(1);
    const conflict = events.events.find((e) => e.eventType === "merge.conflict");
    expect(conflict?.payload).toMatchObject({ baseBranch: "main", message: "merge conflict" });
    // recoverable: the merge task stays running for the recovery surface.
    expect(pool.tasks.find((t) => t.kind === "merge")?.status).toBe("running");
  });

  it("noopConflictResolver does not resolve", async () => {
    expect(await noopConflictResolver({ runId: "r", prUrl: "u", prNumber: 1, baseBranch: "main", message: "x" })).toEqual({
      resolved: false
    });
  });
});

describe("external-change detection", () => {
  const identity = tanrenIdentity(["tanren[bot]", "App/123"]);

  it("flags a non-Tanren login as an external change", () => {
    const out = assessExternalChange({ logins: ["tanren[bot]", "alice"] }, identity);
    expect(out.hasExternalChange).toBe(true);
    expect(out.externalLogins).toEqual(["alice"]);
  });

  it("treats a Tanren-only PR as having no external change (case-insensitive)", () => {
    const out = assessExternalChange({ logins: ["Tanren[bot]", "app/123", "tanren[bot]"] }, identity);
    expect(out.hasExternalChange).toBe(false);
    expect(out.externalLogins).toEqual([]);
  });

  it("treats an unattributed (empty) login as external and de-duplicates", () => {
    const out = assessExternalChange({ logins: ["", "", "bob", "bob"] }, identity);
    expect(out.hasExternalChange).toBe(true);
    expect(out.externalLogins).toEqual(["<unknown>", "bob"]);
  });

  it("with no Tanren identity, every contributor is external", () => {
    const out = assessExternalChange({ logins: ["tanren[bot]"] }, tanrenIdentity([]));
    expect(out.hasExternalChange).toBe(true);
  });
});

describe("posture decision", () => {
  const external = assessExternalChange({ logins: ["alice"] }, tanrenIdentity(["tanren[bot]"]));
  const internal = assessExternalChange({ logins: ["tanren[bot]"] }, tanrenIdentity(["tanren[bot]"]));

  it("open always proceeds", () => {
    expect(decidePosture("open", external).kind).toBe("proceed");
    expect(decidePosture("open", internal).kind).toBe("proceed");
  });

  it("strict blocks an external change, proceeds on Tanren-only", () => {
    expect(decidePosture("strict", external).kind).toBe("block");
    expect(decidePosture("strict", internal).kind).toBe("proceed");
  });

  it("audit_only observes an external change, proceeds on Tanren-only", () => {
    expect(decidePosture("audit_only", external).kind).toBe("observe");
    expect(decidePosture("audit_only", internal).kind).toBe("proceed");
  });
});

describe("governance posture gate at the merge decision", () => {
  const externalProbe: ContributorProbe = { listContributors: async () => ({ logins: ["tanren[bot]", "mallory"] }) };
  const internalProbe: ContributorProbe = { listContributors: async () => ({ logins: ["tanren[bot]"] }) };

  it("strict + external change → merge.blocked (operator_approval), no merge call, task left running", async () => {
    const pool = new ReviewMergePool("direct_merge", "strict");
    const events = new FakeEventStore();
    const probe = recordingMergeProbe({ merged: true, mergeSha: "x", conflict: false, status: 200, message: "merged" });

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: new FakeSecretStore(),
      githubHttp: unusedHttp(),
      runId: "run_1",
      mergeProbe: probe,
      contributorProbe: externalProbe
    });

    expect(result.outcome).toBe("blocked");
    expect(probe.mergeCalls).toBe(0);
    const blocked = events.events.find((e) => e.eventType === "merge.blocked");
    expect(blocked?.payload).toMatchObject({ posture: "strict", mode: "operator_approval", externalLogins: ["mallory"] });
    expect(pool.tasks.find((t) => t.kind === "merge")?.status).toBe("running");
  });

  it("audit_only + external change → merge.blocked (audit_only), no merge call", async () => {
    const pool = new ReviewMergePool("direct_merge", "audit_only");
    const events = new FakeEventStore();
    const probe = recordingMergeProbe({ merged: true, conflict: false, status: 200, message: "merged" });

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: new FakeSecretStore(),
      githubHttp: unusedHttp(),
      runId: "run_1",
      mergeProbe: probe,
      contributorProbe: externalProbe
    });

    expect(result.outcome).toBe("blocked");
    expect(probe.mergeCalls).toBe(0);
    expect(events.events.find((e) => e.eventType === "merge.blocked")?.payload).toMatchObject({ posture: "audit_only", mode: "audit_only" });
  });

  it("strict + Tanren-only change → proceeds to a real merge", async () => {
    const pool = new ReviewMergePool("direct_merge", "strict");
    const events = new FakeEventStore();
    const probe = recordingMergeProbe({ merged: true, mergeSha: "deadbeef", conflict: false, status: 200, message: "merged" });

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: new FakeSecretStore(),
      githubHttp: unusedHttp(),
      runId: "run_1",
      mergeProbe: probe,
      contributorProbe: internalProbe
    });

    expect(result.outcome).toBe("merged");
    expect(probe.mergeCalls).toBe(1);
    expect(events.events.find((e) => e.eventType === "merge.blocked")).toBeUndefined();
  });

  it("open + external change → proceeds (coexists), merge happens", async () => {
    const pool = new ReviewMergePool("direct_merge", "open");
    const events = new FakeEventStore();
    const probe = recordingMergeProbe({ merged: true, mergeSha: "abc", conflict: false, status: 200, message: "merged" });

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: new FakeSecretStore(),
      githubHttp: unusedHttp(),
      runId: "run_1",
      mergeProbe: probe,
      contributorProbe: externalProbe
    });

    expect(result.outcome).toBe("merged");
    expect(probe.mergeCalls).toBe(1);
  });
});

// --- harness -------------------------------------------------------------

function unusedHttp() {
  return { request: async () => { throw new Error("HTTP should not be called when a probe is injected"); } };
}

function approvingReviewProbe(): ReviewProbe & { markedReady: boolean } {
  const probe = {
    markedReady: false,
    markReady: async () => {
      probe.markedReady = true;
    },
    fetchVerdict: async () => ({ verdict: "approved" as const, latest: { state: "approved" as const, reviewer: "alice" } })
  };
  return probe;
}

function recordingMergeProbe(result: { merged: boolean; mergeSha?: string; conflict: boolean; status: number; message: string }) {
  return {
    labels: [] as string[],
    mergeCalls: 0,
    async applyQueueLabel(label: string) {
      this.labels.push(label);
    },
    async merge() {
      this.mergeCalls += 1;
      return result;
    }
  } satisfies MergeProbe & { labels: string[]; mergeCalls: number };
}

const eventsTableName = ["events"].join("");

class ReviewMergePool {
  readonly tasks: Array<Record<string, unknown>> = [];
  readonly events: Array<Record<string, unknown>> = [];
  readonly runs = [{ run_id: "run_1", spec_id: "spec_1", project_id: "project_1", pr_url: "https://github.com/cat-cave/fix/pull/7" }];

  constructor(
    private readonly mergeIntegration: MergeIntegration,
    private readonly governancePosture: GovernancePosture = "open"
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
                    credentials: { githubCredentialRef: "credential/github/dev" }
                  },
                  default_branch: "main",
                  org_config: null
                }
              ],
        rowCount: run === undefined ? 0 : 1
      };
    }
    if (sql.includes("FROM tasks") && sql.includes("LIMIT 1")) {
      const kind = sql.includes("kind = 'review'") ? "review" : "merge";
      const task = this.tasks.find((t) => t.run_id === params[0] && t.kind === kind);
      return { rows: task === undefined ? [] : [task], rowCount: task === undefined ? 0 : 1 };
    }
    if (sql.startsWith("INSERT INTO tasks")) {
      const kind = String(sql.includes("'review'") ? "review" : "merge");
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
