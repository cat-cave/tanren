import type { SensitivityRule } from "./sensitivity.js";
import { costSensitivityRules } from "./sensitivityRules.cost.js";
import { integrationProvisioningSensitivityRules } from "./sensitivityRules.integrations.js";

// Infrastructure-and-integration sensitivity rules, split out of
// sensitivityRules.ts to keep each file under the 500-line cap (role rules stay
// there). Covers the runtime substrate, cost/usage telemetry, and the
// integration surface (github/ci/phase1/reviews/notifications/onboarding/hello).
export const infraSensitivityRules: SensitivityRule[] = [
  // runner allocation
  ...rulesFor("allocator.requested", [
    ["allocator", "public"],
    ["runnerImage", "public"],
    ["identitySecretRef", "redacted"],
  ]),
  ...rulesFor("allocator.allocated", [
    ["runnerId", "public"],
    ["imageSha", "public"],
    ["target.host", "redacted"],
    ["target.port", "redacted"],
    ["target.username", "public"],
    ["target.hostKeyFingerprint", "redacted"],
  ]),
  ...rulesFor("allocator.failed", [["message", "public"]]),
  ...rulesFor("runner.allocated", [
    ["runnerId", "public"],
    ["imageSha", "public"],
    ["target.host", "redacted"],
    ["target.port", "redacted"],
    ["target.username", "public"],
    ["target.hostKeyFingerprint", "redacted"],
  ]),
  ...rulesFor("runner.released", [["runnerId", "public"]]),
  ...rulesFor("runner.failed", [
    ["runnerId", "public"],
    ["command", "redacted"],
    ["result.exitCode", "public"],
    ["result.stdout", "secret"],
    ["result.stderr", "secret"],
    ["result.timedOut", "public"],
    ["result.signal", "public"],
    ["result.failure", "redacted"],
    ["result.failure.reason", "redacted"],
    ["result.failure.message", "redacted"],
  ]),

  // workspace (workspace.failed.message → see P-APP-ENV-0 audit in sensitivityRules.ts)
  ...rulesFor("workspace.prepared", [
    ["runnerId", "public"],
    ["workspacePath", "public"],
    ["repoUrl", "public"],
    ["targetBranch", "public"],
  ]),
  ...rulesFor("workspace.git_captured", [
    ["workspacePath", "public"],
    ["commits[].sha", "public"],
    ["commits[].message", "public"],
    ["diffBytes", "public"],
  ]),
  ...rulesFor("workspace.failed", [
    ["runnerId", "public"],
    ["workspacePath", "public"],
    ["message", "public"],
  ]),

  // credentials — refs are redacted; raw value never appears in payloads
  ...rulesFor("credential.requested", [
    ["credentialKind", "public"],
    ["ref", "redacted"],
    ["redacted", "public"],
  ]),
  ...rulesFor("credential.loaded", [
    ["credentialKind", "public"],
    ["ref", "redacted"],
    ["redacted", "public"],
  ]),
  ...rulesFor("credential.failed", [
    ["ref", "redacted"],
    ["message", "public"],
  ]),
  // per-run scoped Vault token mint: ref paths embed the tenant (redacted); policy name + bounds public; the token value is NEVER in the payload.
  ...rulesFor("credential.scoped_token_minted", [
    ["policyName", "public"],
    ["refPaths[]", "redacted"],
    ["ttlSeconds", "public"],
    ["numUses", "public"],
  ]),

  // cost / cost-safety — extracted to ./sensitivityRules.cost.ts (500-line cap).
  ...costSensitivityRules,

  // usage monitoring (P2A-cost-monitors) — percent-of-window + token counts are non-sensitive operational telemetry; all public.
  ...rulesFor("usage.window.observed", [
    ["provider", "public"],
    ["windows[].slot", "public"],
    ["windows[].usedPercent", "public"],
    ["windows[].resetsAt", "public"],
    ["windows[].windowMinutes", "public"],
    ["windows[].resetDescription", "public"],
    ["creditsRemaining", "public"],
    ["source", "public"],
    ["capturedAt", "public"],
  ]),
  ...rulesFor("usage.window.pressure", [
    ["provider", "public"],
    ["slot", "public"],
    ["usedPercent", "public"],
    ["resetsAt", "public"],
  ]),
  ...rulesFor("usage.accounting.observed", [
    ["cli", "public"],
    ["totals.inputTokens", "public"],
    ["totals.cachedInputTokens", "public"],
    ["totals.cacheCreationTokens", "public"],
    ["totals.outputTokens", "public"],
    ["totals.reasoningOutputTokens", "public"],
    ["totals.totalTokens", "public"],
    ["costUsd", "public"],
    ["capturedAt", "public"],
  ]),

  // github
  ...rulesFor("github.branch.pushed", [
    ["repoUrl", "public"],
    ["branch", "public"],
    ["credentialRef", "redacted"],
    ["redacted", "public"],
  ]),
  ...rulesFor("github.pr.created", [
    ["repoUrl", "public"],
    ["branch", "public"],
    ["targetBranch", "public"],
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["reused", "public"],
  ]),
  ...rulesFor("github.pr.ready", [
    ["prUrl", "public"],
    ["prNumber", "public"],
  ]),
  ...rulesFor("github.pr.merged", [
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["mergeSha", "public"],
  ]),
  ...rulesFor("github.failed", [
    ["operation", "public"],
    ["branch", "public"],
    ["message", "public"],
  ]),

  // Flaky detection + quarantine rules live in sensitivityRules.ciIntel.ts
  // (next to ci.tests.reported) to keep this file under the 500-line cap.

  // reviews
  ...rulesFor("review.requested", [
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["reviewers", "public"],
    ["reviewers[]", "public"],
  ]),
  ...rulesFor("review.approved", [
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["reviewer", "public"],
  ]),
  ...rulesFor("review.auto_approved", [
    ["prUrl", "public"],
    ["prNumber", "public"],
  ]),
  ...rulesFor("review.changes_requested", [
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["reviewer", "public"],
    ["message", "public"],
  ]),

  // P3-0008 merge stage — PR identifiers + integration mode + prose, all public
  ...rulesFor("merge.queued", [
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["integration", "public"],
  ]),
  ...rulesFor("merge.completed", [
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["integration", "public"],
    ["mergeSha", "public"],
  ]),
  // P2d (§2d) native merge queue — PR identifiers + spec id + queue stats + prose,
  // all public (queue visibility + queue/stack statistics).
  ...rulesFor("merge.queue.advanced", [
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["integration", "public"],
    ["specId", "public"],
    ["queueDepth", "public"],
  ]),
  ...rulesFor("merge.dequeued", [
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["integration", "public"],
    ["specId", "public"],
    ["reason", "public"],
    ["message", "public"],
  ]),
  // GitHub-5xx resilience (GAP #2d): the per-PR coordinator's loud infra-halt — PR
  // identity + the halt kind + attempt count + the infra message, all public.
  ...rulesFor("merge.queue.infra_blocked", [
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["integration", "public"],
    ["specId", "public"],
    ["kind", "public"],
    ["attempts", "public"],
    ["message", "public"],
  ]),
  // P2d-2 (§2d) speculative batch-check + bisect — batch composition + cap/ceiling stats
  // + the integration ref + bisect prose, all public (queue/batch visibility).
  ...rulesFor("merge.batch.checking", [
    ["integration", "public"],
    ["members[].specId", "public"],
    ["members[].prNumber", "public"],
    ["eligibleCount", "public"],
    ["capped", "public"],
    ["maxBatchSize", "public"],
  ]),
  ...rulesFor("merge.batch.passed", [
    ["integration", "public"],
    ["members[].specId", "public"],
    ["members[].prNumber", "public"],
    ["integrationBranch", "public"],
  ]),
  ...rulesFor("merge.batch.bisecting", [
    ["integration", "public"],
    ["members[].specId", "public"],
    ["members[].prNumber", "public"],
    ["message", "public"],
  ]),
  ...rulesFor("merge.batch.culprit", [
    ["integration", "public"],
    ["specId", "public"],
    ["runId", "public"],
    ["prNumber", "public"],
    ["checks", "public"],
    ["message", "public"],
  ]),
  ...rulesFor("merge.batch.infra_blocked", [
    ["integration", "public"],
    ["members[].specId", "public"],
    ["members[].prNumber", "public"],
    ["message", "public"],
    ["attempts", "public"],
    ["terminal", "public"],
    ["consecutiveHolds", "public"],
  ]),
  ...rulesFor("merge.failed", [
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["integration", "public"],
    ["message", "public"],
  ]),
  ...rulesFor("merge.conflict", [
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["integration", "public"],
    ["baseBranch", "public"],
    ["headBranch", "public"],
    ["message", "public"],
  ]),
  // P2a up-to-date enforcement — PR identifiers + refs + freshness signal, public.
  ...rulesFor("merge.behind", [
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["integration", "public"],
    ["baseBranch", "public"],
    ["headBranch", "public"],
    ["mergeableState", "public"],
  ]),
  ...rulesFor("merge.rebased", [
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["integration", "public"],
    ["baseBranch", "public"],
    ["headBranch", "public"],
    ["reGatedCi", "public"],
  ]),
  // P2c-1 (§2c): a speculative dependent's merge held for unmerged ancestors —
  // PR identifiers + the integration ref + ancestor spec ids, all public.
  ...rulesFor("merge.speculative_held", [
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["integration", "public"],
    ["speculativeBase", "public"],
    ["unmergedAncestors[]", "public"],
  ]),
  // P2c-1 (§2c step 3): the cleared-hold retarget to default_branch + ref cleanup
  // — PR identifiers + branch refs, all public.
  ...rulesFor("merge.retargeted", [
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["integration", "public"],
    ["fromBase", "public"],
    ["toBase", "public"],
  ]),
  ...rulesFor("merge.integration_cleaned", [
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["integration", "public"],
    ["integrationBranch", "public"],
  ]),
  // P2b intent-preserving conflict resolution — PR identifiers + spec ids +
  // refs + the DAG-edge signal + file paths + reasoning prose, all public.
  ...rulesFor("merge.conflict.resolving", [
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["integration", "public"],
    ["baseBranch", "public"],
    ["mergingSpecId", "public"],
    ["conflictingSpecId", "public"],
    ["dagEdge", "public"],
    ["conflictedFiles", "public"],
    ["conflictedFiles[]", "public"],
  ]),
  ...rulesFor("merge.conflict.resolved", [
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["integration", "public"],
    ["baseBranch", "public"],
    ["mergingSpecId", "public"],
    ["conflictingSpecId", "public"],
    ["resolvedFiles", "public"],
    ["resolvedFiles[]", "public"],
    ["reGated", "public"],
  ]),
  ...rulesFor("merge.conflict.irreconcilable", [
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["integration", "public"],
    ["baseBranch", "public"],
    ["mergingSpecId", "public"],
    ["conflictingSpecId", "public"],
    ["replanned", "public"],
    ["replannedSpecId", "public"],
    ["reason", "public"],
    ["fromFailedReGate", "public"],
  ]),
  // P2b replan-routed — spec ids + new planning context + status, all public.
  ...rulesFor("merge.conflict.replan_routed", [
    ["specId", "public"],
    ["otherSpecId", "public"],
    ["newContext", "public"],
    ["replanStatus", "public"],
  ]),
  // P3-0023 governance posture block — PR identifiers + posture + external
  // contributor logins (public GitHub handles) + prose, all public.
  ...rulesFor("merge.blocked", [
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["integration", "public"],
    ["posture", "public"],
    ["mode", "public"],
    ["externalLogins", "public"],
    ["externalLogins[]", "public"],
    ["reason", "public"],
  ]),

  // notifications + P-INT-2 onboarding (the latter in its own module)
  ...rulesFor("notification.enqueued", [
    ["channel", "public"],
    ["eventName", "public"],
  ]),
  ...rulesFor("notification.sent", [
    ["channel", "public"],
    ["attempts", "public"],
  ]),
  ...rulesFor("notification.failed", [
    ["channel", "public"],
    ["message", "public"],
  ]),
  ...integrationProvisioningSensitivityRules,
  // hello run
  ...rulesFor("hello.started", []),
  ...rulesFor("hello.ssh_started", [
    ["runnerId", "public"],
    ["command", "redacted"],
    ["target.host", "redacted"],
    ["target.port", "redacted"],
    ["target.username", "public"],
    ["target.hostKeyFingerprint", "redacted"],
  ]),
  ...rulesFor("hello.ssh_completed", [
    ["runnerId", "public"],
    ["imageSha", "public"],
    ["target.host", "redacted"],
    ["target.port", "redacted"],
    ["target.username", "public"],
    ["target.hostKeyFingerprint", "redacted"],
    ["command", "redacted"],
    ["exitCode", "public"],
    ["stdout", "secret"],
    ["stderr", "secret"],
    ["timedOut", "public"],
  ]),
  ...rulesFor("hello.completed", [
    ["outcome", "public"],
    ["workspacePath", "public"],
    ["runnerProof.runnerId", "public"],
    ["runnerProof.imageSha", "public"],
    ["runnerProof.target.host", "redacted"],
    ["runnerProof.target.port", "redacted"],
    ["runnerProof.target.username", "public"],
    ["runnerProof.target.hostKeyFingerprint", "redacted"],
    ["runnerProof.command", "redacted"],
    ["runnerProof.exitCode", "public"],
    ["runnerProof.stdout", "secret"],
    ["runnerProof.stderr", "secret"],
    ["runnerProof.timedOut", "public"],
  ]),

  // redaction.raw_access audit event — these fields are the audit metadata itself,
  // not redacted payload values. All public so admins can see who accessed what.
  ...rulesFor("redaction.raw_access", [
    ["actorUserId", "public"],
    ["actorScopes", "public"],
    ["actorScopes[]", "public"],
    ["eventReadId", "public"],
    ["eventReadType", "public"],
    ["paths", "public"],
    ["paths[]", "public"],
    ["at", "public"],
  ]),
];

function rulesFor(eventName: string, entries: ReadonlyArray<[string, SensitivityRule["tag"]]>): SensitivityRule[] {
  return entries.map(([path, tag]) => ({ eventName, path, tag }));
}
