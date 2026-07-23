import { randomUUID } from "node:crypto";
import type { AuditAdapter } from "./auditAdapter.js";
import type { AuditArtifactStore } from "./artifactStore.js";
import type { AuditContext } from "./auditContext.js";
import { AuditFailure } from "./auditReport.js";
import type { CraConfig } from "./config.js";
import type { DiscoveredReview } from "./discovery.js";
import type { EventLog } from "./eventLog.js";
import type { OfficialReviewPoster } from "./officialReview.js";
import { bodyMatchesMarker } from "./reviewMarker.js";
import type { PrStateStore } from "./stateStore.js";
import type { PrState } from "./stateSchemas.js";
import { triage, type ReviewVerdict } from "./triage.js";
import type { VerifiedWorktree } from "./worktree.js";

export interface ReviewOnceDeps {
  readonly config: CraConfig;
  readonly actor: string;
  readonly adapter: AuditAdapter;
  readonly poster: OfficialReviewPoster;
  readonly stateStore: PrStateStore;
  readonly artifactStore: AuditArtifactStore;
  readonly events: EventLog;
}

export interface ReviewOnceInput {
  readonly state: PrState;
  readonly context: AuditContext;
  readonly worktree: VerifiedWorktree;
  readonly existingReviews: readonly DiscoveredReview[];
  readonly correlationId?: string;
  readonly now?: string;
}

export interface ReviewOnceResult {
  // True when the audit failed closed: no review is posted, no approval implied.
  readonly blocked: boolean;
  readonly verdict: ReviewVerdict | null;
  readonly posted: boolean;
  readonly reviewId: number | null;
  readonly state: PrState;
  readonly reason: string | null;
}

// One audit + review disposition for a single PR head. Fail-closed throughout: a
// malformed report, an unreachable model, or a mismatched head blocks with NO review
// and NO approval; only a valid audit reaches triage and posts exactly one review.
export async function reviewOnce(deps: ReviewOnceDeps, input: ReviewOnceInput): Promise<ReviewOnceResult> {
  const correlationId = input.correlationId ?? randomUUID();
  const now = input.now ?? new Date().toISOString();
  const { config } = deps;
  const pr = input.state.pr;
  const headSha = input.context.headSha;
  const started = Date.now();
  const markerKey = { pr, headSha, rubricVersion: input.context.rubricVersion };

  // Idempotency short-circuit: if an official CRA review already carries the
  // (pr, head, rubric) marker, a re-poll must NOT re-audit, re-write the immutable
  // artifact, or post a second review — the audited head was already dispositioned.
  const already = input.existingReviews.find(
    (review) => review.author === config.github.expectedLogin && bodyMatchesMarker(review.body, markerKey),
  );
  if (already !== undefined) {
    return {
      blocked: false,
      verdict: null,
      posted: false,
      reviewId: already.databaseId,
      state: input.state,
      reason: "already reviewed for this head",
    };
  }

  await emit(deps, correlationId, now, {
    type: "audit_start",
    pr,
    headSha,
    detail: { baseSha: input.context.baseSha },
  });

  let verified;
  try {
    verified = await deps.adapter.audit(input.context, input.worktree);
  } catch (error) {
    if (!(error instanceof AuditFailure)) throw error;
    const reason = error.message;
    const blockedState: PrState = {
      ...input.state,
      lastSeenHeadSha: headSha,
      disposition: "error",
      auditStatus: "failed",
      rubricVersion: config.rubricVersion,
      retry: { attempts: input.state.retry.attempts + 1, nextAttemptAt: null, lastError: reason },
    };
    await deps.stateStore.write(blockedState);
    await emit(deps, correlationId, now, {
      type: "audit_end",
      pr,
      headSha,
      durationMs: Date.now() - started,
      detail: { outcome: "failed", reason },
    });
    return { blocked: true, verdict: null, posted: false, reviewId: null, state: blockedState, reason };
  }

  await deps.artifactStore.writeReport({
    pr,
    headSha,
    baseSha: input.context.baseSha,
    rubricVersion: input.context.rubricVersion,
    createdAt: now,
    report: verified.report,
  });

  const triaged = triage(verified, { diff: input.context.evidence.diff });
  for (const finding of triaged.findings) {
    await emit(deps, correlationId, now, {
      type: "finding",
      pr,
      headSha,
      detail: { id: finding.id, severity: finding.severity, category: finding.category, forced: finding.forced },
    });
  }

  const review = await deps.poster.post(
    { pr, headSha, rubricVersion: input.context.rubricVersion },
    triaged,
    input.existingReviews,
  );
  await emit(deps, correlationId, now, {
    type: "review",
    pr,
    headSha,
    detail: { verdict: review.verdict, posted: review.posted, reviewId: review.reviewId, counts: triaged.counts },
  });

  const disposition = triaged.verdict === "APPROVE" ? "approved" : "changes_requested";
  const nextState: PrState = {
    ...input.state,
    lastSeenHeadSha: headSha,
    lastReviewedHeadSha: headSha,
    lastReviewedBaseSha: input.context.baseSha,
    rubricVersion: input.context.rubricVersion,
    reviewId: review.reviewId,
    findingIds: triaged.findings.map((finding) => finding.id),
    disposition,
    awaitingAuthorSince: triaged.verdict === "REQUEST_CHANGES" ? now : null,
    retry: { attempts: 0, nextAttemptAt: null, lastError: null },
    auditStatus: "completed",
  };
  await deps.stateStore.write(nextState);
  await emit(deps, correlationId, now, {
    type: "audit_end",
    pr,
    headSha,
    durationMs: Date.now() - started,
    detail: { outcome: "reviewed", verdict: triaged.verdict },
  });

  return {
    blocked: false,
    verdict: triaged.verdict,
    posted: review.posted,
    reviewId: review.reviewId,
    state: nextState,
    reason: null,
  };
}

interface EventFields {
  readonly type: "audit_start" | "audit_end" | "review" | "finding";
  readonly pr: number;
  readonly headSha: string;
  readonly durationMs?: number;
  readonly detail: Record<string, unknown>;
}

async function emit(deps: ReviewOnceDeps, correlationId: string, now: string, fields: EventFields): Promise<void> {
  await deps.events.append({
    timestamp: now,
    type: fields.type,
    pr: fields.pr,
    headSha: fields.headSha,
    rubricVersion: deps.config.rubricVersion,
    actor: deps.actor,
    durationMs: fields.durationMs ?? 0,
    correlationId,
    detail: fields.detail,
  });
}
