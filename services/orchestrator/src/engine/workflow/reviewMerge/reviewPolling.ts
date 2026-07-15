// the review-polling stage. Runs AFTER CI passes (additive to the
// planner-run tail). It marks the draft PR ready-for-review, emits
// review.requested, then polls the PR's review verdict. On approval it returns
// `approved` so the caller proceeds to the merge stage; on changes_requested it
// emits review.changes_requested (carrying the reviewer feedback as steering
// for the writer-rework re-entry) and returns `changes_requested`.
//
// All GitHub calls go through the resolver/client (App-or-static,
// 401-retry). The poll function is injectable so tests never hit real GitHub.
//
// gv-2: reviewPolicy "simulated" is STRICT — real APPROVE/REQUEST_CHANGES on the
// exact head with a distinct reviewer identity; forge receipt is bound onto the
// terminal review.* event. Publication failure/skip/COMMENT/head-mismatch fails
// closed (no review.approved, no land authorization).

import type { ReviewAnswer } from "../../answerers/schemas/index.js";
import type { RunStateWriter } from "../../contracts/runStateWriter.js";
import type { SecretStore } from "../../contracts/secretStore.js";
import { ensureSystemTask, routeTaskUpdate } from "../taskWriteRouting.js";
import { type EventStore, PgEventStore } from "../../eventStore.js";
import type { AnswererAdapter } from "../../providers/types.js";
import type { GithubAppTokenMinter } from "../../providers/githubAppTokenMinter.js";
import type { GitHubHttpClient } from "../../providers/github.js";
import { parsePullRequestRef } from "../../providers/githubRepoRef.js";
import {
  type ReviewVerdict,
  type SubmitReviewEvent,
  type SubmittedReviewReceipt,
} from "../../providers/githubReviewMerge.js";
import {
  contextOptionsFor,
  loadReviewMergeRunContext,
  type ReviewMergeRunContext,
  type RunStateClient,
} from "./context.js";
import { finalizePauseForReviewAtomic } from "./reviewPauseSeam.js";
import { buildGitHubReviewProbe, type ReviewProbe } from "./reviewProbeGithub.js";
import { markReviewTaskDoneWithEvent } from "./reviewTaskTerminal.js";
import {
  reviewBodyFor,
  reviewEventFor,
  runSimulatedReviewer,
  type SimulatedReviewContext,
} from "./simulatedReviewer.js";
import {
  assertStrictForgeReceipt,
  SimulatedReviewPublicationError,
  type ForgeReviewPublication,
} from "./simulatedReviewPublication.js";

export type { ReviewProbe };

export interface PollReviewForRunInput {
  pool: RunStateClient;
  eventStore?: EventStore;
  /**
   * REQUIRED (audit D-R3.2 sweep): the review task INSERT/UPDATE routes through the
   * writer — the de-privileged data plane cannot write `tasks` directly. PR #714 made
   * the writer-undefined fallback unreachable in production.
   */
  runStateWriter: RunStateWriter;
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
  /**
   * Optional explicit static reviewer credential ref for strict simulated review
   * (`credential/github/*`). When omitted, the dual App-writer + static-reviewer
   * seam is required (see resolveDistinctSimulatedReviewerToken).
   */
  reviewerGithubCredentialRef?: string;
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
   * produces the typed internal verdict; the stage posts real APPROVE /
   * REQUEST_CHANGES (distinct reviewer identity) and only terminalizes on a
   * durable exact-head forge receipt.
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
 * The result verdict of a poll: the three GitHub-derived ReviewVerdict values
 * PLUS the Codex H3 #11 `parked` sentinel — emitted when a `human`-policy run
 * has NO terminal verdict yet and has been parked (run → `paused`, outcome
 * `awaiting_review`, `run.paused` on the timeline). The caller
 * (`plannerRun.ts`) treats `parked` as a NON-fault exit: return the worker to
 * the pool, no merge, no finalize; the awaiting-review prober owns the resume.
 */
export type PollReviewForRunVerdict = ReviewVerdict | "parked";

export interface PollReviewForRunResult {
  runId: string;
  taskId: string;
  verdict: PollReviewForRunVerdict;
  prUrl: string;
  prNumber: number;
  /** Reviewer login that produced the verdict, when known. */
  reviewer?: string;
  /** changes_requested feedback body, used as writer-rework steering. */
  feedback?: string;
  /** Strict simulated-review forge receipt, when published. */
  forgePublication?: ForgeReviewPublication;
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
    orgId: context.orgId,
    taskId,
    eventType: "task.started",
    payload: { taskKind: "review" },
  });

  const probe =
    input.reviewProbe ??
    (await buildGitHubReviewProbe({
      secrets: input.secrets,
      githubHttp: input.githubHttp,
      githubAppMinter: input.githubAppMinter,
      reviewerGithubCredentialRef: input.reviewerGithubCredentialRef,
      context,
      repo: pr.repo,
      pullNumber: pr.pullNumber,
    }));

  // Flip draft → ready and announce the review request once.
  await probe.markReady();
  await eventStore.append({
    runId: context.runId,
    specId: context.specId,
    projectId: context.projectId,
    orgId: context.orgId,
    taskId,
    eventType: "github.pr.ready",
    payload: { prUrl: context.prUrl, prNumber: pr.pullNumber },
  });
  await eventStore.append({
    runId: context.runId,
    specId: context.specId,
    projectId: context.projectId,
    orgId: context.orgId,
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
      orgId: context.orgId,
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

  // Simulated tier: Answerer verdict + STRICT exact-head forge APPROVE /
  // REQUEST_CHANGES publication (distinct reviewer). Fail closed on any
  // publication hole — never authorize land from the internal verdict alone.
  if (context.reviewPolicy === "simulated") {
    const result = await runSimulatedReview(input, context, probe, taskId, pr.pullNumber);
    await finalizeReviewTask(input.pool, eventStore, context, result, input.runStateWriter);
    return result;
  }

  // Human/external review tier: DURABLE PARK (Codex H3 Surface 4 finding #11).
  // The prior in-process polling loop pinned the worker thread indefinitely — a
  // restart discarded the state and pinned a fresh worker on the same run. The
  // fix flips the human tier to the SAME shape task #82 uses for window-pause:
  //
  //   1. FETCH the verdict ONCE. A resumed run (the awaiting-review prober
  //      already flipped the paused run to `halted`, the walker's successor is
  //      re-driving) will observe the now-terminal verdict here and proceed.
  //   2. On a `pending` verdict, PARK: flip run to `paused` (outcome
  //      `awaiting_review`, distinct WHY on the recovery surface), emit
  //      `run.paused` with `reason: "awaiting_human_review"` (the notification
  //      dispatcher's operator wake), and return the `parked` sentinel.
  //   3. The caller (`plannerRun.ts`) treats `parked` as a NON-fault exit:
  //      return the worker to the pool, no merge, no finalize.
  //   4. The awaiting-review prober re-checks GitHub on cadence; a terminal
  //      verdict resumes the run atomically (paused → halted + spec `open`),
  //      and the walker enqueues a successor that reads the terminal verdict.
  //
  // The awaited event stays `review.requested` (already emitted above); the
  // notification path is unchanged. The `parked` outcome is what makes this
  // DURABLE — a restart between park and approval preserves the state (the
  // prober picks it up on the fresh boot).
  const initialVerdict = await probe.fetchVerdict();
  if (initialVerdict.verdict === "pending") {
    // Park the run — durable, worker released.
    const pauseEvent = {
      runId: context.runId,
      specId: context.specId,
      projectId: context.projectId,
      orgId: context.orgId,
      taskId,
      eventType: "run.paused" as const,
      payload: {
        provider: "human_reviewer",
        slot: "primary",
        usedPercent: 0,
        // The recovery surface reads WHY (window pressure vs operator approval);
        // the field is a string on the schema so a new kind rides through
        // without a schema change.
        reason: "awaiting_human_review",
        // No prober `resetsAt` — the review verdict is externally driven
        // (operator action / dashboard), not a time-bound refresh. The prober
        // probes on cadence; the ISO is nominal.
        resetsAt: new Date().toISOString(),
      },
    };
    await finalizePauseForReviewAtomic(
      {
        pool: input.pool,
        runId: context.runId,
        orgId: context.orgId,
        // Test-inject seam: route the event append through the run's
        // eventStore so a `FakeEventStore` (unit tests) sees the emitted
        // `run.paused`; production paths pass a real `PgEventStore` which
        // shares the row UPDATE's transaction via the client wrapper.
        eventStore,
        // Legacy-arm fallback event append via the run's event store — the
        // real-pool arm never uses it, but the seam signature requires it for
        // the unit-test no-orgId code path.
        appendEvent: async (eventType, payload, appendTaskId) =>
          eventStore.append({
            runId: context.runId,
            specId: context.specId,
            projectId: context.projectId,
            orgId: context.orgId,
            ...(appendTaskId !== undefined && { taskId: appendTaskId }),
            eventType,
            payload,
          }),
      },
      pauseEvent,
    );
    // The run is now durable-parked. Return a `parked` sentinel so the caller
    // exits without finalizing the review task (the successor run's poll owns
    // the terminal finalize) and without publishing a `run.completed` / halt.
    return {
      runId: context.runId,
      taskId,
      verdict: "parked",
      prUrl: context.prUrl,
      prNumber: pr.pullNumber,
    };
  }

  const result: PollReviewForRunResult = {
    runId: context.runId,
    taskId,
    verdict: initialVerdict.verdict,
    prUrl: context.prUrl,
    prNumber: pr.pullNumber,
    reviewer: initialVerdict.latest?.reviewer,
    feedback: initialVerdict.latest?.body,
  };
  await finalizeReviewTask(input.pool, eventStore, context, result, input.runStateWriter);
  return result;
}

/**
 * Drive the simulated-reviewer verdict: fetch the PR diff + exact head, run the
 * reviewer Answerer, post STRICT APPROVE/REQUEST_CHANGES with a distinct
 * reviewer identity on that head, validate the forge receipt, and only then
 * return a terminal result. Any publication hole throws (fail closed) — the
 * caller never finalizes review.approved from the internal verdict alone.
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
  if (probe.fetchDiff === undefined || probe.fetchHeadSha === undefined || probe.submitReview === undefined) {
    throw new SimulatedReviewPublicationError(
      "reviewPolicy 'simulated' requires a review probe that can fetch the PR diff, exact head sha, and submit a strict review",
    );
  }
  const reviewer = resolveReviewer();
  const [prDiff, headSha] = await Promise.all([probe.fetchDiff(), probe.fetchHeadSha()]);
  if (headSha === "" || !/^[0-9a-f]{40}$/iu.test(headSha)) {
    throw new SimulatedReviewPublicationError(
      `simulated review requires an exact 40-hex head sha (got ${headSha === "" ? "empty" : headSha})`,
    );
  }
  const reviewContext: SimulatedReviewContext = {
    specTitle: spec.specTitle,
    specDescription: spec.specDescription,
    acceptanceCriteria: spec.acceptanceCriteria,
    prDiff,
  };
  const { verdict } = await runSimulatedReviewer(reviewer, {
    context: reviewContext,
  });
  const event = reviewEventFor(verdict);
  if (event === ("COMMENT" as SubmitReviewEvent)) {
    // Defensive: reviewEventFor never returns COMMENT; reject if a shim reappears.
    throw new SimulatedReviewPublicationError(
      "simulated review refuses COMMENT cosplay — only APPROVE/REQUEST_CHANGES are land-authoritative",
    );
  }
  let receipt: SubmittedReviewReceipt;
  try {
    receipt = await probe.submitReview(event, reviewBodyFor(verdict), headSha);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SimulatedReviewPublicationError(`simulated review forge publication failed: ${message}`);
  }
  const expectedVerdict = verdict.verdict === "approve" ? "approved" : "changes_requested";
  const forgePublication = assertStrictForgeReceipt({
    receipt,
    expectedVerdict,
    expectedHeadSha: headSha,
  });
  return {
    runId: context.runId,
    taskId,
    verdict: expectedVerdict,
    prUrl: context.prUrl,
    prNumber: pullNumber,
    reviewer: forgePublication.reviewerLogin ?? "tanren-simulated-reviewer",
    feedback: verdict.reasoning,
    forgePublication,
  };
}

async function finalizeReviewTask(
  pool: RunStateClient,
  _eventStore: EventStore,
  context: ReviewMergeRunContext,
  result: PollReviewForRunResult,
  writer: RunStateWriter,
): Promise<void> {
  const base = {
    runId: context.runId,
    specId: context.specId,
    projectId: context.projectId,
    // org_id is the run's explicit tenant key (v68 fix) the eventStore.append stamps directly.
    orgId: context.orgId,
    taskId: result.taskId,
  };
  if (result.verdict === "approved" || result.verdict === "changes_requested") {
    // AUDIT FINDING #6 + D-R3.2 — the review-kind task terminal routes through the
    // doctrine helper `markReviewTaskDoneWithEvent`: all three writes (row UPDATE +
    // `review.*` + `task.completed`) flow through the REQUIRED writer seam, and the
    // row + `task.completed` pair lands atomically via `updateTaskWithEvent`. The
    // writer-undefined split-write fallback was unreachable in production after
    // PR #714 and is now gone.
    //
    // gv-2: for simulated review, forgePublication is REQUIRED on the terminal
    // path (runSimulatedReview always supplies it). Human/auto may omit it.
    if (context.reviewPolicy === "simulated" && result.forgePublication === undefined) {
      throw new SimulatedReviewPublicationError(
        "simulated review refuses terminal review.* without a durable forge publication receipt",
      );
    }
    await markReviewTaskDoneWithEvent({
      writer,
      base,
      verdict: result.verdict,
      prUrl: result.prUrl,
      prNumber: result.prNumber,
      ...(result.reviewer !== undefined && { reviewer: result.reviewer }),
      ...(result.feedback !== undefined && { feedback: result.feedback }),
      ...(result.forgePublication !== undefined && { forgePublication: result.forgePublication }),
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

async function ensureReviewTask(
  pool: RunStateClient,
  context: ReviewMergeRunContext,
  writer: RunStateWriter,
): Promise<string> {
  return ensureSystemTask(pool, { runId: context.runId, kind: "review", title: "Poll pull request review" }, writer);
}
