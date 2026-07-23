import type { DiscoveredCheck } from "./discovery.js";
import type { FindingSeverity } from "./auditReport.js";

export interface MergeAuthorizationInput {
  readonly pr: number;
  readonly auditedHeadSha: string;
  readonly auditedBaseSha: string;
  readonly auditedIssueNumber: number;
  readonly rubricVersion: string;
  readonly casHeadSha: string;
}

export interface MergeAuthorizationSnapshot {
  readonly pr: number;
  readonly repository: string;
  readonly state: string;
  readonly isDraft: boolean;
  readonly baseBranch: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly title: string;
  readonly body: string;
  readonly historyVersion: string;
  readonly rulesetVersion: string;
  readonly mergeStateStatus: string;
  readonly mergeable: string;
  readonly auditedIssueNumber: number;
  readonly sourceIssues: readonly {
    readonly number: number;
    readonly state: string;
    readonly appropriate: boolean;
    readonly blockers: readonly { number: number; state: string }[];
  }[];
  readonly latestCraReview: {
    readonly id: number;
    readonly actor: string;
    readonly state: string;
    readonly headSha: string;
    readonly rubricVersion: string;
    readonly reportValid: boolean;
    readonly latest: boolean;
    readonly dismissed: boolean;
    readonly findingSeverities: readonly FindingSeverity[];
    readonly unresolvedRequiredChecks: readonly string[];
  } | null;
  readonly requiredContexts: readonly string[];
  readonly checks: readonly DiscoveredCheck[];
  readonly rateLimited: boolean;
  readonly health: {
    readonly identity: boolean;
    readonly permissions: boolean;
    readonly singletonLease: boolean;
    readonly statePersistence: boolean;
    readonly readAfterWrite: boolean;
  };
}

export interface MergeCallResult {
  readonly merged: boolean;
  readonly mergeCommitSha: string | null;
}

export interface IssueClosureReconciliation {
  readonly closedByPullRequest: readonly number[];
  readonly auditedIssueState: string;
}

export interface MergedPullRequest {
  readonly state: string;
  readonly headSha: string;
  readonly mergeCommitSha: string | null;
}

export interface MergeAuthorityGateway {
  readFresh(input: MergeAuthorizationInput): Promise<MergeAuthorizationSnapshot>;
  squashMerge(
    pr: number,
    expectedHeadSha: string,
    commitTitle: string,
    commitMessage: string,
  ): Promise<MergeCallResult>;
  readMerged(pr: number): Promise<MergedPullRequest>;
  readIssueClosureReconciliation(
    pr: number,
    auditedIssue: number,
    mergeCommitSha: string,
  ): Promise<IssueClosureReconciliation>;
  reopenWronglyClosedIssue(pr: number, issue: number): Promise<void>;
  ensureAuditedIssueClosed(pr: number, issue: number): Promise<void>;
}

export interface MergeSecurityAnomaly {
  readonly pr: number;
  readonly headSha: string;
  readonly mergeCommitSha: string;
  readonly auditedIssueNumber: number;
  readonly observedClosedIssues: readonly number[] | null;
  readonly reopenedIssues: readonly number[];
  readonly auditedIssueClosed: boolean;
  readonly reasons: readonly string[];
}

export interface MergeAuthorityRecorder {
  record(kind: "authorized" | "denied", reasons: readonly string[]): Promise<void>;
  recordSecurityAnomaly(anomaly: MergeSecurityAnomaly): Promise<void>;
}

export interface MergeAuthorityDeps {
  readonly gateway: MergeAuthorityGateway;
  readonly recorder: MergeAuthorityRecorder;
  readonly afterVerifiedMerge?: (mergeCommitSha: string) => Promise<void>;
}

export interface MergeAuthorityResult {
  readonly merged: boolean;
  readonly verified: boolean;
  readonly anomalous: boolean;
  readonly mergeCommitSha: string | null;
  readonly reasons: readonly string[];
}

function checkPasses(check: DiscoveredCheck): boolean {
  if (check.kind === "status_context") return check.status.toUpperCase() === "SUCCESS";
  return check.status.toUpperCase() === "COMPLETED" && check.conclusion?.toUpperCase() === "SUCCESS";
}

export function denyReasons(snapshot: MergeAuthorizationSnapshot, input: MergeAuthorizationInput): string[] {
  const reasons: string[] = [];
  if (snapshot.pr !== input.pr || snapshot.repository.length === 0) reasons.push("PR identity is unconfirmable");
  if (snapshot.state !== "OPEN") reasons.push("PR is not open");
  if (snapshot.isDraft) reasons.push("PR is draft");
  if (snapshot.baseBranch !== "main") reasons.push("PR does not target main");
  if (
    snapshot.headSha !== input.auditedHeadSha ||
    snapshot.headSha !== input.casHeadSha ||
    input.casHeadSha !== input.auditedHeadSha
  )
    reasons.push("head differs from audited head or CAS argument");
  if (snapshot.baseSha !== input.auditedBaseSha) reasons.push("base changed since audit");
  if (snapshot.auditedIssueNumber !== input.auditedIssueNumber) reasons.push("audited issue binding is unconfirmable");
  if (snapshot.sourceIssues.length !== 1) reasons.push("source issue linkage is absent or ambiguous");
  const source = snapshot.sourceIssues[0];
  if (source !== undefined) {
    if (source.number !== snapshot.auditedIssueNumber || source.number !== input.auditedIssueNumber)
      reasons.push("live closing issue differs from audited issue");
    if (!source.appropriate) reasons.push("source issue is not appropriate for this PR");
    if (source.state !== "OPEN") reasons.push("source issue is not open");
    if (source.blockers.some((blocker) => blocker.state !== "CLOSED")) reasons.push("source issue has open blocked_by");
  }
  const review = snapshot.latestCraReview;
  if (review === null) reasons.push("latest CRA review is missing");
  else {
    if (!review.latest) reasons.push("CRA review freshness is unconfirmable");
    if (review.dismissed) reasons.push("CRA review was dismissed");
    if (review.state !== "APPROVED") reasons.push("latest CRA review is not approved");
    if (review.headSha !== snapshot.headSha) reasons.push("CRA review is for a different head");
    if (review.rubricVersion !== input.rubricVersion) reasons.push("CRA rubric is stale");
    if (!review.reportValid) reasons.push("CRA audit report is invalid");
    if (review.findingSeverities.some((severity) => severity === "P0" || severity === "P1"))
      reasons.push("CRA audit contains P0/P1");
    if (review.unresolvedRequiredChecks.length > 0) reasons.push("CRA audit has unresolved required checks");
  }
  if (snapshot.requiredContexts.length === 0) reasons.push("required check set is missing");
  for (const context of snapshot.requiredContexts) {
    const matches = snapshot.checks.filter((check) => check.name === context);
    if (matches.length === 0) reasons.push(`required check missing: ${context}`);
    else if (matches.length !== 1 || !checkPasses(matches[0]!))
      reasons.push(`required check not successful: ${context}`);
  }
  if (snapshot.mergeStateStatus !== "CLEAN") reasons.push(`merge state is ${snapshot.mergeStateStatus}`);
  if (snapshot.mergeable !== "MERGEABLE") reasons.push(`mergeability is ${snapshot.mergeable}`);
  if (snapshot.rulesetVersion.length === 0 || snapshot.historyVersion.length === 0)
    reasons.push("decision version is unconfirmable");
  if (snapshot.rateLimited) reasons.push("GitHub rate limit prevents confirmation");
  for (const [name, healthy] of Object.entries(snapshot.health)) if (!healthy) reasons.push(`${name} is unhealthy`);
  return reasons;
}

function stabilityKey(snapshot: MergeAuthorizationSnapshot): string {
  return JSON.stringify({
    pr: snapshot.pr,
    state: snapshot.state,
    isDraft: snapshot.isDraft,
    baseBranch: snapshot.baseBranch,
    baseSha: snapshot.baseSha,
    headSha: snapshot.headSha,
    title: snapshot.title,
    body: snapshot.body,
    historyVersion: snapshot.historyVersion,
    rulesetVersion: snapshot.rulesetVersion,
    mergeStateStatus: snapshot.mergeStateStatus,
    mergeable: snapshot.mergeable,
    auditedIssueNumber: snapshot.auditedIssueNumber,
    sourceIssues: snapshot.sourceIssues,
    latestCraReview: snapshot.latestCraReview,
    requiredContexts: snapshot.requiredContexts,
    checks: snapshot.checks,
    health: snapshot.health,
  });
}

async function denied(deps: MergeAuthorityDeps, reasons: readonly string[]): Promise<MergeAuthorityResult> {
  await deps.recorder.record("denied", reasons);
  return { merged: false, verified: false, anomalous: false, mergeCommitSha: null, reasons };
}

function postMergeRaceReasons(snapshot: MergeAuthorizationSnapshot, input: MergeAuthorizationInput): string[] {
  const reasons: string[] = [];
  const review = snapshot.latestCraReview;
  if (review === null) reasons.push("post-merge CRA review is missing");
  else {
    if (review.dismissed || review.state !== "APPROVED") reasons.push("CRA-approved review changed during merge");
    if (!review.latest) reasons.push("CRA-approved review was superseded during merge");
    if (review.headSha !== input.auditedHeadSha) reasons.push("post-merge CRA review is for a different head");
  }
  if (snapshot.requiredContexts.length === 0) reasons.push("post-merge required check set is missing");
  for (const context of snapshot.requiredContexts) {
    const matches = snapshot.checks.filter((check) => check.name === context);
    if (matches.length !== 1 || !checkPasses(matches[0]!))
      reasons.push(`required check changed during merge: ${context}`);
  }
  return reasons;
}

const controlledCommitTitle = (pr: number) => `CRA squash merge of PR #${pr}`;
const controlledCommitMessage = (headSha: string) =>
  `Central Review Authority merged audited head ${headSha}. Issue closure is reconciled separately.`;

// Fresh reads bracket authorization, and a third authoritative read happens after
// recording the decision and immediately before the SHA-CAS merge. Every mutable
// decision field must remain byte-for-byte stable throughout.
export async function authorizeAndSquashMerge(
  deps: MergeAuthorityDeps,
  input: MergeAuthorizationInput,
): Promise<MergeAuthorityResult> {
  try {
    const first = await deps.gateway.readFresh(input);
    const firstReasons = denyReasons(first, input);
    if (firstReasons.length > 0) return await denied(deps, firstReasons);
    const final = await deps.gateway.readFresh(input);
    const finalReasons = denyReasons(final, input);
    if (finalReasons.length > 0) return await denied(deps, finalReasons);
    if (stabilityKey(first) !== stabilityKey(final)) return await denied(deps, ["authorization inputs changed"]);
    await deps.recorder.record("authorized", []);
    const preMerge = await deps.gateway.readFresh(input);
    const preMergeReasons = denyReasons(preMerge, input);
    if (preMergeReasons.length > 0) return await denied(deps, preMergeReasons);
    if (stabilityKey(final) !== stabilityKey(preMerge))
      return await denied(deps, ["authorization inputs changed before merge"]);
    const response = await deps.gateway.squashMerge(
      input.pr,
      input.casHeadSha,
      controlledCommitTitle(input.pr),
      controlledCommitMessage(input.auditedHeadSha),
    );
    if (!response.merged || response.mergeCommitSha === null) {
      return await denied(deps, ["merge response did not confirm a merge commit"]);
    }
    const verified = await deps.gateway.readMerged(input.pr);
    if (
      verified.state !== "MERGED" ||
      verified.headSha !== input.casHeadSha ||
      verified.mergeCommitSha !== response.mergeCommitSha
    )
      return await denied(deps, ["post-merge read did not confirm PR state, head, and merge commit"]);

    const anomalyReasons: string[] = [];
    let observedClosedIssues: readonly number[] | null = null;
    const reopenedIssues: number[] = [];
    let auditedIssueClosed = false;
    const [closureRead, raceRead] = await Promise.allSettled([
      deps.gateway.readIssueClosureReconciliation(input.pr, input.auditedIssueNumber, response.mergeCommitSha),
      deps.gateway.readFresh(input),
    ]);
    if (closureRead.status === "rejected") {
      anomalyReasons.push(`issue-closure reconciliation read failed: ${String(closureRead.reason)}`);
    } else {
      observedClosedIssues = [...new Set(closureRead.value.closedByPullRequest)].sort((left, right) => left - right);
      const wrongIssues = observedClosedIssues.filter((issue) => issue !== input.auditedIssueNumber);
      const closureSetIsExact =
        observedClosedIssues.length === 1 && observedClosedIssues[0] === input.auditedIssueNumber;
      if (!closureSetIsExact) {
        anomalyReasons.push(
          `GitHub closed issues [${observedClosedIssues.join(", ")}] instead of audited issue #${input.auditedIssueNumber}`,
        );
      }
      for (const issue of wrongIssues) {
        try {
          await deps.gateway.reopenWronglyClosedIssue(input.pr, issue);
          reopenedIssues.push(issue);
        } catch (error) {
          anomalyReasons.push(`failed to reopen wrongly-closed issue #${issue}: ${(error as Error).message}`);
        }
      }
      if (closureRead.value.auditedIssueState === "CLOSED") auditedIssueClosed = true;
      else {
        anomalyReasons.push(`audited issue #${input.auditedIssueNumber} was not closed by the merge`);
        try {
          await deps.gateway.ensureAuditedIssueClosed(input.pr, input.auditedIssueNumber);
          auditedIssueClosed = true;
        } catch (error) {
          anomalyReasons.push(
            `failed to close audited issue #${input.auditedIssueNumber}: ${(error as Error).message}`,
          );
        }
      }
    }
    if (raceRead.status === "rejected") {
      anomalyReasons.push(`post-merge review/check read failed: ${String(raceRead.reason)}`);
    } else anomalyReasons.push(...postMergeRaceReasons(raceRead.value, input));

    if (anomalyReasons.length > 0) {
      const anomaly: MergeSecurityAnomaly = {
        pr: input.pr,
        headSha: input.auditedHeadSha,
        mergeCommitSha: response.mergeCommitSha,
        auditedIssueNumber: input.auditedIssueNumber,
        observedClosedIssues,
        reopenedIssues,
        auditedIssueClosed,
        reasons: anomalyReasons,
      };
      try {
        await deps.recorder.recordSecurityAnomaly(anomaly);
      } catch (error) {
        anomalyReasons.push(`SECURITY ANOMALY recording failed: ${(error as Error).message}`);
      }
    }
    try {
      await deps.afterVerifiedMerge?.(response.mergeCommitSha);
    } catch (error) {
      return {
        merged: true,
        verified: true,
        anomalous: anomalyReasons.length > 0,
        mergeCommitSha: response.mergeCommitSha,
        reasons: [...anomalyReasons, `post-merge action requires retry: ${(error as Error).message}`],
      };
    }
    return {
      merged: true,
      verified: true,
      anomalous: anomalyReasons.length > 0,
      mergeCommitSha: response.mergeCommitSha,
      reasons: anomalyReasons,
    };
  } catch (error) {
    return await denied(deps, [`authorization unconfirmable: ${(error as Error).message}`]);
  }
}
