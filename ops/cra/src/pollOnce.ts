/* eslint-disable import/max-dependencies -- final CRA composition root wires the separately tested authority seams */
import { randomUUID } from "node:crypto";
import { AuditAdapter } from "./auditAdapter.js";
import { AuditArtifactStore } from "./artifactStore.js";
import { AuditInputAssembler, type PreparedAuditInput } from "./auditInput.js";
import { superviseAbandonment } from "./abandonment.js";
import type { CraConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { GithubDiscovery, selectReviewCandidates, type DiscoveredPullRequest } from "./discovery.js";
import { EventLog } from "./eventLog.js";
import { routeDeferredFindings } from "./findingIssues.js";
import { GithubAbandonmentGateway } from "./githubAbandonment.js";
import { GithubAppIdentity } from "./githubApp.js";
import { GithubFindingIssueGateway } from "./githubFindingIssues.js";
import { GithubMergeGateway } from "./githubMerge.js";
import { GitHubGroundTruthAssembler } from "./groundTruth.js";
import { DisposableCommandRunner } from "./isolatedRunner.js";
import { EventLogMergeRecorder } from "./mergeRecorder.js";
import { OfficialReviewPoster } from "./officialReview.js";
import type { CraPaths } from "./paths.js";
import { runApprovedPostReview } from "./postReview.js";
import { reviewOnce, type ReviewOnceResult } from "./reviewOnce.js";
import { ShadowReviewPoster } from "./shadowReview.js";
import { SingletonLease } from "./singleton.js";
import { runStagedCandidate, type StagedCandidateResult } from "./stagedRollout.js";
import { PrStateStore } from "./stateStore.js";
import type { PrState } from "./stateSchemas.js";
import type { NormalizedFinding } from "./triage.js";
import { WorktreeManager, type VerifiedWorktree } from "./worktree.js";

export interface DailyStatus {
  readonly type: "DAILY_STATUS";
  readonly date: string;
  readonly mode: CraConfig["mode"];
  readonly openPullRequests: number;
  readonly oldestAgeDays: number;
  readonly headsAwaitingAudit: number;
  readonly blockedPullRequests: number;
  readonly abandonmentCandidates: number;
  readonly mergedPullRequests: readonly number[];
  readonly findings: Readonly<Record<"P0" | "P1" | "P2" | "P3", number>>;
  readonly followUpIssues: readonly number[];
}

export interface PollOnceResult {
  readonly actor: string;
  readonly mode: CraConfig["mode"];
  readonly openPullRequests: number;
  readonly candidates: readonly number[];
  readonly dailyStatus: DailyStatus;
}

function initialState(pr: DiscoveredPullRequest, config: CraConfig): PrState {
  return {
    pr: pr.number,
    lastSeenHeadSha: pr.headSha,
    lastReviewedHeadSha: null,
    lastReviewedBaseSha: null,
    auditedIssueNumber: null,
    rubricVersion: config.rubricVersion,
    reviewId: null,
    findingIds: [],
    disposition: "pending",
    firstAuthorActivityAt: pr.firstAuthorActivityAt,
    lastAuthorActivityAt: pr.lastAuthorActivityAt,
    awaitingAuthorSince: null,
    retry: { attempts: 0, nextAttemptAt: null, lastError: null },
    followUpIssues: [],
    reminderDaysSent: [],
    abandonmentReason: null,
    auditStatus: "idle",
    lastCompletedMode: null,
    reviewFindings: [],
  };
}

function observedState(pr: DiscoveredPullRequest, previous: PrState): PrState {
  const headChanged = previous.lastSeenHeadSha !== pr.headSha;
  const authorActivityChanged = previous.lastAuthorActivityAt < pr.lastAuthorActivityAt;
  return {
    ...previous,
    lastSeenHeadSha: pr.headSha,
    firstAuthorActivityAt:
      previous.firstAuthorActivityAt < pr.firstAuthorActivityAt
        ? previous.firstAuthorActivityAt
        : pr.firstAuthorActivityAt,
    lastAuthorActivityAt:
      previous.lastAuthorActivityAt > pr.lastAuthorActivityAt ? previous.lastAuthorActivityAt : pr.lastAuthorActivityAt,
    awaitingAuthorSince: headChanged
      ? null
      : authorActivityChanged && previous.awaitingAuthorSince !== null
        ? pr.lastAuthorActivityAt
        : previous.awaitingAuthorSince,
    reminderDaysSent: headChanged || authorActivityChanged ? [] : previous.reminderDaysSent,
    lastCompletedMode: headChanged ? null : previous.lastCompletedMode,
    reviewFindings: headChanged ? [] : previous.reviewFindings,
  };
}

interface CandidateContext {
  readonly pr: DiscoveredPullRequest;
  readonly prepared: PreparedAuditInput;
  readonly worktree: VerifiedWorktree;
  readonly state: PrState;
}

async function appendError(
  events: EventLog,
  config: CraConfig,
  actor: string,
  correlationId: string,
  pr: DiscoveredPullRequest,
  error: unknown,
): Promise<void> {
  await events.append({
    timestamp: new Date().toISOString(),
    type: "error",
    pr: pr.number,
    headSha: pr.headSha,
    rubricVersion: config.rubricVersion,
    actor,
    durationMs: 0,
    correlationId,
    detail: { message: error instanceof Error ? error.message : String(error) },
  });
}

async function routeIssues(
  gateway: GithubFindingIssueGateway,
  stateStore: PrStateStore,
  config: CraConfig,
  context: CandidateContext,
  review: ReviewOnceResult,
  eventContext: { readonly events: EventLog; readonly actor: string; readonly correlationId: string },
): Promise<number[]> {
  if (review.reviewId === null) throw new Error("official review id is required before issue routing");
  const routed = await routeDeferredFindings(
    gateway,
    {
      repository: config.repository,
      pr: context.pr.number,
      headSha: context.pr.headSha,
      reviewId: review.reviewId,
      bucketLabel: context.prepared.bucketLabel,
      blockedBy: context.prepared.blockedBy,
    },
    review.findings,
  );
  const numbers = routed.map((issue) => issue.number);
  await stateStore.write({
    ...review.state,
    followUpIssues: [...new Set([...review.state.followUpIssues, ...numbers])].sort((left, right) => left - right),
  });
  await eventContext.events.append({
    timestamp: new Date().toISOString(),
    type: "issue_routing",
    pr: context.pr.number,
    headSha: context.pr.headSha,
    rubricVersion: config.rubricVersion,
    actor: eventContext.actor,
    durationMs: 0,
    correlationId: eventContext.correlationId,
    detail: { issues: numbers },
  });
  return numbers;
}

async function stageCandidate(
  config: CraConfig,
  token: string,
  actor: string,
  correlationId: string,
  context: CandidateContext,
  common: {
    readonly stateStore: PrStateStore;
    readonly artifacts: AuditArtifactStore;
    readonly events: EventLog;
    readonly lease: SingletonLease;
    readonly paths: CraPaths;
  },
): Promise<StagedCandidateResult> {
  const runner = new DisposableCommandRunner(config);
  const reviewDeps = (poster: Parameters<typeof reviewOnce>[0]["poster"]) => ({
    config,
    actor,
    adapter: new AuditAdapter(config, runner),
    assembler: new GitHubGroundTruthAssembler(config, token),
    poster,
    stateStore: common.stateStore,
    artifactStore: common.artifacts,
    events: common.events,
  });
  const audit = async (poster: Parameters<typeof reviewOnce>[0]["poster"]) =>
    await reviewOnce(reviewDeps(poster), {
      state: context.state,
      context: context.prepared.context,
      worktree: context.worktree,
      existingReviews: context.pr.reviews,
      correlationId,
    });

  if (config.mode === "shadow") {
    return await runStagedCandidate({
      mode: "shadow",
      auditToLocalDraft: async () => await audit(new ShadowReviewPoster(common.paths)),
    });
  }

  const issueGateway = new GithubFindingIssueGateway(config, token);
  const abandonment = async (review: ReviewOnceResult) => {
    const priorIssues = review.state.followUpIssues;
    const plan = await superviseAbandonment(
      config,
      common.stateStore,
      new GithubAbandonmentGateway(config, token),
      {
        state: review.state,
        observation: {
          now: new Date().toISOString(),
          headSha: context.pr.headSha,
          substantiveAuthorActivityAt: context.pr.lastAuthorActivityAt,
          findings: review.findings,
        },
        sourceIssue: context.prepared.sourceIssue,
      },
      async (findings: readonly NormalizedFinding[]) => {
        if (review.reviewId === null) throw new Error("review id missing during abandonment routing");
        const routed = await routeDeferredFindings(
          issueGateway,
          {
            repository: config.repository,
            pr: context.pr.number,
            headSha: context.pr.headSha,
            reviewId: review.reviewId,
            bucketLabel: context.prepared.bucketLabel,
            blockedBy: context.prepared.blockedBy,
          },
          findings,
        );
        return routed.map((issue) => issue.number);
      },
    );
    const newIssues = plan.state.followUpIssues.filter((issue) => !priorIssues.includes(issue));
    if (newIssues.length > 0) {
      await common.events.append({
        timestamp: new Date().toISOString(),
        type: "issue_routing",
        pr: context.pr.number,
        headSha: context.pr.headSha,
        rubricVersion: config.rubricVersion,
        actor,
        durationMs: 0,
        correlationId,
        detail: { issues: newIssues },
      });
    }
    if (plan.abandon !== null) {
      await common.events.append({
        timestamp: new Date().toISOString(),
        type: "abandonment",
        pr: context.pr.number,
        headSha: context.pr.headSha,
        rubricVersion: config.rubricVersion,
        actor,
        durationMs: 0,
        correlationId,
        detail: { reason: plan.abandon },
      });
    }
  };
  const auditAndPostReview = async () => await audit(new OfficialReviewPoster(config, token));
  if (config.mode === "review") {
    return await runStagedCandidate({
      mode: "review",
      auditAndPostReview,
      routeIssues: async (review) =>
        await routeIssues(issueGateway, common.stateStore, config, context, review, {
          events: common.events,
          actor,
          correlationId,
        }),
      superviseAbandonment: abandonment,
    });
  }
  return await runStagedCandidate({
    mode: "merge",
    auditAndPostReview,
    superviseAbandonment: abandonment,
    mergeIfClear: async (review) => {
      if (review.reviewId === null) throw new Error("review id missing before merge authorization");
      const result = await runApprovedPostReview(
        {
          mergeGateway: new GithubMergeGateway(config, token, common.artifacts, common.stateStore, common.lease),
          issueGateway,
          stateStore: common.stateStore,
          recorder: new EventLogMergeRecorder(common.events, {
            pr: context.pr.number,
            headSha: context.pr.headSha,
            rubricVersion: config.rubricVersion,
            actor,
            correlationId,
          }),
        },
        {
          state: review.state,
          authorization: {
            pr: context.pr.number,
            auditedHeadSha: context.pr.headSha,
            auditedBaseSha: context.pr.baseSha,
            auditedIssueNumber: context.prepared.sourceIssue,
            rubricVersion: config.rubricVersion,
            casHeadSha: context.pr.headSha,
          },
          issueContext: {
            repository: config.repository,
            pr: context.pr.number,
            headSha: context.pr.headSha,
            reviewId: review.reviewId,
            bucketLabel: context.prepared.bucketLabel,
            blockedBy: context.prepared.blockedBy,
          },
          findings: review.findings,
        },
      );
      const newIssues = result.state.followUpIssues.filter((issue) => !review.state.followUpIssues.includes(issue));
      if (newIssues.length > 0) {
        await common.events.append({
          timestamp: new Date().toISOString(),
          type: "issue_routing",
          pr: context.pr.number,
          headSha: context.pr.headSha,
          rubricVersion: config.rubricVersion,
          actor,
          durationMs: 0,
          correlationId,
          detail: { issues: newIssues },
        });
      }
      return result.merge.merged && result.merge.verified;
    },
  });
}

function dailyStatus(
  config: CraConfig,
  pullRequests: readonly DiscoveredPullRequest[],
  states: readonly PrState[],
  candidates: readonly DiscoveredPullRequest[],
  results: readonly StagedCandidateResult[],
): DailyStatus {
  const now = Date.now();
  const findings = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const result of results) for (const finding of result.review.findings) findings[finding.severity] += 1;
  const firstActivity = pullRequests.map((pr) => new Date(pr.firstAuthorActivityAt).getTime());
  return {
    type: "DAILY_STATUS",
    date: new Date(now).toISOString().slice(0, 10),
    mode: config.mode,
    openPullRequests: pullRequests.length,
    oldestAgeDays: firstActivity.length === 0 ? 0 : Math.floor((now - Math.min(...firstActivity)) / 86_400_000),
    headsAwaitingAudit: candidates.length - results.length,
    blockedPullRequests: states.filter((state) => ["changes_requested", "error"].includes(state.disposition)).length,
    abandonmentCandidates: states.filter((state) => state.awaitingAuthorSince !== null).length,
    mergedPullRequests: results.filter((result) => result.merged).map((result) => result.review.state.pr),
    findings,
    followUpIssues: [...new Set(states.flatMap((state) => state.followUpIssues))].sort((a, b) => a - b),
  };
}

export async function pollOnce(configFile?: string): Promise<PollOnceResult> {
  const { config, paths } = await loadConfig(configFile);
  const lease = await SingletonLease.acquire(paths.lockFile, config.commands.flock);
  const stateStore = new PrStateStore(paths, lease);
  const events = new EventLog(paths, lease);
  const started = Date.now();
  const correlationId = randomUUID();
  let actor = config.github.expectedLogin;
  try {
    await stateStore.recover();
    const worktrees = new WorktreeManager(config);
    await worktrees.recover();
    const identity = new GithubAppIdentity(config);
    const token = await identity.mintInstallationToken();
    actor = await identity.verify(token);
    const pullRequests = await new GithubDiscovery(config, token).listOpenPullRequests();
    const states = new Map<number, PrState>();
    for (const pr of pullRequests) {
      const previous = await stateStore.read(pr.number);
      const next = previous === undefined ? initialState(pr, config) : observedState(pr, previous);
      await stateStore.write(next);
      states.set(pr.number, next);
    }
    const candidates = selectReviewCandidates(pullRequests, states, config.rubricVersion, config.mode);
    const artifacts = new AuditArtifactStore(paths, lease);
    const results: StagedCandidateResult[] = [];
    const failures: Error[] = [];
    for (const pr of candidates) {
      let worktree: VerifiedWorktree | null = null;
      try {
        worktree = await worktrees.create(pr.number, pr.headSha);
        const prepared = await new AuditInputAssembler(config, token).prepare(pr, worktree);
        const result = await stageCandidate(
          config,
          token,
          actor,
          correlationId,
          {
            pr,
            prepared,
            worktree,
            state: states.get(pr.number)!,
          },
          { stateStore, artifacts, events, lease, paths },
        );
        results.push(result);
        if (result.review.blocked) throw new Error(result.review.reason ?? "audit failed closed");
        if (config.mode !== "merge" || result.merged) {
          const current = await stateStore.read(pr.number);
          if (current === undefined) throw new Error(`PR #${pr.number} state disappeared`);
          await stateStore.write({ ...current, lastCompletedMode: config.mode });
        }
      } catch (error) {
        failures.push(error as Error);
        await appendError(events, config, actor, correlationId, pr, error);
      } finally {
        if (worktree !== null) {
          try {
            await worktrees.cleanup(worktree);
            await events.append({
              timestamp: new Date().toISOString(),
              type: "cleanup",
              pr: pr.number,
              headSha: pr.headSha,
              rubricVersion: config.rubricVersion,
              actor,
              durationMs: 0,
              correlationId,
              detail: { outcome: "removed" },
            });
          } catch (error) {
            failures.push(error as Error);
            await appendError(events, config, actor, correlationId, pr, error);
          }
        }
      }
    }
    const persisted = await stateStore.list();
    const status = dailyStatus(config, pullRequests, persisted, candidates, results);
    await events.append({
      timestamp: new Date().toISOString(),
      type: "poll",
      pr: null,
      headSha: null,
      rubricVersion: config.rubricVersion,
      actor,
      durationMs: Date.now() - started,
      correlationId,
      detail: { ...status },
    });
    if (failures.length > 0) throw new AggregateError(failures, `${failures.length} CRA candidate failure(s)`);
    return {
      actor,
      mode: config.mode,
      openPullRequests: pullRequests.length,
      candidates: candidates.map((candidate) => candidate.number),
      dailyStatus: status,
    };
  } finally {
    await lease.release();
  }
}
