import { registerSensitivities, type SensitivityRule } from "./sensitivity.js";

// Sensitivity rule table. Every payload field reachable from an event must
// have a registered tag. The eventRegistryFieldCoverage test enforces this so
// missing tags become a hard CI failure.
//
// Tag taxonomy:
// - public:   safe to display to any project member
// - redacted: requires project:admin scope to view raw
// - secret:   requires platform:admin scope to view raw
//
// Heuristics applied here:
// - identifiers (runIds, taskIds, sha hashes, paths) are public
// - human-authored prose (intents, reasoning, decisions) is public
// - host fingerprints, credential refs, SSH host/port — redacted
// - secrets, raw tokens, command stdout/stderr — secret
//
// Per-array paths use the "[]" suffix to indicate "applies to every element".

export const sensitivityRules: SensitivityRule[] = [
  // run.queued
  ...rulesFor("run.queued", [
    ["trigger", "public"],
    ["branch", "public"],
    ["plannerTaskId", "public"],
    ["plannerJobId", "public"],
    ["project.repoUrl", "public"],
    ["project.defaultBranch", "public"],
    ["project.runnerImage", "public"],
    ["project.allocator", "public"],
    ["spec.title", "public"],
    ["spec.acceptanceCriteria[]", "public"],
    ["spec.dependsOn[]", "public"]
  ]),

  // run.started / run.completed / run.failed
  ...rulesFor("run.started", [["status", "public"]]),
  ...rulesFor("run.completed", [["status", "public"], ["outcome", "public"]]),
  ...rulesFor("run.failed", [["status", "public"], ["message", "public"]]),

  // task lifecycle
  ...rulesFor("task.queued", [["taskKind", "public"], ["jobId", "public"]]),
  ...rulesFor("task.started", [["taskKind", "public"], ["jobId", "public"]]),
  ...rulesFor("task.completed", [
    ["taskKind", "public"],
    ["jobId", "public"],
    ["status", "public"],
    ["reason", "public"]
  ]),
  ...rulesFor("task.failed", [
    ["taskKind", "public"],
    ["jobId", "public"],
    ["kind", "public"],
    ["failureKind", "public"],
    ["message", "public"],
    ["status", "public"],
    ["reason", "public"]
  ]),

  // planner role
  ...rulesFor("planner.started", [
    ["taskKind", "public"],
    ["intent", "public"],
    ["rationale", "public"]
  ]),
  ...rulesFor("planner.completed", [
    ["subtasks[].title", "public"],
    ["subtasks[].acceptanceCriteria", "public"],
    ["subtasks[].acceptanceCriteria[]", "public"],
    ["subtasks[].index", "public"],
    ["subtasks[].intent", "public"],
    ["subtasks[].estimatedTokens", "public"],
    ["subtasks[].behaviorIds", "public"],
    ["subtasks[].behaviorIds[]", "public"],
    ["rationale", "public"]
  ]),
  ...rulesFor("planner.failed", [["kind", "public"], ["message", "public"], ["reason", "public"]]),
  ...rulesFor("planner.subtasks.emitted", [
    ["runId", "public"],
    ["taskId", "public"],
    ["subtasks[].index", "public"],
    ["subtasks[].title", "public"],
    ["subtasks[].intent", "public"],
    ["subtasks[].estimatedTokens", "public"],
    ["subtasks[].behaviorIds", "public"],
    ["subtasks[].behaviorIds[]", "public"],
    ["rationale", "public"]
  ]),

  // writer role — note: tool-call args and decision code snippets are
  // redacted because they may reference credentials embedded in writer-led
  // edits.
  ...rulesFor("writer.started", [
    ["taskKind", "public"],
    ["intent", "public"],
    ["behaviorIds", "public"],
    ["behaviorIds[]", "public"]
  ]),
  ...rulesFor("writer.completed", [
    ["diff", "redacted"],
    ["commits[].sha", "public"],
    ["commits[].message", "public"],
    ["exitReason", "public"],
    ["tokenUsage.inputTokens", "public"],
    ["tokenUsage.outputTokens", "public"],
    ["tokenUsage.cachedTokens", "public"],
    ["telemetry.rawEventCount", "public"],
    ["telemetry.tokenUsage.inputTokens", "public"],
    ["telemetry.tokenUsage.outputTokens", "public"],
    ["telemetry.tokenUsage.cachedTokens", "public"],
    ["intent", "public"],
    ["decisions[].summary", "public"],
    ["decisions[].code", "redacted"],
    ["decisions[].rationale", "public"],
    ["toolCalls[].name", "public"],
    ["toolCalls[].args", "redacted"],
    ["toolCalls[].outputSummary", "public"],
    ["diffBytes", "public"],
    ["commitSha", "public"]
  ]),
  ...rulesFor("writer.failed", [["kind", "public"], ["message", "public"]]),
  ...rulesFor("writer.subtask.started", [
    ["runId", "public"],
    ["taskId", "public"],
    ["subtaskIndex", "public"],
    ["intent", "public"],
    ["behaviorIds", "public"],
    ["behaviorIds[]", "public"]
  ]),
  ...rulesFor("writer.subtask.completed", [
    ["runId", "public"],
    ["taskId", "public"],
    ["subtaskIndex", "public"],
    ["intent", "public"],
    ["decisions[].summary", "public"],
    ["decisions[].code", "redacted"],
    ["decisions[].rationale", "public"],
    ["toolCalls[].name", "public"],
    ["toolCalls[].args", "redacted"],
    ["toolCalls[].outputSummary", "public"],
    ["diffBytes", "public"],
    ["commitSha", "public"]
  ]),
  ...rulesFor("writer.subtask.failed", [
    ["runId", "public"],
    ["taskId", "public"],
    ["subtaskIndex", "public"],
    ["intent", "public"],
    ["failureKind", "public"],
    ["message", "public"]
  ]),

  // checker role
  ...rulesFor("checker.started", [["taskKind", "public"]]),
  ...rulesFor("checker.completed", [
    ["done", "public"],
    ["reason", "public"],
    ["suggested_fixes", "public"],
    ["suggested_fixes[]", "public"],
    ["passed", "public"],
    ["reasoning", "public"],
    ["behaviorIdsPassed", "public"],
    ["behaviorIdsPassed[]", "public"],
    ["behaviorIdsFailed", "public"],
    ["behaviorIdsFailed[]", "public"]
  ]),
  ...rulesFor("checker.failed", [["kind", "public"], ["message", "public"]]),
  ...rulesFor("checker.verdict", [
    ["runId", "public"],
    ["taskId", "public"],
    ["subtaskIndex", "public"],
    ["passed", "public"],
    ["reasoning", "public"],
    ["behaviorIdsPassed", "public"],
    ["behaviorIdsPassed[]", "public"],
    ["behaviorIdsFailed", "public"],
    ["behaviorIdsFailed[]", "public"]
  ]),

  // auditor role
  ...rulesFor("auditor.started", [["taskKind", "public"]]),
  ...rulesFor("auditor.completed", [
    ["verified", "public"],
    ["criteria_status.criteria[].criterion", "public"],
    ["criteria_status.criteria[].satisfied", "public"],
    ["criteria_status.criteria[].reason", "public"],
    ["reason", "public"],
    ["passed", "public"],
    ["reasoning", "public"],
    ["outstandingBehaviorIds", "public"],
    ["outstandingBehaviorIds[]", "public"],
    ["recommendedAction", "public"]
  ]),
  ...rulesFor("auditor.failed", [["kind", "public"], ["message", "public"]]),
  ...rulesFor("auditor.verdict", [
    ["runId", "public"],
    ["passed", "public"],
    ["reasoning", "public"],
    ["outstandingBehaviorIds", "public"],
    ["outstandingBehaviorIds[]", "public"],
    ["recommendedAction", "public"]
  ]),

  // runner allocation
  ...rulesFor("allocator.requested", [
    ["allocator", "public"],
    ["runnerImage", "public"],
    ["identitySecretRef", "redacted"]
  ]),
  ...rulesFor("allocator.allocated", [
    ["runnerId", "public"],
    ["imageSha", "public"],
    ["target.host", "redacted"],
    ["target.port", "redacted"],
    ["target.username", "public"],
    ["target.hostKeyFingerprint", "redacted"]
  ]),
  ...rulesFor("allocator.failed", [["message", "public"]]),
  ...rulesFor("runner.allocated", [
    ["runnerId", "public"],
    ["imageSha", "public"],
    ["target.host", "redacted"],
    ["target.port", "redacted"],
    ["target.username", "public"],
    ["target.hostKeyFingerprint", "redacted"]
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
    ["result.failure.message", "redacted"]
  ]),

  // workspace
  ...rulesFor("workspace.prepared", [
    ["runnerId", "public"],
    ["workspacePath", "public"],
    ["repoUrl", "public"],
    ["targetBranch", "public"]
  ]),
  ...rulesFor("workspace.git_captured", [
    ["workspacePath", "public"],
    ["commits[].sha", "public"],
    ["commits[].message", "public"],
    ["diffBytes", "public"]
  ]),
  ...rulesFor("workspace.failed", [
    ["runnerId", "public"],
    ["workspacePath", "public"],
    ["message", "public"]
  ]),

  // credentials — refs are redacted; raw value never appears in payloads
  ...rulesFor("credential.requested", [
    ["credentialKind", "public"],
    ["ref", "redacted"],
    ["redacted", "public"]
  ]),
  ...rulesFor("credential.loaded", [
    ["credentialKind", "public"],
    ["ref", "redacted"],
    ["redacted", "public"]
  ]),
  ...rulesFor("credential.failed", [["ref", "redacted"], ["message", "public"]]),

  // cost
  ...rulesFor("cost.resolved", [
    ["taskId", "public"],
    ["cli", "public"],
    ["provider", "public"],
    ["model", "public"],
    ["costUsd", "public"],
    ["pricingMode", "public"],
    ["costSource", "public"]
  ]),
  ...rulesFor("cost.failed", [["taskId", "public"], ["message", "public"]]),

  // github
  ...rulesFor("github.branch.pushed", [
    ["repoUrl", "public"],
    ["branch", "public"],
    ["credentialRef", "redacted"],
    ["redacted", "public"]
  ]),
  ...rulesFor("github.pr.created", [
    ["repoUrl", "public"],
    ["branch", "public"],
    ["targetBranch", "public"],
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["reused", "public"]
  ]),
  ...rulesFor("github.pr.ready", [["prUrl", "public"], ["prNumber", "public"]]),
  ...rulesFor("github.pr.merged", [
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["mergeSha", "public"]
  ]),
  ...rulesFor("github.failed", [["operation", "public"], ["branch", "public"], ["message", "public"]]),

  // ci.* (observation payloads share field shape)
  ...ciObservationRules("ci.started"),
  ...ciObservationRules("ci.passed"),
  ...ciObservationRules("ci.failed"),

  // phase 1 fixture orchestration
  ...rulesFor("phase1.fixture.started", [["repoUrl", "public"], ["targetBranch", "public"]]),
  ...rulesFor("phase1.fixture.ci_pending", [["attempt", "public"], ["nextPollAfterMs", "public"]]),
  ...rulesFor("phase1.fixture.completed", [["prUrl", "public"], ["ciStatus", "public"]]),
  ...rulesFor("phase1.fixture.failed", [["message", "public"]]),

  // reviews
  ...rulesFor("review.requested", [
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["reviewers", "public"],
    ["reviewers[]", "public"]
  ]),
  ...rulesFor("review.approved", [
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["reviewer", "public"]
  ]),
  ...rulesFor("review.changes_requested", [
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["reviewer", "public"],
    ["message", "public"]
  ]),

  // notifications
  ...rulesFor("notification.enqueued", [["channel", "public"], ["eventName", "public"]]),
  ...rulesFor("notification.sent", [["channel", "public"], ["attempts", "public"]]),
  ...rulesFor("notification.failed", [["channel", "public"], ["message", "public"]]),

  // hello run
  ...rulesFor("hello.started", []),
  ...rulesFor("hello.ssh_started", [
    ["runnerId", "public"],
    ["command", "redacted"],
    ["target.host", "redacted"],
    ["target.port", "redacted"],
    ["target.username", "public"],
    ["target.hostKeyFingerprint", "redacted"]
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
    ["timedOut", "public"]
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
    ["runnerProof.timedOut", "public"]
  ])
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
    ["pendingChecks[].url", "public"]
  ]);
}

let registered = false;

export function ensureSensitivityRulesRegistered(): void {
  if (registered) {
    return;
  }
  registerSensitivities(sensitivityRules);
  registered = true;
}

// Side-effect import: registers rules at module load. Importing the barrel
// guarantees rules are live before any decoder or registry consumer runs.
ensureSensitivityRulesRegistered();
