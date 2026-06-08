import { registerSensitivities, type SensitivityRule } from "./sensitivity.js";
import { infraSensitivityRules } from "./sensitivityRules.infra.js";
import { appEnvSensitivityRules } from "./sensitivityRules.appEnv.js";
import { strandSensitivityRules } from "./sensitivityRules.strand.js";
import { ciIntelSensitivityRules } from "./sensitivityRules.ciIntel.js";
import { gateSensitivityRules } from "./sensitivityRules.gate.js";
import { auditorFindingsRoutedSensitivityRules } from "./sensitivityRules.audit.js";
import { specLoopStageSensitivityRules } from "./sensitivityRules.loop.js";

// Sensitivity rule table. Every payload field reachable from an event must have a
// registered tag (the eventRegistryFieldCoverage test enforces this as a hard CI
// failure). Tag taxonomy: `public` = any project member; `redacted` = project:admin
// to view raw; `secret` = platform:admin to view raw. Heuristics: identifiers
// (runIds/taskIds/sha/paths) + human-authored prose are public; host fingerprints /
// credential refs / SSH host:port are redacted; secrets / raw tokens / command
// stdout/stderr are secret. A "[]" path suffix applies to every array element.

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
    ["spec.dependsOn[]", "public"],
  ]),

  // run.started / run.completed / run.failed
  ...rulesFor("run.started", [["status", "public"]]),
  ...rulesFor("run.completed", [
    ["status", "public"],
    ["outcome", "public"],
  ]),
  // `message` stays "public": for a bootstrap failure it is `messageOf(error)` ===
  // `WorkspaceBootstrapError.message`, which (post) carries the ORIGINAL
  // prelude-free command — the Plane-B app-env prelude is injected only at the SSH
  // substrate boundary, never into the command string the error message embeds. So
  // an app-secret VALUE cannot reach this payload. "public" remains correct.
  ...rulesFor("run.failed", [
    ["status", "public"],
    ["message", "public"],
  ]),

  // task lifecycle
  ...rulesFor("task.queued", [
    ["taskKind", "public"],
    ["jobId", "public"],
  ]),
  ...rulesFor("task.started", [
    ["taskKind", "public"],
    ["jobId", "public"],
  ]),
  ...rulesFor("task.completed", [
    ["taskKind", "public"],
    ["jobId", "public"],
    ["status", "public"],
    ["reason", "public"],
  ]),
  ...rulesFor("task.failed", [
    ["taskKind", "public"],
    ["jobId", "public"],
    ["kind", "public"],
    ["failureKind", "public"],
    ["message", "public"],
    ["status", "public"],
    ["reason", "public"],
  ]),

  // dead-letter event — identifiers + a failure summary, all public.
  ...rulesFor("job.dead_lettered", [
    ["jobId", "public"],
    ["taskKind", "public"],
    ["attempts", "public"],
    ["maxAttempts", "public"],
    ["failureKind", "public"],
    ["message", "public"],
  ]),

  // planner role
  ...rulesFor("planner.started", [
    ["taskKind", "public"],
    ["intent", "public"],
    ["rationale", "public"],
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
    ["rationale", "public"],
  ]),
  ...rulesFor("planner.failed", [
    ["kind", "public"],
    ["message", "public"],
    ["reason", "public"],
  ]),
  ...rulesFor("planner.subtasks.emitted", [
    ["runId", "public"],
    ["taskId", "public"],
    ["subtasks[].index", "public"],
    ["subtasks[].title", "public"],
    ["subtasks[].intent", "public"],
    ["subtasks[].estimatedTokens", "public"],
    ["subtasks[].behaviorIds", "public"],
    ["subtasks[].behaviorIds[]", "public"],
    ["rationale", "public"],
  ]),

  // writer role — note: tool-call args and decision code snippets are
  // redacted because they may reference credentials embedded in writer-led
  // edits.
  ...rulesFor("writer.started", [
    ["taskKind", "public"],
    ["intent", "public"],
    ["behaviorIds", "public"],
    ["behaviorIds[]", "public"],
  ]),
  ...rulesFor("writer.completed", [
    ["diff", "redacted"],
    ["commits[].sha", "public"],
    ["commits[].message", "public"],
    ["exitReason", "public"],
    ["tokenUsage.inputTokens", "public"],
    ["tokenUsage.cachedInputTokens", "public"],
    ["tokenUsage.cacheCreationTokens", "public"],
    ["tokenUsage.outputTokens", "public"],
    ["tokenUsage.reasoningOutputTokens", "public"],
    ["tokenUsage.totalTokens", "public"],
    ["telemetry.rawEventCount", "public"],
    ["telemetry.tokenUsage.inputTokens", "public"],
    ["telemetry.tokenUsage.cachedInputTokens", "public"],
    ["telemetry.tokenUsage.cacheCreationTokens", "public"],
    ["telemetry.tokenUsage.outputTokens", "public"],
    ["telemetry.tokenUsage.reasoningOutputTokens", "public"],
    ["telemetry.tokenUsage.totalTokens", "public"],
    // Provider usage-limit notice (names the reset time); no secret material.
    ["telemetry.usageLimit.message", "public"],
    ["intent", "public"],
    ["decisions[].summary", "public"],
    ["decisions[].code", "redacted"],
    ["decisions[].rationale", "public"],
    ["toolCalls[].name", "public"],
    ["toolCalls[].args", "redacted"],
    ["toolCalls[].outputSummary", "public"],
    ["diffBytes", "public"],
    ["commitSha", "public"],
  ]),
  ...rulesFor("writer.failed", [
    ["kind", "public"],
    ["message", "public"],
  ]),
  ...rulesFor("writer.subtask.started", [
    ["runId", "public"],
    ["taskId", "public"],
    ["subtaskIndex", "public"],
    ["intent", "public"],
    ["behaviorIds", "public"],
    ["behaviorIds[]", "public"],
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
    ["commitSha", "public"],
  ]),
  ...rulesFor("writer.subtask.failed", [
    ["runId", "public"],
    ["taskId", "public"],
    ["subtaskIndex", "public"],
    ["intent", "public"],
    ["failureKind", "public"],
    ["message", "public"],
  ]),

  // planner rejection-loop event
  ...rulesFor("planner.rerequested", [
    ["runId", "public"],
    ["plannerTaskId", "public"],
    ["producer", "public"],
    ["rejectionReason", "public"],
    ["behaviorIdsFailed", "public"],
    ["behaviorIdsFailed[]", "public"],
    ["plannerRerunCount", "public"],
    ["maxPlannerRerunsPerSpec", "public"],
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
    ["behaviorIdsFailed[]", "public"],
  ]),
  ...rulesFor("checker.failed", [
    ["kind", "public"],
    ["message", "public"],
  ]),
  // checker.verdict (completeness-findings) + auditor.verdict (findings-only) live in
  // the spec-loop split (./sensitivityRules.loop.ts) under the 500-line cap.
  // rejection event emitted by the checker rejection-loop branch
  ...rulesFor("checker.rejected", [
    ["runId", "public"],
    ["taskId", "public"],
    ["subtaskIndex", "public"],
    ["reason", "public"],
    ["behaviorIdsFailed", "public"],
    ["behaviorIdsFailed[]", "public"],
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
    ["recommendedAction", "public"],
  ]),
  ...rulesFor("auditor.failed", [
    ["kind", "public"],
    ["message", "public"],
  ]),
  // auditor.verdict (findings-only) lives in the spec-loop split. rejection event:
  ...rulesFor("auditor.rejected", [
    ["runId", "public"],
    ["auditTaskId", "public"],
    ["reason", "public"],
    ["outstandingBehaviorIds", "public"],
    ["outstandingBehaviorIds[]", "public"],
    ["recommendedAction", "public"],
  ]),
  // S3: the posture-gate's residual P2/P3 disposition (route-to-dag / fix-if-idle) —
  // all public; spread from ./sensitivityRules.audit.ts under the 500-line cap.
  ...auditorFindingsRoutedSensitivityRules,

  // SPEC-LOOP REDESIGN stages (demo-run / triage / convergence) — all public; spread
  // from ./sensitivityRules.loop.ts under the 500-line cap.
  ...specLoopStageSensitivityRules,

  // The native in-loop gate rules (gate.started/passed/failed/advisory_failed/verdict)
  // are split into ./sensitivityRules.gate.js under the 500-line cap; spread below.

  // recovery lineage — operator-authored prose + identifiers, public.
  ...rulesFor("recovery.revise_routed", [
    ["runId", "public"],
    ["specId", "public"],
    ["action", "public"],
    ["editHref", "public"],
  ]),
  ...rulesFor("recovery.replan_queued", [
    ["runId", "public"],
    ["specId", "public"],
    ["action", "public"],
    ["steeringNote", "public"],
    ["replanRunId", "public"],
    ["plannerTaskId", "public"],
  ]),
  ...rulesFor("recovery.rollback_queued", [
    ["runId", "public"],
    ["specId", "public"],
    ["action", "public"],
    ["commitSha", "public"],
    ["confirmed", "public"],
    ["replanRunId", "public"],
  ]),
  ...rulesFor("recovery.inspection_opened", [
    ["runId", "public"],
    ["specId", "public"],
    ["action", "public"],
    ["threadId", "public"],
  ]),

  // Tanren-method benchmark accept tier (§2.1). Cell/trial/tier identifiers +
  // the content-addressed accept-tier hash + exit codes are public; the captured
  // command output tails carry stdout/stderr, which the taxonomy treats as
  // secret (may surface env values or paths), exactly as the gate.* steps do.
  ...rulesFor("benchmark.accept.passed", [
    ["cellId", "public"],
    ["trialIndex", "public"],
    ["tier", "public"],
    ["acceptTierHash", "public"],
    ["steps[].name", "public"],
    ["steps[].run", "public"],
    ["steps[].exitCode", "public"],
    ["steps[].passed", "public"],
    ["steps[].timedOut", "public"],
    ["steps[].outputTail", "secret"],
  ]),
  ...rulesFor("benchmark.accept.failed", [
    ["cellId", "public"],
    ["trialIndex", "public"],
    ["tier", "public"],
    ["acceptTierHash", "public"],
    ["failedStep", "public"],
    ["exitCode", "public"],
    ["reason", "public"],
    ["steps[].name", "public"],
    ["steps[].run", "public"],
    ["steps[].exitCode", "public"],
    ["steps[].passed", "public"],
    ["steps[].timedOut", "public"],
    ["steps[].outputTail", "secret"],
  ]),

  // DagWalker (autonomy-engine.md §1a) scheduling events. Every field is a spec/run
  // id or a non-sensitive count (in-flight / ceiling / breakdown) — all public.
  ...rulesFor("dag.spec.enqueued", [
    ["specId", "public"],
    ["runId", "public"],
    ["satisfiedDependsOn[]", "public"],
    ["inFlightBefore", "public"],
    ["concurrencyCeiling", "public"],
  ]),
  ...rulesFor("dag.drained", [
    ["doneCount", "public"],
    ["inFlightCount", "public"],
    ["blockedCount", "public"],
  ]),
  ...rulesFor("dag.budget.paused", [
    ["ceilingUsd", "public"],
    ["spentUsd", "public"],
    ["period", "public"],
    ["readyHeldBack", "public"],
    ["reason", "public"],
  ]),
  ...rulesFor("dag.concurrency.saturated", [
    ["readyHeldBack", "public"],
    ["inFlightCount", "public"],
    ["concurrencyCeiling", "public"],
  ]),
  // (§2c) speculative-execution events — spec/run ids, ancestor ids, the
  // threshold label, the integration branch ref, and non-sensitive counts.
  ...rulesFor("dag.spec.speculative", [
    ["specId", "public"],
    ["runId", "public"],
    ["unmergedAncestors[]", "public"],
    ["threshold", "public"],
    ["integrationBranch", "public"],
  ]),
  ...rulesFor("dag.spec.speculation_held", [
    ["specId", "public"],
    ["unmergedAncestors[]", "public"],
    ["depth", "public"],
    ["depthCap", "public"],
  ]),
  // (§2c) change-percolation events — spec/run/ancestor ids, ancestor head
  // SHAs (public: a commit hash is not a secret), the severity label, the resolver
  // flag, and the irreconcilable diagnosis reason. None carry diff content,
  // credentials, or command output.
  ...rulesFor("dag.spec.percolating", [
    ["specId", "public"],
    ["runId", "public"],
    ["ancestorSpecId", "public"],
    ["fromAncestorSha", "public"],
    ["toAncestorSha", "public"],
    ["severity", "public"],
  ]),
  ...rulesFor("dag.spec.percolated", [
    ["specId", "public"],
    ["runId", "public"],
    ["ancestorSpecId", "public"],
    ["integratedAncestorSha", "public"],
    ["viaResolver", "public"],
  ]),
  ...rulesFor("dag.spec.percolation_deferred", [
    ["specId", "public"],
    ["runId", "public"],
    ["ancestorSpecId", "public"],
    ["pendingAncestorSha", "public"],
    ["severity", "public"],
  ]),
  ...rulesFor("dag.spec.percolation_replan", [
    ["specId", "public"],
    ["runId", "public"],
    ["ancestorSpecId", "public"],
    ["ancestorSha", "public"],
    ["reason", "public"],
  ]),
  // §3/§7 NEVER-DISCARD REBASE (integration.rebase) — spec/run/branch ids, the shifted
  // base + branch-head SHAs (public: commit hashes are not secrets), the same-run-id
  // never-discard flag, the rebase-conflicted flag, and the rebase_vs_rebuild decision
  // label. No diff content, credentials, or command output.
  ...rulesFor("integration.rebase", [
    ["specId", "public"],
    ["runId", "public"],
    ["sameRunId", "public"],
    ["branch", "public"],
    ["newBaseSha", "public"],
    ["headSha", "public"],
    ["rebaseConflicted", "public"],
    ["decision", "public"],
  ]),
  // §3 PROOF REUSE (integration.proof.reused) — node ids + content/config hashes + the
  // verdict label; all public (hashes are not secrets).
  ...rulesFor("integration.proof.reused", [
    ["nodeId", "public"],
    ["recordedOnNodeId", "public"],
    ["memberKey", "public"],
    ["proofReuseKey", "public"],
    ["verdict", "public"],
  ]),
  // Post-merge auto-issue creation (tempering.md dim A) — PR/merge identity + the
  // failing post-merge checks + the auto-filed issue's number/url/label, all public
  // (the regression + its tracking issue are visible run lineage, no secrets).
  ...rulesFor("merge.post_merge_failed", [
    ["prUrl", "public"],
    ["prNumber", "public"],
    ["specId", "public"],
    ["baseBranch", "public"],
    ["mergeSha", "public"],
    ["failingChecks[].kind", "public"],
    ["failingChecks[].name", "public"],
    ["failingChecks[].state", "public"],
    ["failingChecks[].url", "public"],
  ]),
  ...rulesFor("issue.opened", [
    ["reason", "public"],
    ["issueNumber", "public"],
    ["issueUrl", "public"],
    ["prUrl", "public"],
    ["label", "public"],
  ]),
  // Split out under the 500-line cap: app_env.* (appEnv); infra/integration —
  // runner/allocator/workspace/credential, cost+usage, github/ci/phase1/reviews/
  // notifications/hello/redaction (infra); strand reconciler (strand); ci-intel
  // (ciIntel); native in-loop gate (gate).
  ...appEnvSensitivityRules,
  ...infraSensitivityRules,
  ...strandSensitivityRules,
  ...ciIntelSensitivityRules,
  ...gateSensitivityRules,
];

function rulesFor(eventName: string, entries: ReadonlyArray<[string, SensitivityRule["tag"]]>): SensitivityRule[] {
  return entries.map(([path, tag]) => ({ eventName, path, tag }));
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
