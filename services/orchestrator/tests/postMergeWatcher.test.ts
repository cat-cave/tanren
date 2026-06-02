// Unit tests for the post-merge auto-issue watcher (tempering.md dimension A).
// Over a fake pool + the in-memory VcsProvider fake + a recording event store
// (no Postgres, no network), they prove:
//   - a post-merge CI FAILURE on the base branch opens EXACTLY ONE tracking issue
//     with the failing checks + links + the post-merge label, and records
//     merge.post_merge_failed + issue.opened,
//   - a post-merge PASS opens NO issue,
//   - a post-merge PENDING opens NO issue (re-checked on the next wake),
//   - idempotency: a run that already has an issue.opened opens no second issue
//     (repeated checks / re-notification never spam a duplicate),
//   - a not-yet-merged run (no merge.completed) is a no-op.

import { describe, expect, it } from "vitest";
import type pg from "pg";
import { PostMergeWatcher, POST_MERGE_FAILURE_LABEL } from "../src/engine/postMerge/watcher.js";
import type { EventStore, AppendEventInput } from "../src/engine/eventStore.js";
import type { EventName } from "../src/engine/events/index.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { InMemoryVcsProvider } from "./conformance/fakes/inMemoryVcsProvider.js";
import type { GitHubPullRequestChecks } from "../src/engine/providers/github.js";
import type { RepoRef, ResolvedVcsToken } from "../src/engine/contracts/vcsProvider.js";

const RUN_ID = "run_pm";
const PROJECT_ID = "project_pm";
const SPEC_ID = "spec_pm";
const PR_URL = "https://github.com/acme/widget/pull/12";
const PR_NUMBER = 12;
const BASE_BRANCH = "main";

interface FakePoolState {
  /** Whether the run has a merge.completed event (and its merge sha). */
  merged?: { mergeSha?: string };
  /** Whether an issue.opened already exists for the run (idempotency seed). */
  alreadyOpened?: boolean;
}

/**
 * A fake pool answering the watcher's system-scoped reads:
 *   - SELECT payload FROM events ... event_type = 'merge.completed'
 *   - SELECT EXISTS (... event_type = 'issue.opened')
 *   - the loadReviewMergeRunContext join (runs ⋈ projects ⋈ organizations)
 */
function fakePool(state: FakePoolState): pg.Pool {
  const client = {
    // eslint-disable-next-line @typescript-eslint/require-await
    query: async (sql: string) => {
      const text = sql.trim();
      if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/u.test(text)) return { rows: [], rowCount: 0 };
      if (/event_type = 'merge\.completed'/u.test(sql)) {
        if (state.merged === undefined) return { rows: [], rowCount: 0 };
        return {
          rows: [
            {
              payload: {
                prNumber: PR_NUMBER,
                ...(state.merged.mergeSha !== undefined && { mergeSha: state.merged.mergeSha }),
              },
            },
          ],
          rowCount: 1,
        };
      }
      if (/event_type = 'issue\.opened'/u.test(sql)) {
        return { rows: [{ exists: state.alreadyOpened === true }], rowCount: 1 };
      }
      if (/FROM runs r/u.test(sql)) {
        return {
          rows: [
            {
              run_id: RUN_ID,
              spec_id: SPEC_ID,
              project_id: PROJECT_ID,
              pr_url: PR_URL,
              config: { version: 1 },
              default_branch: BASE_BRANCH,
              org_config: null,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  return { query: client.query, connect: async () => client } as unknown as pg.Pool;
}

/** A recording event store (test fixture): captures appends, never touches Postgres. */
class RecordingEventStore implements EventStore {
  readonly appends: Array<{ eventType: EventName; payload: unknown; runId?: string }> = [];
  // eslint-disable-next-line @typescript-eslint/require-await
  async append<N extends EventName>(input: AppendEventInput<N>): Promise<void> {
    this.appends.push({ eventType: input.eventType, payload: input.payload, runId: input.runId });
  }
  typesAppended(): EventName[] {
    return this.appends.map((a) => a.eventType);
  }
}

/**
 * The in-memory VcsProvider fake, with `readBranchChecks` overridden to return the
 * scripted post-merge CI state for the base branch (failure / pass / pending).
 */
class ScriptedVcsProvider extends InMemoryVcsProvider {
  constructor(private readonly outcome: "fail" | "pass" | "pending") {
    super();
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  override async readBranchChecks(_input: {
    repo: RepoRef;
    branch: string;
    token: ResolvedVcsToken;
  }): Promise<GitHubPullRequestChecks> {
    if (this.outcome === "fail") {
      return {
        head: { sha: "post-merge-sha" },
        checkRuns: [{ name: "build", status: "completed", conclusion: "failure", url: "https://ci/build/1" }],
        statuses: [],
      };
    }
    if (this.outcome === "pending") {
      return { head: { sha: "post-merge-sha" }, checkRuns: [{ name: "build", status: "in_progress" }], statuses: [] };
    }
    return {
      head: { sha: "post-merge-sha" },
      checkRuns: [{ name: "build", status: "completed", conclusion: "success" }],
      statuses: [],
    };
  }
}

function makeWatcher(args: { state: FakePoolState; outcome: "fail" | "pass" | "pending" }): {
  watcher: PostMergeWatcher;
  vcs: ScriptedVcsProvider;
  events: RecordingEventStore;
} {
  const vcs = new ScriptedVcsProvider(args.outcome);
  const events = new RecordingEventStore();
  const watcher = new PostMergeWatcher({
    pool: fakePool(args.state),
    secrets: new InMemorySecretStore(),
    vcsProvider: vcs,
    eventStore: events,
  });
  return { watcher, vcs, events };
}

describe("PostMergeWatcher", () => {
  it("opens exactly ONE issue on a post-merge CI failure, with the failing checks + links + label", async () => {
    const { watcher, vcs, events } = makeWatcher({
      state: { merged: { mergeSha: "abc123" } },
      outcome: "fail",
    });

    await watcher.check(RUN_ID);

    expect(vcs.createdIssues).toHaveLength(1);
    const issue = vcs.createdIssues[0]!;
    expect(issue.labels).toContain(POST_MERGE_FAILURE_LABEL);
    expect(issue.title).toContain(SPEC_ID);
    expect(issue.title).toContain(`#${PR_NUMBER}`);
    // Body carries the failing check, the merged PR link, the run, and the merge sha.
    expect(issue.body).toContain("build");
    expect(issue.body).toContain(PR_URL);
    expect(issue.body).toContain(RUN_ID);
    expect(issue.body).toContain("abc123");

    // Both events recorded; issue.opened is the idempotency marker.
    expect(events.typesAppended()).toEqual(["merge.post_merge_failed", "issue.opened"]);
    const failed = events.appends[0]!.payload as { failingChecks: Array<{ name: string }>; prNumber: number };
    expect(failed.failingChecks.map((c) => c.name)).toEqual(["build"]);
    expect(failed.prNumber).toBe(PR_NUMBER);
    const opened = events.appends[1]!.payload as { issueUrl: string; label: string; reason: string };
    expect(opened.reason).toBe("post_merge_failure");
    expect(opened.label).toBe(POST_MERGE_FAILURE_LABEL);
    expect(opened.issueUrl.length).toBeGreaterThan(0);
  });

  it("opens NO issue on a post-merge CI pass", async () => {
    const { watcher, vcs, events } = makeWatcher({ state: { merged: {} }, outcome: "pass" });
    await watcher.check(RUN_ID);
    expect(vcs.createdIssues).toHaveLength(0);
    expect(events.appends).toHaveLength(0);
  });

  it("opens NO issue while the post-merge CI is still pending (re-checked later)", async () => {
    const { watcher, vcs, events } = makeWatcher({ state: { merged: {} }, outcome: "pending" });
    await watcher.check(RUN_ID);
    expect(vcs.createdIssues).toHaveLength(0);
    expect(events.appends).toHaveLength(0);
  });

  it("opens NO issue for a run that has not merged (no merge.completed)", async () => {
    const { watcher, vcs, events } = makeWatcher({ state: {}, outcome: "fail" });
    await watcher.check(RUN_ID);
    expect(vcs.createdIssues).toHaveLength(0);
    expect(events.appends).toHaveLength(0);
  });

  it("idempotency: opens NO second issue when one was already filed for the merge", async () => {
    const { watcher, vcs, events } = makeWatcher({
      state: { merged: { mergeSha: "abc123" }, alreadyOpened: true },
      outcome: "fail",
    });
    await watcher.check(RUN_ID);
    expect(vcs.createdIssues).toHaveLength(0);
    expect(events.appends).toHaveLength(0);
  });

  it("idempotency: a second check after a failure (issue now recorded) opens no duplicate", async () => {
    // First pass: failing CI, no prior issue → files one. Then a second watcher
    // over the SAME run with the issue.opened marker present → no second issue.
    const first = makeWatcher({ state: { merged: { mergeSha: "abc123" } }, outcome: "fail" });
    await first.watcher.check(RUN_ID);
    expect(first.vcs.createdIssues).toHaveLength(1);

    const second = makeWatcher({
      state: { merged: { mergeSha: "abc123" }, alreadyOpened: true },
      outcome: "fail",
    });
    await second.watcher.check(RUN_ID);
    expect(second.vcs.createdIssues).toHaveLength(0);
    expect(second.events.appends).toHaveLength(0);
  });

  it("an empty run id is a no-op", async () => {
    const { watcher, vcs, events } = makeWatcher({ state: { merged: {} }, outcome: "fail" });
    await watcher.check("");
    expect(vcs.createdIssues).toHaveLength(0);
    expect(events.appends).toHaveLength(0);
  });
});
