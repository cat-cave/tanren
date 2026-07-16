// gv-2 simulated-review stage body: durable intent fence + fenced forge publish.
// Extracted from reviewPolling.ts to stay under the 500-line architecture cap.

import type { ReviewAnswer } from "../../answerers/schemas/index.js";
import type { AnswererAdapter } from "../../providers/types.js";
import type { SubmittedReviewReceipt } from "../../providers/githubReviewMerge.js";
import type { ReviewMergeRunContext } from "./context.js";
import type { ReviewProbe } from "./reviewProbeGithub.js";
import {
  reviewBodyFor,
  reviewEventFor,
  runSimulatedReviewer,
  type SimulatedReviewContext,
} from "./simulatedReviewer.js";
import {
  assertStrictForgeReceipt,
  bodyContainsSimulatedReviewIntentMarker,
  simulatedReviewIntentFingerprint,
  simulatedReviewIntentMarker,
  SimulatedReviewHeadStaleError,
  SimulatedReviewPublicationError,
  tanrenSimulatedReviewMarker,
  type ForgeReviewPublication,
} from "./simulatedReviewPublication.js";
import { type SimulatedReviewIntent, type SimulatedReviewIntentRepository } from "./simulatedReviewIntent.js";
import {
  type SimulatedReviewPublishFence,
  type SimulatedReviewPublishFenceKey,
} from "./simulatedReviewPublishFence.js";

export interface SimulatedReviewSpec {
  specTitle: string;
  specDescription: string;
  acceptanceCriteria: ReadonlyArray<string>;
}

export interface RunSimulatedReviewStageInput {
  context: ReviewMergeRunContext;
  probe: ReviewProbe;
  taskId: string;
  pullNumber: number;
  resolveReviewer: () => AnswererAdapter<ReviewAnswer>;
  spec: SimulatedReviewSpec;
  intentRepository: SimulatedReviewIntentRepository;
  publishFence: SimulatedReviewPublishFence;
  /**
   * Repo coordinates for the publish fence key. Production supplies the PR
   * owner/name; tests may use fixtures.
   */
  repo: { owner: string; name: string };
  /**
   * Optional override when the probe already knows the reviewer login (tests).
   * Production resolves via probe.resolveReviewerLogin when present.
   */
  reviewerLoginOverride?: string;
}

export interface SimulatedReviewStageResult {
  runId: string;
  taskId: string;
  verdict: "approved" | "changes_requested";
  prUrl: string;
  prNumber: number;
  reviewer: string;
  feedback: string;
  forgePublication: ForgeReviewPublication;
  /** Durable intent that drove publication (for tests / audit). */
  intent: SimulatedReviewIntent;
}

/**
 * Drive simulated review with the durable intent fence:
 *   1. Acquire one coherent base/head/author snapshot + immutable diff.
 *   2. Lookup head-keyed intent — if present, skip Answerer and reuse it.
 *   3. Else run Answerer, first-wins append intent, read back winner.
 *   4. Under cross-process publish fence: list→reconcile→optional POST.
 *   5. Bind forge receipt; never terminalize without it.
 */
export async function runSimulatedReviewStage(
  input: RunSimulatedReviewStageInput,
): Promise<SimulatedReviewStageResult> {
  const { context, probe, taskId, pullNumber } = input;
  if (probe.fetchSnapshot === undefined || probe.fetchLiveHeadSha === undefined || probe.submitReview === undefined) {
    throw new SimulatedReviewPublicationError(
      "reviewPolicy 'simulated' requires a coherent PR snapshot, live-head revalidation, and strict review publication",
    );
  }
  const snapshot = await probe.fetchSnapshot();
  const { headSha } = snapshot;
  if (headSha === "" || !/^[0-9a-f]{40}$/iu.test(headSha)) {
    throw new SimulatedReviewPublicationError(
      `simulated review requires an exact 40-hex head sha (got ${headSha === "" ? "empty" : headSha})`,
    );
  }

  const intent = await resolveDurableIntent({
    context,
    taskId,
    headSha,
    prDiff: snapshot.diff,
    authorLogin: snapshot.authorLogin,
    resolveReviewer: input.resolveReviewer,
    spec: input.spec,
    intentRepository: input.intentRepository,
    probe,
    reviewerLoginOverride: input.reviewerLoginOverride,
  });

  const fenceKey: SimulatedReviewPublishFenceKey = {
    owner: input.repo.owner,
    repo: input.repo.name,
    pullNumber,
    headSha: intent.headSha,
    reviewerLogin: intent.reviewerLogin,
  };

  let receipt: SubmittedReviewReceipt;
  try {
    receipt = await input.publishFence.withExclusivePublish(fenceKey, async () => {
      const liveHeadSha = await probe.fetchLiveHeadSha!();
      if (liveHeadSha.toLowerCase() !== intent.headSha.toLowerCase()) {
        throw new SimulatedReviewHeadStaleError(intent.headSha, liveHeadSha);
      }
      // Always publish the durable winner — never a losing concurrent Answerer.
      return probe.submitReview!(intent.event, intent.body, intent.headSha);
    });
  } catch (err) {
    if (err instanceof SimulatedReviewPublicationError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new SimulatedReviewPublicationError(`simulated review forge publication failed: ${message}`);
  }

  const forgePublication = assertStrictForgeReceipt({
    receipt,
    expectedVerdict: intent.state,
    expectedHeadSha: intent.headSha,
  });
  if (forgePublication.reviewerLogin.toLowerCase() !== intent.reviewerLogin.toLowerCase()) {
    throw new SimulatedReviewPublicationError(
      `simulated review publication reviewer mismatch: forge=${forgePublication.reviewerLogin} intent=${intent.reviewerLogin}`,
    );
  }

  return {
    runId: context.runId,
    taskId,
    verdict: intent.state,
    prUrl: context.prUrl,
    prNumber: pullNumber,
    reviewer: forgePublication.reviewerLogin,
    feedback: intent.message,
    forgePublication,
    intent,
  };
}

async function resolveDurableIntent(input: {
  context: ReviewMergeRunContext;
  taskId: string;
  headSha: string;
  prDiff: string;
  authorLogin: string;
  resolveReviewer: () => AnswererAdapter<ReviewAnswer>;
  spec: SimulatedReviewSpec;
  intentRepository: SimulatedReviewIntentRepository;
  probe: ReviewProbe;
  reviewerLoginOverride?: string;
}): Promise<SimulatedReviewIntent> {
  const existing = await input.intentRepository.lookup(input.context.orgId, input.context.runId, input.headSha);
  if (existing !== undefined) {
    assertIntentMatchesSnapshot(input, existing);
    return existing;
  }

  const reviewerLogin = await resolveReviewerLoginForIntent(input.probe, input.reviewerLoginOverride);
  assertReviewerIsNotAuthor(reviewerLogin, input.authorLogin);
  const { verdict } = await runSimulatedReviewer(input.resolveReviewer(), {
    context: {
      specTitle: input.spec.specTitle,
      specDescription: input.spec.specDescription,
      acceptanceCriteria: input.spec.acceptanceCriteria,
      prDiff: input.prDiff,
    } satisfies SimulatedReviewContext,
  });
  const state = verdict.verdict === "approve" ? "approved" : "changes_requested";
  const event = reviewEventFor(verdict);
  if (event !== "APPROVE" && event !== "REQUEST_CHANGES") {
    throw new SimulatedReviewPublicationError(
      "simulated review refuses COMMENT cosplay — only APPROVE/REQUEST_CHANGES are land-authoritative",
    );
  }
  const message = verdict.reasoning;
  const intentMarker = simulatedReviewIntentMarker(
    simulatedReviewIntentFingerprint({
      runId: input.context.runId,
      taskId: input.taskId,
      headSha: input.headSha,
      state,
      reviewerLogin,
      message,
    }),
  );
  const candidate: SimulatedReviewIntent = {
    headSha: input.headSha,
    state,
    event,
    body: `${reviewBodyFor(verdict)}\n\n${intentMarker}`,
    message,
    reviewerLogin,
    marker: tanrenSimulatedReviewMarker(state),
  };
  // Concurrent actors may append different candidates; both adopt the winner.
  const winner = await input.intentRepository.adoptOrRecord({
    runId: input.context.runId,
    orgId: input.context.orgId,
    projectId: input.context.projectId,
    specId: input.context.specId,
    taskId: input.taskId,
    candidate,
  });
  assertIntentMatchesSnapshot(input, winner);
  return winner;
}

function assertIntentMatchesSnapshot(
  input: { context: ReviewMergeRunContext; taskId: string; headSha: string; authorLogin: string },
  intent: SimulatedReviewIntent,
): void {
  if (intent.headSha.toLowerCase() !== input.headSha.toLowerCase()) {
    throw new SimulatedReviewPublicationError(
      `simulated review intent head mismatch: stored=${intent.headSha} expected=${input.headSha}`,
    );
  }
  assertReviewerIsNotAuthor(intent.reviewerLogin, input.authorLogin);
  const expectedIntentMarker = markerForIntent(input.context.runId, input.taskId, intent);
  if (!bodyContainsSimulatedReviewIntentMarker(intent.body, expectedIntentMarker)) {
    throw new SimulatedReviewPublicationError(
      "stored simulated review intent is not bound to this run/task fingerprint",
    );
  }
}

function markerForIntent(runId: string, taskId: string, intent: SimulatedReviewIntent): string {
  return simulatedReviewIntentMarker(
    simulatedReviewIntentFingerprint({
      runId,
      taskId,
      headSha: intent.headSha,
      state: intent.state,
      reviewerLogin: intent.reviewerLogin,
      message: intent.message,
    }),
  );
}

function assertReviewerIsNotAuthor(reviewerLogin: string, authorLogin: string): void {
  const reviewer = reviewerLogin.trim().toLowerCase();
  const author = authorLogin.trim().toLowerCase();
  if (reviewer === "" || author === "") {
    throw new SimulatedReviewPublicationError("simulated review requires provider-observed author and reviewer logins");
  }
  if (reviewer === author) {
    throw new SimulatedReviewPublicationError(
      `strict simulated review rejected PR-author self-review by '${reviewerLogin.trim()}'`,
    );
  }
}

async function resolveReviewerLoginForIntent(probe: ReviewProbe, override: string | undefined): Promise<string> {
  if (typeof override === "string" && override.trim() !== "") {
    return override.trim();
  }
  if (probe.resolveReviewerLogin !== undefined) {
    const login = await probe.resolveReviewerLogin();
    if (login.trim() === "") {
      throw new SimulatedReviewPublicationError(
        "simulated review intent requires a non-empty reviewer login from the probe",
      );
    }
    return login.trim();
  }
  throw new SimulatedReviewPublicationError(
    "simulated review intent requires reviewer login (probe.resolveReviewerLogin or override)",
  );
}
