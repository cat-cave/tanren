import type { SensitivityRule } from "./sensitivity.js";

// Infrastructure-and-integration sensitivity rules, split out of
// sensitivityRules.ts to keep each file under the 500-line cap. Covers the
// runtime substrate (runner/allocator/workspace/credential), cost + usage
// telemetry, and the integration surface (github/ci/phase1/reviews/
// notifications/hello/redaction). Role rules (run/task/planner/writer/checker/
// auditor) remain in sensitivityRules.ts.
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

  // workspace
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

  // cost
  ...rulesFor("cost.resolved", [
    ["taskId", "public"],
    ["cli", "public"],
    ["provider", "public"],
    ["model", "public"],
    ["costUsd", "public"],
    ["billingMode", "public"],
    ["costBasis", "public"],
  ]),
  ...rulesFor("cost.failed", [
    ["taskId", "public"],
    ["message", "public"],
  ]),
  ...rulesFor("cost.unattributable", [
    ["taskId", "public"],
    ["cli", "public"],
    ["authRef", "redacted"],
    ["reason", "public"],
    ["inputTokens", "public"],
    ["outputTokens", "public"],
    ["cachedInputTokens", "public"],
  ]),

  // usage monitoring (P2A-cost-monitors) — percent-of-window + token counts
  // are non-sensitive operational telemetry; all public.
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

  // ci.* (observation payloads share field shape)
  ...ciObservationRules("ci.started"),
  ...ciObservationRules("ci.passed"),
  ...ciObservationRules("ci.failed"),

  // phase 1 fixture orchestration
  ...rulesFor("phase1.fixture.started", [
    ["repoUrl", "public"],
    ["targetBranch", "public"],
  ]),
  ...rulesFor("phase1.fixture.ci_pending", [
    ["attempt", "public"],
    ["nextPollAfterMs", "public"],
  ]),
  ...rulesFor("phase1.fixture.completed", [
    ["prUrl", "public"],
    ["ciStatus", "public"],
  ]),
  ...rulesFor("phase1.fixture.failed", [["message", "public"]]),

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
    ["queueLabel", "public"],
  ]),
  ...rulesFor("merge.completed", [
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["integration", "public"],
    ["mergeSha", "public"],
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

  // notifications
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

  // redaction.raw_access audit event — these fields are the audit metadata
  // itself, not redacted payload values. All public so org/platform admins
  // can see who accessed what.
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

function ciObservationRules(eventName: string): SensitivityRule[] {
  return rulesFor(eventName, [
    ["prUrl", "public"],
    ["credentialRef", "redacted"],
    ["redacted", "public"],
    ["status", "public"],
    ["reason", "public"],
    ["headSha", "public"],
    ["checkRuns[].name", "public"],
    ["checkRuns[].status", "public"],
    ["checkRuns[].conclusion", "public"],
    ["checkRuns[].url", "public"],
    ["statuses[].context", "public"],
    ["statuses[].state", "public"],
    ["statuses[].url", "public"],
    ["failingChecks[].kind", "public"],
    ["failingChecks[].name", "public"],
    ["failingChecks[].state", "public"],
    ["failingChecks[].url", "public"],
    ["pendingChecks[].kind", "public"],
    ["pendingChecks[].name", "public"],
    ["pendingChecks[].state", "public"],
    ["pendingChecks[].url", "public"],
  ]);
}
