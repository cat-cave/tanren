// Post-merge auto-issue creation (tempering.md dimension A — the last core
// run-loop item). After a run's PR merges onto `default_branch`, this watcher
// reads the post-merge CI on the BASE branch (reusing the VcsProvider
// `readBranchChecks` path + the SAME `evaluateCiObservation` evaluator the
// run/queue CI poll uses) for the merge commit. When that CI FAILS, it auto-opens
// ONE tracking issue via `VcsProvider.createIssue` so the regression is tracked,
// then records `merge.post_merge_failed` + `issue.opened`.
//
// It reuses the existing seams — NOT a new poller: the subscriber wakes it on the
// SAME run-activity bus the DagWalker / MergeCoordinator listen on, and it only
// acts once a run has a `merge.completed` event (the authoritative merge signal,
// which carries the merge sha). Token resolution + base-branch state route through
// the VcsProvider; the run context loads through the shared review/merge loader.
//
// IDEMPOTENCY (open at most ONE issue per merge, never spam): before filing, the
// watcher checks for a prior `issue.opened` event on the run — present ⇒ it already
// filed (or the post-merge CI already failed once and was tracked) and returns
// without a second issue. A pending post-merge CI files nothing and leaves no
// marker, so the NEXT bus wake re-checks; a passing post-merge CI files nothing.
// Only a genuine FAILURE files an issue + records the marker.

import { runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import type { EventStore } from "../eventStore.js";
import { PgEventStore } from "../eventStore.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { VcsProvider } from "../contracts/vcsProvider.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import { evaluateCiObservation, type CiObservation } from "../workflow/ciPolling.js";
import { loadReviewMergeRunContext, type ReviewMergeRunContext } from "../workflow/reviewMerge/context.js";

/** The label every auto-filed post-merge-failure tracking issue carries. */
export const POST_MERGE_FAILURE_LABEL = "tanren:post-merge-failure";

export interface PostMergeWatcherDeps {
  /** The runtime (`tanren_app`) pool. The watcher re-reads under the system scope. */
  pool: pg.Pool;
  secrets: SecretStore;
  vcsProvider: VcsProvider;
  /** Shared App installation-token minter (cache lives here), when an App is installed. */
  githubAppMinter?: GithubAppTokenMinter;
  /** Injectable for tests; defaults to a `PgEventStore` over `pool`. */
  eventStore?: EventStore;
}

/** The authoritative merge signal for a run: its `merge.completed` event. */
interface MergeRecord {
  prNumber: number;
  mergeSha?: string;
}

/**
 * The post-merge watcher. `check(runId)` is the per-run pass the subscriber drives
 * on each bus wake. It is a no-op unless the run merged; it opens at most one issue
 * per merge.
 */
export class PostMergeWatcher {
  private readonly eventStore: EventStore;

  constructor(private readonly deps: PostMergeWatcherDeps) {
    this.eventStore = deps.eventStore ?? new PgEventStore(deps.pool);
  }

  /**
   * Evaluate one run's post-merge state. Returns without effect when the run has
   * not merged, when an issue was already filed for this merge, or when the
   * post-merge CI is pending/passing. Files exactly one issue on a genuine failure.
   */
  async check(runId: string): Promise<void> {
    if (runId === "") return;
    // Not merged yet — nothing to watch.
    const merge = await this.loadMergeRecord(runId);
    if (merge === undefined) return;
    // Idempotency: open at most one issue per merge.
    if (await this.alreadyFiled(runId)) return;

    const context = await this.loadContext(runId);
    if (context === undefined) return;

    const resolved = await this.resolveToken(context);
    // Derive the repo from the PR ref (robust for a `.../pull/N` URL).
    const repo = this.deps.vcsProvider.parsePullRequest(context.prUrl).repo;
    const checks = await this.deps.vcsProvider.readBranchChecks({
      repo,
      branch: context.baseBranch,
      token: resolved,
    });
    const observation = evaluateCiObservation(checks);
    // ONLY a genuine FAILURE files an issue. Pending → leave for the next wake;
    // passed → nothing to track. Never an issue on a non-failure.
    if (observation.status !== "failed") return;

    await this.fileTrackingIssue({ runId, context, repo, token: resolved, merge, observation });
  }

  /** Read the run's `merge.completed` event (the authoritative merge signal), system-scoped. */
  private async loadMergeRecord(runId: string): Promise<MergeRecord | undefined> {
    return runWithSystemScope(this.deps.pool, async (client) => {
      const result = await client.query<{ payload: unknown }>(
        `SELECT payload FROM events
           WHERE run_id = $1 AND event_type = 'merge.completed'
           ORDER BY ts DESC, id DESC
           LIMIT 1`,
        [runId],
      );
      const payload = result.rows[0]?.payload;
      if (payload === null || typeof payload !== "object") return;
      const record = payload as { prNumber?: unknown; mergeSha?: unknown };
      if (typeof record.prNumber !== "number") return;
      return {
        prNumber: record.prNumber,
        ...(typeof record.mergeSha === "string" && { mergeSha: record.mergeSha }),
      };
    });
  }

  /** Idempotency guard: has an `issue.opened` already been recorded for this run? */
  private async alreadyFiled(runId: string): Promise<boolean> {
    return runWithSystemScope(this.deps.pool, async (client) => {
      const result = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM events WHERE run_id = $1 AND event_type = 'issue.opened'
         ) AS exists`,
        [runId],
      );
      return result.rows[0]?.exists ?? false;
    });
  }

  /** Load the review/merge run context (prUrl, baseBranch=default_branch, credentials), system-scoped. */
  private async loadContext(runId: string): Promise<ReviewMergeRunContext | undefined> {
    return runWithSystemScope(this.deps.pool, async (client) => loadReviewMergeRunContext(client, runId));
  }

  private async resolveToken(context: ReviewMergeRunContext) {
    return this.deps.vcsProvider.resolveToken({
      secrets: this.deps.secrets,
      ...(context.installation !== undefined && { installation: context.installation }),
      ...(context.staticCredentialRef !== undefined && { staticRef: context.staticCredentialRef }),
      ...(this.deps.githubAppMinter !== undefined && { minter: this.deps.githubAppMinter }),
    });
  }

  /** Open the single tracking issue + record the two events (the idempotency marker). */
  private async fileTrackingIssue(args: {
    runId: string;
    context: ReviewMergeRunContext;
    repo: ReturnType<VcsProvider["parseRepository"]>;
    token: Awaited<ReturnType<VcsProvider["resolveToken"]>>;
    merge: MergeRecord;
    observation: CiObservation;
  }): Promise<void> {
    const { runId, context, repo, token, merge, observation } = args;
    const failingChecks = observation.failingChecks.map((c) => ({
      kind: c.kind,
      name: c.name,
      state: c.state,
      ...(c.url !== undefined && { url: c.url }),
    }));
    const title = `Post-merge CI failed on ${context.baseBranch} after merging ${context.specId} (PR #${merge.prNumber})`;
    const body = renderIssueBody({ context, merge, failingChecks, runId });
    const issue = await this.deps.vcsProvider.createIssue({
      repo,
      token,
      title,
      body,
      labels: [POST_MERGE_FAILURE_LABEL],
    });

    const base = {
      runId,
      specId: context.specId,
      projectId: context.projectId,
    };
    await this.eventStore.append({
      ...base,
      eventType: "merge.post_merge_failed",
      payload: {
        prUrl: context.prUrl,
        prNumber: merge.prNumber,
        specId: context.specId,
        baseBranch: context.baseBranch,
        ...(merge.mergeSha !== undefined && { mergeSha: merge.mergeSha }),
        failingChecks,
      },
    });
    await this.eventStore.append({
      ...base,
      eventType: "issue.opened",
      payload: {
        reason: "post_merge_failure",
        issueNumber: issue.number,
        issueUrl: issue.url,
        prUrl: context.prUrl,
        label: POST_MERGE_FAILURE_LABEL,
      },
    });
  }
}

/** Render the tracking-issue body: the failing checks + links to the merged PR + the run. */
function renderIssueBody(args: {
  context: ReviewMergeRunContext;
  merge: MergeRecord;
  failingChecks: ReadonlyArray<{ kind: string; name: string; state: string; url?: string }>;
  runId: string;
}): string {
  const { context, merge, failingChecks, runId } = args;
  const lines = [
    `The post-merge CI on \`${context.baseBranch}\` failed after merging spec \`${context.specId}\`.`,
    "",
    `- Merged PR: ${context.prUrl} (#${merge.prNumber})`,
    `- Run: \`${runId}\``,
    `- Spec: \`${context.specId}\``,
    ...(merge.mergeSha === undefined ? [] : [`- Merge commit: \`${merge.mergeSha}\``]),
    "",
    "Failing post-merge checks:",
    ...failingChecks.map((c) => `- ${c.name} (${c.state})${c.url === undefined ? "" : ` — ${c.url}`}`),
    "",
    "_Auto-filed by Tanren post-merge watcher._",
  ];
  return lines.join("\n");
}
