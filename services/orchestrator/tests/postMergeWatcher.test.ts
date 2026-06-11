// Unit tests for the post-merge auto-issue watcher (tempering.md dimension A).
// Over a fake pool + the in-memory VcsProvider fake + a recording event store + an
// in-memory atomic claim store (no Postgres, no network), they prove:
//   - a post-merge CI FAILURE on the base branch opens EXACTLY ONE tracking issue
//     with the failing checks + links + the post-merge label, and records
//     merge.post_merge_failed + issue.opened,
//   - a post-merge PASS opens NO issue, and a post-merge PENDING opens NO issue
//     (re-checked on the next wake; neither consumes the claim),
//   - a not-yet-merged run (no merge.completed) is a no-op,
//   - single-process idempotency: a second check after a filed issue opens no
//     duplicate (the `filed` claim short-circuits via the fast-path),
//   - CROSS-PROCESS race (the shipped gap): two watchers over the SAME merged run
//     against a SHARED claim store, both reaching the guard before either finishes
//     filing — EXACTLY ONE createIssue + one issue.opened,
//   - create-failure releases the claim so a later wake retries (at-most-once, not
//     permanently suppressed).

import { describe, expect, it } from "vitest";
import type pg from "pg";
import { getJobOrgId } from "@tanren/db";
import { PostMergeWatcher, POST_MERGE_FAILURE_LABEL } from "../src/engine/postMerge/watcher.js";
import type { PostMergeIssueClaimInput, PostMergeIssueClaimStore } from "../src/engine/postMerge/issueClaimStore.js";
import type { EventStore, AppendEventInput } from "../src/engine/eventStore.js";
import type { EventName } from "../src/engine/events/index.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { inertGitHubHttp } from "./helpers/githubHttp.js";
import type { GitHubPullRequestChecks } from "../src/engine/providers/github.js";
import type { CodeHost } from "../src/engine/contracts/codeHost.js";
import type { ProjectHostSeams } from "../src/engine/providers/hostFactory.js";
import {
  harden,
  type TrackingIssueInput,
  type VisibilityProjection,
} from "../src/engine/contracts/visibilityProjection.js";

const RUN_ID = "run_pm";
const PROJECT_ID = "project_pm";
const SPEC_ID = "spec_pm";
const ORG_ID = "org_pm";
const PR_URL = "https://github.com/acme/widget/pull/12";
const PR_NUMBER = 12;
const BASE_BRANCH = "main";
const CODEX_ORG_REF = "credential/codex/org_pm/default";
const GITHUB_ORG_REF = "credential/github/org_pm/default";

interface FakePoolState {
  /** Whether the run has a merge.completed event (and its merge sha). */
  merged?: { mergeSha?: string };
  projectConfig?: unknown;
  orgConfig?: unknown;
}

function defaultOrgConfig() {
  return {
    version: 1,
    defaultCredentials: {
      defaultLlm: { cli: "codex", model: "default", authRef: CODEX_ORG_REF },
      github_token: GITHUB_ORG_REF,
    },
  };
}

/**
 * A fake pool answering the watcher's system-scoped reads:
 *   - SELECT payload FROM events ... event_type = 'merge.completed'
 *   - SELECT org_id FROM projects WHERE project_id = $1 (claim-org resolution)
 *   - the loadReviewMergeRunContext join (runs ⋈ projects ⋈ organizations)
 */
function fakePool(state: FakePoolState): pg.Pool {
  const client = {
    // eslint-disable-next-line @typescript-eslint/require-await
    query: async (sql: string, params: unknown[] = []) => {
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
      if (/org_id FROM projects WHERE project_id/u.test(sql)) {
        return { rows: [{ org_id: ORG_ID }], rowCount: 1 };
      }
      if (text.startsWith("SELECT config FROM organizations WHERE id = $1")) {
        const orgId = params[0];
        return orgId === ORG_ID
          ? { rows: [{ config: state.orgConfig ?? defaultOrgConfig() }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (/SELECT r\.org_id, r\.project_id, r\.spec_id, p\.config/u.test(sql)) {
        return {
          rows: [
            {
              org_id: ORG_ID,
              project_id: PROJECT_ID,
              spec_id: SPEC_ID,
              config: state.projectConfig ?? { version: 1 },
            },
          ],
          rowCount: 1,
        };
      }
      if (/FROM runs r/u.test(sql)) {
        return {
          rows: [
            {
              run_id: RUN_ID,
              spec_id: SPEC_ID,
              project_id: PROJECT_ID,
              pr_url: PR_URL,
              config: state.projectConfig ?? { version: 1 },
              default_branch: BASE_BRANCH,
              org_config: state.orgConfig ?? defaultOrgConfig(),
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

/**
 * A recording event store (test fixture): captures appends, never touches Postgres.
 * It also captures the AMBIENT per-job org id at append time — the real
 * `PgEventStore` resolves its write client through the throwing scope seam, so an
 * append with no scope would hit `MissingOrgScopeError`. Recording `ambientOrgId`
 * lets a test PROVE the watcher now files its run-timeline events under the run's
 * resolved org scope (not unscoped → throw/lost).
 */
class RecordingEventStore implements EventStore {
  readonly appends: Array<{ eventType: EventName; payload: unknown; runId?: string; ambientOrgId?: string }> = [];
  // eslint-disable-next-line @typescript-eslint/require-await
  async append<N extends EventName>(input: AppendEventInput<N>): Promise<void> {
    this.appends.push({
      eventType: input.eventType,
      payload: input.payload,
      runId: input.runId,
      ambientOrgId: getJobOrgId(),
    });
  }
  typesAppended(): EventName[] {
    return this.appends.map((a) => a.eventType);
  }
}

/**
 * An in-memory ATOMIC claim store (test fixture) modeling the Postgres
 * `INSERT ... ON CONFLICT (run_id) DO NOTHING` semantics: `claim` is the single
 * serialization point — exactly one caller per run wins. Because JS is single-
 * threaded, the synchronous Map mutation in `claim` is itself atomic, so two
 * interleaved `claim()` calls for the same run can never both win — exactly what
 * the cross-process Postgres lock guarantees.
 */
class InMemoryClaimStore implements PostMergeIssueClaimStore {
  private readonly rows = new Map<string, { status: "claimed" | "filed" }>();
  claimCount = 0;
  // eslint-disable-next-line @typescript-eslint/require-await
  async claim(input: PostMergeIssueClaimInput): Promise<boolean> {
    this.claimCount += 1;
    // ON CONFLICT (run_id) DO NOTHING → a row already exists, so this caller loses.
    if (this.rows.has(input.runId)) return false;
    this.rows.set(input.runId, { status: "claimed" });
    return true;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async markFiled(runId: string): Promise<void> {
    const row = this.rows.get(runId);
    if (row !== undefined) row.status = "filed";
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async release(runId: string): Promise<void> {
    const row = this.rows.get(runId);
    if (row?.status === "claimed") this.rows.delete(runId);
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async exists(runId: string): Promise<boolean> {
    return this.rows.has(runId);
  }
  /** Test helper: seed an already-filed claim (a prior wake handled this merge). */
  seedFiled(runId: string): void {
    this.rows.set(runId, { status: "filed" });
  }
}

/**
 * A scripted `ProjectHostSeams` (the watcher's §5e/§6 seam, injected via `buildHostSeams`).
 * `codeHost.readBranchChecks` returns the scripted post-merge CI state for the base branch
 * (failure / pass / pending); `visibility.openTrackingIssue` records the filed issues (so the
 * `seams.createdIssues` assertions hold — the watcher files through the best-effort projection,
 * never a removed `VcsProvider` method). `failCreate` makes the issue publish throw (proving the
 * claim is released). The visibility is `harden`-ed (the watcher only ever holds the safe surface).
 */
class ScriptedHostSeams {
  readonly createdIssues: Array<{ title: string; body: string; labels: ReadonlyArray<string> }> = [];
  constructor(
    private readonly outcome: "fail" | "pass" | "pending",
    private readonly failCreate = false,
  ) {}

  private async readBranchChecks(): Promise<GitHubPullRequestChecks> {
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

  private async openTrackingIssue(input: TrackingIssueInput): Promise<{ number: number; url: string }> {
    if (this.failCreate) throw new Error("GitHub issue create failed: HTTP 503");
    this.createdIssues.push({ title: input.title, body: input.body, labels: input.labels ?? [] });
    const number = this.createdIssues.length;
    return { number, url: `https://github.com/cat-cave/fix/issues/${number}` };
  }

  /** Build the `{ codeHost, visibility }` pair the watcher consumes — only the two methods it uses. */
  seams(): ProjectHostSeams {
    const codeHost = { readBranchChecks: () => this.readBranchChecks() } as unknown as CodeHost;
    const raw: VisibilityProjection = { openTrackingIssue: (input) => this.openTrackingIssue(input) };
    return { codeHost, visibility: harden(raw) };
  }
}

/**
 * A recording `SecretStore` that captures the credential ref the watcher's token resolution
 * reads (the static `github_token` ref) — so a test can PROVE the run-resolved org-default ref
 * is threaded into post-merge token resolution. Returns a stub token value for the expected ref.
 */
class RecordingSecretStore extends InMemorySecretStore {
  readonly reads: Array<string> = [];
  override async get(ref: string): Promise<{ ref: string; value: string } | undefined> {
    this.reads.push(ref);
    return { ref, value: "stub-token" };
  }
}

function makeWatcher(args: {
  state: FakePoolState;
  outcome: "fail" | "pass" | "pending";
  claims?: InMemoryClaimStore;
  failCreate?: boolean;
  secrets?: RecordingSecretStore;
}): { watcher: PostMergeWatcher; vcs: ScriptedHostSeams; events: RecordingEventStore; claims: InMemoryClaimStore } {
  const vcs = new ScriptedHostSeams(args.outcome, args.failCreate ?? false);
  const events = new RecordingEventStore();
  const claims = args.claims ?? new InMemoryClaimStore();
  const watcher = new PostMergeWatcher({
    pool: fakePool(args.state),
    // The watcher's token resolution runs the REAL static-credential resolver, which reads
    // the `github_token` secret at the run-resolved ref — the recording store returns a stub
    // token for any ref so resolution succeeds without a live secret store.
    secrets: args.secrets ?? new RecordingSecretStore(),
    githubHttp: inertGitHubHttp(),
    eventStore: events,
    claimStore: claims,
    buildHostSeams: () => vcs.seams(),
  });
  return { watcher, vcs, events, claims };
}

describe("PostMergeWatcher", () => {
  it("opens exactly ONE issue on a post-merge CI failure, with the failing checks + links + label", async () => {
    const { watcher, vcs, events } = makeWatcher({ state: { merged: { mergeSha: "abc123" } }, outcome: "fail" });

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

    // Both events recorded; issue.opened is the durable record.
    expect(events.typesAppended()).toEqual(["merge.post_merge_failed", "issue.opened"]);
    const failed = events.appends[0]!.payload as { failingChecks: Array<{ name: string }>; prNumber: number };
    expect(failed.failingChecks.map((c) => c.name)).toEqual(["build"]);
    expect(failed.prNumber).toBe(PR_NUMBER);
    const opened = events.appends[1]!.payload as { issueUrl: string; label: string; reason: string };
    expect(opened.reason).toBe("post_merge_failure");
    expect(opened.label).toBe(POST_MERGE_FAILURE_LABEL);
    expect(opened.issueUrl.length).toBeGreaterThan(0);
  });

  it("files its run-timeline events UNDER the run's org scope (not unscoped → MissingOrgScopeError)", async () => {
    // Regression: the watcher wakes on the run-activity bus with NO ambient scope,
    // and its inner system-scoped reads have already closed. The two `eventStore`
    // appends are tenant-table writes — the real `PgEventStore` resolves its client
    // through the throwing scope seam, so an UNSCOPED append throws
    // MissingOrgScopeError (caught/logged → the GitHub issue is created but these
    // run-timeline events silently LOST). The fix wraps the appends in the run's
    // resolved org scope; here we prove both appends saw the run's org id ambient.
    const { watcher, events } = makeWatcher({ state: { merged: { mergeSha: "abc123" } }, outcome: "fail" });
    await watcher.check(RUN_ID);
    expect(events.typesAppended()).toEqual(["merge.post_merge_failed", "issue.opened"]);
    // Both appends ran with the run's org id on the ambient per-job store — the GUC
    // a real PgEventStore would carry into its short runWithOrgScope txn.
    expect(events.appends.map((a) => a.ambientOrgId)).toEqual([ORG_ID, ORG_ID]);
  });

  it("threads the run-resolved org-default GitHub credential into post-merge token resolution", async () => {
    // Regression: merge/review already resolve project-record/org-default refs and
    // pass them into loadReviewMergeRunContext, but post-merge used to call the
    // loader without that option. With no project JSONB credential, a real provider
    // then saw no staticRef and threw NoGithubCredentialConfiguredError.
    const secrets = new RecordingSecretStore();
    const { watcher, vcs } = makeWatcher({
      state: {
        merged: { mergeSha: "abc123" },
        projectConfig: { version: 1 },
        orgConfig: defaultOrgConfig(),
      },
      outcome: "fail",
      secrets,
    });

    await watcher.check(RUN_ID);

    // The watcher's token resolution read the run-resolved org-default `github_token` ref.
    expect(secrets.reads).toContain(GITHUB_ORG_REF);
    expect(vcs.createdIssues).toHaveLength(1);
  });

  it("opens NO issue on a post-merge CI pass (and does not consume a claim)", async () => {
    const { watcher, vcs, events, claims } = makeWatcher({ state: { merged: {} }, outcome: "pass" });
    await watcher.check(RUN_ID);
    expect(vcs.createdIssues).toHaveLength(0);
    expect(events.appends).toHaveLength(0);
    expect(claims.claimCount).toBe(0);
  });

  it("opens NO issue while the post-merge CI is still pending (re-checked later, no claim consumed)", async () => {
    const { watcher, vcs, events, claims } = makeWatcher({ state: { merged: {} }, outcome: "pending" });
    await watcher.check(RUN_ID);
    expect(vcs.createdIssues).toHaveLength(0);
    expect(events.appends).toHaveLength(0);
    expect(claims.claimCount).toBe(0);
    // A pending CI left no claim, so a later wake (now failing) re-evaluates + files.
    expect(await claims.exists(RUN_ID)).toBe(false);
  });

  it("opens NO issue for a run that has not merged (no merge.completed)", async () => {
    const { watcher, vcs, events } = makeWatcher({ state: {}, outcome: "fail" });
    await watcher.check(RUN_ID);
    expect(vcs.createdIssues).toHaveLength(0);
    expect(events.appends).toHaveLength(0);
  });

  it("idempotency: opens NO second issue when one was already filed for the merge", async () => {
    const claims = new InMemoryClaimStore();
    claims.seedFiled(RUN_ID);
    const { watcher, vcs, events } = makeWatcher({
      state: { merged: { mergeSha: "abc123" } },
      outcome: "fail",
      claims,
    });
    await watcher.check(RUN_ID);
    expect(vcs.createdIssues).toHaveLength(0);
    expect(events.appends).toHaveLength(0);
  });

  it("idempotency: a second check after a failure (claim now filed) opens no duplicate", async () => {
    // Two SEPARATE watcher instances sharing ONE claim store — mirrors two sequential
    // wakes (or two workers) for the same merge. The first files; the second skips.
    const claims = new InMemoryClaimStore();
    const first = makeWatcher({ state: { merged: { mergeSha: "abc123" } }, outcome: "fail", claims });
    await first.watcher.check(RUN_ID);
    expect(first.vcs.createdIssues).toHaveLength(1);

    const second = makeWatcher({ state: { merged: { mergeSha: "abc123" } }, outcome: "fail", claims });
    await second.watcher.check(RUN_ID);
    expect(second.vcs.createdIssues).toHaveLength(0);
    expect(second.events.appends).toHaveLength(0);
  });

  it("CROSS-PROCESS race: two watchers on the same merge against a shared store open EXACTLY ONE issue", async () => {
    // The shipped-green gap: two worker processes both wake on the SAME
    // merge.completed NOTIFY and both reach the guard before either finishes filing.
    // A shared atomic claim store must let exactly one win. We run both check()
    // calls CONCURRENTLY (Promise.all) so neither has filed before the other claims.
    const claims = new InMemoryClaimStore();
    const a = makeWatcher({ state: { merged: { mergeSha: "abc123" } }, outcome: "fail", claims });
    const b = makeWatcher({ state: { merged: { mergeSha: "abc123" } }, outcome: "fail", claims });

    await Promise.all([a.watcher.check(RUN_ID), b.watcher.check(RUN_ID)]);

    // EXACTLY ONE createIssue across BOTH processes, and exactly one issue.opened.
    const totalIssues = a.vcs.createdIssues.length + b.vcs.createdIssues.length;
    expect(totalIssues).toBe(1);
    const totalOpened =
      a.events.typesAppended().filter((t) => t === "issue.opened").length +
      b.events.typesAppended().filter((t) => t === "issue.opened").length;
    expect(totalOpened).toBe(1);
    // Both raced to the atomic claim; only one won it.
    expect(claims.claimCount).toBe(2);
    expect(await claims.exists(RUN_ID)).toBe(true);
  });

  it("a createIssue FAILURE releases the claim so a later wake retries (at-most-once, not suppressed)", async () => {
    const claims = new InMemoryClaimStore();
    // First wake: createIssue throws → the watcher releases the claim + rethrows.
    const failing = makeWatcher({
      state: { merged: { mergeSha: "abc123" } },
      outcome: "fail",
      claims,
      failCreate: true,
    });
    await expect(failing.watcher.check(RUN_ID)).rejects.toThrow(/issue create failed/u);
    expect(failing.vcs.createdIssues).toHaveLength(0);
    // The claim was RELEASED — not left behind to permanently suppress the issue.
    expect(await claims.exists(RUN_ID)).toBe(false);

    // A later wake (GitHub recovered) re-claims + files the one issue.
    const retry = makeWatcher({ state: { merged: { mergeSha: "abc123" } }, outcome: "fail", claims });
    await retry.watcher.check(RUN_ID);
    expect(retry.vcs.createdIssues).toHaveLength(1);
    expect(await claims.exists(RUN_ID)).toBe(true);
  });

  it("an empty run id is a no-op", async () => {
    const { watcher, vcs, events } = makeWatcher({ state: { merged: {} }, outcome: "fail" });
    await watcher.check("");
    expect(vcs.createdIssues).toHaveLength(0);
    expect(events.appends).toHaveLength(0);
  });
});
