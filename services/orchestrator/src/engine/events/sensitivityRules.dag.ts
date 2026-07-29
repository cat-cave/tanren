import type { SensitivityRule } from "./sensitivity.js";

export const dagSensitivityRules: SensitivityRule[] = [
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
  ...rulesFor("dag.config.corrupt", [
    ["knob", "public"],
    ["appliedDefault.threshold", "public"],
    ["appliedDefault.depthCap", "public"],
    ["reason", "public"],
  ]),
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
  ...rulesFor("dag.spec.ancestor_not_ready", [
    ["specId", "public"],
    ["runId", "public"],
    ["ancestorSpecId", "public"],
    ["ancestorPhase", "public"],
  ]),
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
];

function rulesFor(eventName: string, entries: ReadonlyArray<[string, SensitivityRule["tag"]]>): SensitivityRule[] {
  return entries.map(([path, tag]) => ({ eventName, path, tag }));
}
