// the review-polling stage. Runs AFTER CI passes (additive to the
// planner-run tail). It marks the draft PR ready-for-review, emits
// review.requested, then polls the PR's review verdict. On approval it returns
// `approved` so the caller proceeds to the merge stage; on changes_requested it
// emits review.changes_requested (carrying the reviewer feedback as steering
// for the writer-rework re-entry) and returns `changes_requested`.
//
// All GitHub calls go through the resolver/client (App-or-static,
// 401-retry). The poll function is injectable so tests never hit real GitHub.

import type { ReviewAnswer } from "../../answerers/schemas/index.js";
import type { RunStateWriter } from "../../contracts/runStateWriter.js";
import type { SecretStore } from "../../contracts/secretStore.js";
import { ensureSystemTask, routeTaskUpdate } from "../taskWriteRouting.js";
import { type EventStore, PgEventStore } from "../../eventStore.js";
import type { AnswererAdapter } from "../../providers/types.js";
import type { GithubAppTokenMinter } from "../../providers/githubAppTokenMinter.js";
import type { PullRequestRef, RepoRef } from "../../contracts/codeHostTypes.js";
import type { GitHubHttpClient } from "../../providers/github.js";
import { parsePullRequestRef } from "../../providers/githubRepoRef.js";
import { resolveVcsToken } from "../../credentials/vcsCredentials.js";
import { projectHostSeamsOver, readChangeRequestShas } from "../../providers/projectHostSeamsOver.js";
import {
  type ReviewVerdict,
  type ReviewVerdictResult,
  type SubmitReviewEvent,
} from "../../providers/githubReviewMerge.js";
import {
  contextOptionsFor,
  loadReviewMergeRunContext,
  type ReviewMergeRunContext,
  type RunStateClient,
} from "./context.js";
import { markReviewTaskDoneWithEvent } from "./reviewTaskTerminal.js";
import {
  reviewBodyFor,
  reviewEventFor,
  runSimulatedReviewer,
  type SimulatedReviewContext,
} from "./simulatedReviewer.js";

export interface PollReviewForRunInput {
  pool: RunStateClient;
  eventStore?: EventStore;
  // route the review task INSERT/UPDATE through the control plane
  // when wired (remote-writes on); absent, the in-process org-scoped write runs.
  runStateWriter?: RunStateWriter;
  secrets: SecretStore;
  /** The shared (timed) GitHub HTTP client the review stage's host seams build over. */
  githubHttp: GitHubHttpClient;
  runId: string;
  githubAppMinter?: GithubAppTokenMinter;
  /**
   * The GitHub credential ref the run already resolved for the PR-creation +
   * CI-poll steps. Threaded through so the review stage resolves its token from
   * the same source (project RECORD `githubCredentialRef` → org default) rather
   * than the project-config JSONB alone.
   */
  resolvedGithubCredentialRef?: string;
  pollDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Test seam. When provided, the stage uses this instead of GitHub for both
   * the ready-flip and the verdict reads. Production omits it → the real
   * GitHubReviewMergeService drives both through the resolved token.
   */
  reviewProbe?: ReviewProbe;
  /**
   * reviewPolicy: "simulated" — a factory for the orchestrator-managed reviewer
   * Answerer + the spec context it judges. Required when the project's
   * reviewPolicy is "simulated"; on every other policy it is NEVER invoked (so a
   * `human`/`auto` run never needs to resolve a reviewer adapter). The Answerer
   * reads the PR diff (fetched via the probe) + these criteria and the stage
   * posts its verdict as a REAL GitHub COMMENT review (self-PR-safe) before
   * driving the approve/request_changes decision internally off that verdict.
   */
  simulatedReviewer?: () => AnswererAdapter<ReviewAnswer>;
  simulatedReviewContext?: SimulatedReviewSpec;
}

/** Spec inputs the simulated reviewer judges the PR diff against. */
export interface SimulatedReviewSpec {
  specTitle: string;
  specDescription: string;
  acceptanceCriteria: ReadonlyArray<string>;
}

/**
 * Injectable review-state probe (real GitHub by default; mocked in tests). The
 * `fetchDiff`/`submitReview` members are used ONLY on the simulated path; the
 * real GitHub probe always provides them, while human/auto test probes may omit
 * them (the simulated branch asserts their presence before use).
 */
export interface ReviewProbe {
  markReady(): Promise<void>;
  fetchVerdict(): Promise<ReviewVerdictResult>;
  fetchDiff?(): Promise<string>;
  submitReview?(event: SubmitReviewEvent, body: string): Promise<void>;
}

export interface PollReviewForRunResult {
  runId: string;
  taskId: string;
  verdict: ReviewVerdict;
  prUrl: string;
  prNumber: number;
  /** Reviewer login that produced the verdict, when known. */
  reviewer?: string;
  /** changes_requested feedback body, used as writer-rework steering. */
  feedback?: string;
}

export async function pollReviewForRun(input: PollReviewForRunInput): Promise<PollReviewForRunResult> {
  const context = await loadReviewMergeRunContext(input.pool, input.runId, contextOptionsFor(input));
  const eventStore = input.eventStore ?? new PgEventStore(input.pool);
  const prRef = parsePullRequestRef(context.prUrl);
  const pr = { repo: prRef.repo, pullNumber: prRef.number };
  const taskId = await ensureReviewTask(input.pool, context, input.runStateWriter);
  await eventStore.append({
    runId: context.runId,
    specId: context.specId,
    projectId: context.projectId,
    taskId,
    eventType: "task.started",
    payload: { taskKind: "review" },
  });

  const probe = input.reviewProbe ?? (await buildGitHubProbe(input, context, pr.repo, pr.pullNumber));

  // Flip draft → ready and announce the review request once.
  await probe.markReady();
  await eventStore.append({
    runId: context.runId,
    specId: context.specId,
    projectId: context.projectId,
    taskId,
    eventType: "github.pr.ready",
    payload: { prUrl: context.prUrl, prNumber: pr.pullNumber },
  });
  await eventStore.append({
    runId: context.runId,
    specId: context.specId,
    projectId: context.projectId,
    taskId,
    eventType: "review.requested",
    payload: { prUrl: context.prUrl, prNumber: pr.pullNumber },
  });

  // No-review tier (project reviewPolicy === "auto"): short-circuit to an
  // approved verdict immediately — no GitHub poll. The PR was already flipped
  // ready above (direct_merge refuses a draft), so the caller proceeds straight
  // to mergeForRun. A distinct `review.auto_approved` event records that no
  // human verdict gated the merge; `finalizeReviewTask` then emits the standard
  // `review.approved` + `task.completed` so every downstream consumer (dashboard
  // phase, review-stall insight, notification severity) reacts unchanged.
  if (context.reviewPolicy === "auto") {
    await eventStore.append({
      runId: context.runId,
      specId: context.specId,
      projectId: context.projectId,
      taskId,
      eventType: "review.auto_approved",
      payload: { prUrl: context.prUrl, prNumber: pr.pullNumber },
    });
    const autoResult: PollReviewForRunResult = {
      runId: context.runId,
      taskId,
      verdict: "approved",
      prUrl: context.prUrl,
      prNumber: pr.pullNumber,
    };
    await finalizeReviewTask(input.pool, eventStore, context, autoResult, input.runStateWriter);
    return autoResult;
  }

  // Simulated tier (project reviewPolicy === "simulated"): the orchestrator runs
  // a reviewer Answerer over the PR diff + acceptance criteria, posts its verdict
  // as a REAL GitHub COMMENT review (self-PR-safe — the bot pushes AND reviews
  // with the same identity, which GitHub forbids for APPROVE/REQUEST_CHANGES),
  // then drives the approve/request_changes decision INTERNALLY off the Answerer
  // verdict through the SAME finalize path the human policy uses. The posted
  // COMMENT is a genuine, visible audit artifact — not a synthetic shortcut — so
  // the rest of the pipeline (approve→merge, changes_requested→rework) reacts
  // exactly as it does for a human reviewer.
  if (context.reviewPolicy === "simulated") {
    const result = await runSimulatedReview(input, context, probe, taskId, pr.pullNumber);
    await finalizeReviewTask(input.pool, eventStore, context, result, input.runStateWriter);
    return result;
  }

  // Human/external review tier: await the review verdict INDEFINITELY
  // (feedback_no_timeouts_progress_based, BINDING). A review legitimately takes a
  // long time — a human reviewer may sit on a PR for hours or days — so there is
  // NO poll cap and NO wall-clock deadline. The ONLY terminal is a REAL verdict
  // signal: `approved` → proceed to merge, `changes_requested` → rework. A
  // `pending` verdict (no review yet, or a transient host hiccup the probe folds
  // into `pending`) is NOT a give-up — the loop keeps polling on its cadence. The
  // poll `delayMs` is the SPACING between probes (a paced interval), never a budget.
  const delayMs = input.pollDelayMs ?? 10_000;
  const sleep =
    input.sleep ??
    ((ms) =>
      new Promise<void>((resolve) => {
        // arch-allow: timeout-class — poll SPACING between review-verdict probes (cadence, not a deadline).
        setTimeout(resolve, ms);
      }));

  let last: ReviewVerdictResult = { verdict: "pending" };
  for (;;) {
    last = await probe.fetchVerdict();
    if (last.verdict !== "pending") {
      break;
    }
    await sleep(delayMs);
  }

  const result: PollReviewForRunResult = {
    runId: context.runId,
    taskId,
    verdict: last.verdict,
    prUrl: context.prUrl,
    prNumber: pr.pullNumber,
    reviewer: last.latest?.reviewer,
    feedback: last.latest?.body,
  };
  await finalizeReviewTask(input.pool, eventStore, context, result, input.runStateWriter);
  return result;
}

/**
 * Drive the simulated-reviewer verdict: fetch the PR diff, run the reviewer
 * Answerer over it + the spec's acceptance criteria, post the verdict as a REAL
 * GitHub COMMENT review (self-PR-safe audit artifact), and return the normalized
 * verdict the standard finalize path consumes. The approve/request_changes
 * decision is derived INTERNALLY from the Answerer verdict here (the COMMENT
 * review is the audit trail, not the decision source), so finalizeReviewTask
 * routes approve→merge / request_changes→rework off a genuine, posted review.
 */
async function runSimulatedReview(
  input: PollReviewForRunInput,
  context: ReviewMergeRunContext,
  probe: ReviewProbe,
  taskId: string,
  pullNumber: number,
): Promise<PollReviewForRunResult> {
  const resolveReviewer = input.simulatedReviewer;
  const spec = input.simulatedReviewContext;
  if (resolveReviewer === undefined || spec === undefined) {
    throw new Error(
      "reviewPolicy 'simulated' requires both simulatedReviewer (the reviewer Answerer factory) and simulatedReviewContext",
    );
  }
  if (probe.fetchDiff === undefined || probe.submitReview === undefined) {
    throw new Error("reviewPolicy 'simulated' requires a review probe that can fetch the PR diff and submit a review");
  }
  const reviewer = resolveReviewer();
  const prDiff = await probe.fetchDiff();
  const reviewContext: SimulatedReviewContext = {
    specTitle: spec.specTitle,
    specDescription: spec.specDescription,
    acceptanceCriteria: spec.acceptanceCriteria,
    prDiff,
  };
  const { verdict } = await runSimulatedReviewer(reviewer, {
    context: reviewContext,
  });
  // Post the REAL GitHub review as a COMMENT (self-PR-safe: the bot pushes AND
  // reviews with the same identity, and GitHub forbids self-APPROVE/REQUEST_
  // CHANGES). The COMMENT body states the verdict + reasoning so it is a real,
  // honest audit artifact on the PR. The approve/request_changes decision is
  // driven INTERNALLY off the Answerer verdict below — not read back from a
  // review-state poll (a COMMENT carries no APPROVE/REQUEST_CHANGES state).
  await probe.submitReview(reviewEventFor(verdict), reviewBodyFor(verdict));
  return {
    runId: context.runId,
    taskId,
    verdict: verdict.verdict === "approve" ? "approved" : "changes_requested",
    prUrl: context.prUrl,
    prNumber: pullNumber,
    reviewer: "tanren-simulated-reviewer",
    feedback: verdict.reasoning,
  };
}

async function finalizeReviewTask(
  pool: RunStateClient,
  eventStore: EventStore,
  context: ReviewMergeRunContext,
  result: PollReviewForRunResult,
  writer?: RunStateWriter,
): Promise<void> {
  const base = {
    runId: context.runId,
    specId: context.specId,
    projectId: context.projectId,
    taskId: result.taskId,
  };
  if (result.verdict === "approved" || result.verdict === "changes_requested") {
    // AUDIT FINDING #6 — the review-kind task terminal now routes through the
    // doctrine helper `markReviewTaskDoneWithEvent` (the merge-kind sibling's
    // shape): all three writes (row UPDATE + `review.*` + `task.completed`)
    // flow through the writer seam, and the row + `task.completed` pair lands
    // atomically via `updateTaskWithEvent`. The prior shape was three
    // sequential pool/eventStore writes with no transaction — a crash between
    // them stranded the terminal row with a missing `task.completed` (the
    // §1c invariant the merge-kind fix closed). A `changes_requested` keeps
    // closing the task as done/ok (the verdict steers the writer-rework path,
    // which opens its own writer tasks). The WRITER-PRESENT path is the live
    // production path; the writer-undefined branch below is the TEST-ONLY
    // split-write seam (the helper itself is doctrine-pure, writer-required).
    if (writer !== undefined) {
      await markReviewTaskDoneWithEvent({
        writer,
        base,
        verdict: result.verdict,
        prUrl: result.prUrl,
        prNumber: result.prNumber,
        ...(result.reviewer !== undefined && { reviewer: result.reviewer }),
        ...(result.feedback !== undefined && { feedback: result.feedback }),
      });
      return;
    }
    await markTaskDoneOk(pool, result.taskId, writer);
    if (result.verdict === "approved") {
      await eventStore.append({
        ...base,
        eventType: "review.approved",
        payload: { prUrl: result.prUrl, prNumber: result.prNumber, reviewer: result.reviewer },
      });
    } else {
      await eventStore.append({
        ...base,
        eventType: "review.changes_requested",
        payload: {
          prUrl: result.prUrl,
          prNumber: result.prNumber,
          reviewer: result.reviewer,
          message: result.feedback,
        },
      });
    }
    await eventStore.append({
      ...base,
      eventType: "task.completed",
      payload: { taskKind: "review", status: result.verdict },
    });
    return;
  }
  // Defensive: the poll loop only returns a TERMINAL verdict (approved /
  // changes_requested) — it awaits `pending` indefinitely and never surfaces it.
  // Should a `pending` ever reach here, leave the task running rather than
  // silently closing it (the dashboard surface drives it from here).
  await routeTaskUpdate(
    writer,
    pool,
    { taskId: result.taskId, transition: "running_pending" },
    "UPDATE tasks SET status = 'running', outcome = 'pending', ended_at = NULL WHERE task_id = $1",
    [result.taskId],
  );
}

/** The `task done/ok` write, routed remote when wired (review approved + changes-requested). */
async function markTaskDoneOk(pool: RunStateClient, taskId: string, writer?: RunStateWriter): Promise<void> {
  await routeTaskUpdate(
    writer,
    pool,
    { taskId, transition: "done", outcome: "ok" },
    "UPDATE tasks SET status = 'done', outcome = 'ok', ended_at = now() WHERE task_id = $1",
    [taskId],
  );
}

async function buildGitHubProbe(
  input: PollReviewForRunInput,
  context: ReviewMergeRunContext,
  repo: RepoRef,
  pullNumber: number,
): Promise<ReviewProbe> {
  const resolved = await resolveVcsToken(input.githubHttp, {
    secrets: input.secrets,
    installation: context.installation,
    staticRef: context.staticCredentialRef,
    minter: input.githubAppMinter,
  });
  const pr: PullRequestRef = { repo, number: pullNumber };
  const repoFullName = `${repo.owner}/${repo.name}`;
  // Build the REAL host seams over the run's shared GitHub client (decomposition PR-5).
  // `codeHost` serves the sha-addressed diff read; `visibility` is the hardened
  // `SafeVisibilityProjection` — every forge-UI write/read yields a `ProjectionOutcome`
  // and can NEVER throw, so a failed mirror can never block the (internally-derived)
  // review verdict (§0, §6).
  const { codeHost, visibility } = projectHostSeamsOver(input.githubHttp, async () => resolved);
  return {
    // §5d: un-drafting the PR is a best-effort, NON-gating forge-UI nicety — route it
    // through the hardened projection (a host that never drafts simply yields `skipped`).
    markReady: async () => {
      await visibility.markChangeRequestReady({ repoFullName, changeRequestNumber: pullNumber });
    },
    // §5f (step-1): the host review verdict is the EXTERNAL approval read — now routed
    // through the best-effort `VisibilityProjection.readExternalApproval?` seam (the host
    // review is an "optional external approval"; Tanren's internal review record is the
    // authoritative gate, §6). A `projected` outcome yields the host verdict; a `skipped`
    // (no host review surface) / `failed` (transient forge error) resolves to `pending`,
    // so the poll keeps polling rather than treating the absence as a verdict. The
    // best-effort severance means a transient host hiccup can never brick the poll.
    fetchVerdict: async () => {
      const outcome = await visibility.readExternalApproval({ repoFullName, changeRequestNumber: pullNumber });
      return outcome.kind === "projected" ? outcome.value : { verdict: "pending" };
    },
    // §1 #16: the reviewer's diff moves onto the host-neutral, sha-addressed
    // `CodeHost.readDiff` (compares the PR's exact base/head shas — same render shape).
    fetchDiff: async () => {
      const { baseSha, headSha } = await readChangeRequestShas(input.githubHttp, pr, resolved);
      return codeHost.readDiff(repo, baseSha, headSha);
    },
    // The simulated-review COMMENT is a BEST-EFFORT audit mirror, not the decision source
    // (the approve/request_changes verdict is derived internally from the Answerer). The
    // hardened projection captures any publish failure as a `ProjectionOutcome` so the
    // probe's `submitReview` resolves regardless (§0, §6).
    submitReview: async (_event, body) => {
      await visibility.publishReview({ repoFullName, changeRequestNumber: pullNumber, body });
    },
  };
}

async function ensureReviewTask(
  pool: RunStateClient,
  context: ReviewMergeRunContext,
  writer?: RunStateWriter,
): Promise<string> {
  return ensureSystemTask(pool, { runId: context.runId, kind: "review", title: "Poll pull request review" }, writer);
}
