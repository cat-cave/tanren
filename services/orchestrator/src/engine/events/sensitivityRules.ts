import { registerSensitivities, type SensitivityRule } from "./sensitivity.js";
import { infraSensitivityRules } from "./sensitivityRules.infra.js";
import { usageAccountingFailedSensitivityRules } from "./sensitivityRules.usage.js";
import { appEnvSensitivityRules } from "./sensitivityRules.appEnv.js";
import { strandSensitivityRules } from "./sensitivityRules.strand.js";
import { ciIntelSensitivityRules } from "./sensitivityRules.ciIntel.js";
import { gateSensitivityRules } from "./sensitivityRules.gate.js";
import {
  auditPostureStrandsFindingsSensitivityRules,
  auditorFindingsRoutedSensitivityRules,
} from "./sensitivityRules.audit.js";
import { specLoopStageSensitivityRules } from "./sensitivityRules.loop.js";
import { templatesSensitivityRules } from "./sensitivityRules.templates.js";
import { windowPauseSensitivityRules } from "./sensitivityRules.windowPause.js";
import {
  benchmarkSensitivityRules,
  designSystemSensitivityRules,
  eventVocabularyW0SensitivityRules,
  governanceVocabularySensitivityRules,
  wave1SensitivityRules,
  wave3VocabularySensitivityRules,
  wave4VocabularySensitivityRules,
  wave5And6AndResolutionClusterVocabularySensitivityRules,
} from "./sensitivityRules.eventVocabularyW0.js";

// Sensitivity rule table. Every payload field reachable from an event must have a registered tag (the eventRegistryFieldCoverage test enforces this as a hard CI failure). Tag taxonomy: `public` = any project member; `redacted` = project:admin to view raw; `secret` = platform:admin to view raw. Heuristics: identifiers (runIds/taskIds/sha/paths) + human-authored prose are public; host fingerprints / credential refs / SSH host:port are redacted; secrets / raw tokens / command stdout/stderr are secret. A "[]" path suffix applies to every array element.

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
  // run.failed is PUBLIC, and the worker-level catch wraps a WHOLE run, so the raw caught error (URLs / refs / command fragments / secret-adjacent text) is NEVER put here: the worker classifies it into a closed-vocab `failureCode` + `stage` + a FIXED safe `message` summary (worker/runFailureClassifier); the raw detail goes to the INTERNAL job_queue.failure_message + a redacted log. All three are safe.
  ...rulesFor("run.failed", [
    ["status", "public"],
    ["failureCode", "public"],
    ["stage", "public"],
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

  // lease-expiry infra signal — identifiers + the re-claim diagnostic, all public.
  ...rulesFor("job.lease_expired", [
    ["jobId", "public"],
    ["taskKind", "public"],
    ["attempts", "public"],
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

  // writer role — note: tool-call args and decision code snippets are redacted because they may reference credentials embedded in writer-led edits.
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
  // task #24 (apex v52/v53) cross-layer sign-of-life bridge — all fields non-secret observability.
  ...rulesFor("writer.subtask.progress", [
    ["runId", "public"],
    ["taskId", "public"],
    ["subtaskIndex", "public"],
    ["intent", "public"],
    ["outputBytesAdvanced", "public"],
    ["workspaceSignature", "public"],
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
  // checker.verdict + auditor.verdict (findings-only) live in the spec-loop split.
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
  // S3 posture-gate residual disposition + Loop 3 strand-findings record — all public; spread
  // from ./sensitivityRules.audit.ts under the 500-line cap.
  ...auditorFindingsRoutedSensitivityRules,
  ...auditPostureStrandsFindingsSensitivityRules,

  // SPEC-LOOP REDESIGN stages (demo-run / triage / convergence) — all public; spread from loop split.
  ...specLoopStageSensitivityRules,

  // The native in-loop gate rules are split into ./sensitivityRules.gate.js; spread below.

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

  // Tanren-method benchmark accept tier (§2.1), extracted for line-cap headroom.
  ...benchmarkSensitivityRules,

  // DagWalker (autonomy-engine.md §1a) scheduling events — spec/run ids + non-sensitive counts, public.
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
  // The budget FRACTION milestone (50% / 80%): band + ceiling/spend figures + period, all public.
  ...rulesFor("dag.budget.milestone", [
    ["band", "public"],
    ["ceilingUsd", "public"],
    ["spentUsd", "public"],
    ["period", "public"],
  ]),
  ...rulesFor("dag.concurrency.saturated", [
    ["readyHeldBack", "public"],
    ["inFlightCount", "public"],
    ["concurrencyCeiling", "public"],
  ]),
  // (no_silent_fallbacks) the corrupt-config surface — knob label + applied default + reason, public.
  ...rulesFor("dag.config.corrupt", [
    ["knob", "public"],
    ["appliedDefault.threshold", "public"],
    ["appliedDefault.depthCap", "public"],
    ["reason", "public"],
  ]),
  // (§2c) speculative-execution events — spec/run/ancestor ids + threshold label + counts, public.
  ...rulesFor("dag.spec.speculative", [
    ["specId", "public"],
    ["runId", "public"],
    ["unmergedAncestors[]", "public"],
    ["threshold", "public"],
  ]),
  ...rulesFor("dag.spec.speculation_held", [
    ["specId", "public"],
    ["unmergedAncestors[]", "public"],
    ["depth", "public"],
    ["depthCap", "public"],
  ]),
  // (§3) benign-wait for a not-yet-ready ancestor — spec/run/ancestor ids + phase label, public.
  ...rulesFor("dag.spec.ancestor_not_ready", [
    ["specId", "public"],
    ["runId", "public"],
    ["ancestorSpecId", "public"],
    ["ancestorPhase", "public"],
  ]),
  // (§2c) change-percolation events — spec/run/ancestor ids, ancestor head SHAs (a commit hash
  // is not a secret), severity label, resolver flag, diagnosis reason. No diff/cred/output.
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
  // Tanren-native templating (wave 1): registry lifecycle events — non-secret (public).
  ...templatesSensitivityRules,
  // task #82 window-pause auto-resume (run.paused/resumed/window.refreshed) + Codex critic #18 (usage.accounting_failed).
  ...windowPauseSensitivityRules,
  ...usageAccountingFailedSensitivityRules,
  // Mission-complete W0 event vocabulary; every frozen payload path is public.
  ...eventVocabularyW0SensitivityRules,
  // Mission-complete WAVE-1 vocab freeze (in-3 integration + rv-25 runtime); every
  // frozen payload path is public.
  ...wave1SensitivityRules,
  // Mission-complete WAVE-2 governance policy-revision freeze (gv-7); every frozen
  // payload path is public.
  ...governanceVocabularySensitivityRules,
  // Mission-complete ds-0 DESIGN-SYSTEM vocab freeze; every frozen payload path is public.
  ...designSystemSensitivityRules,
  // Mission-complete WAVE-3 symptom-contract + merge-partition freeze (bh-4/mq-4).
  ...wave3VocabularySensitivityRules,
  // Mission-complete WAVE-4 shared vocabulary freeze (bh-5/bh-7/mq-5/gv-8).
  ...wave4VocabularySensitivityRules,
  // Mission-complete WAVE-5/WAVE-6 + back-half cluster shared vocabulary freezes.
  ...wave5And6AndResolutionClusterVocabularySensitivityRules,
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

// Side-effect import: registers rules at module load. Importing the barrel guarantees rules are live before any decoder or registry consumer runs.
ensureSensitivityRulesRegistered();
