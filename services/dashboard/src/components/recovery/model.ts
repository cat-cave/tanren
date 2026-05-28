/**
 * P2B-0008 recovery view-model. Derives the four failure-context cells and the
 * templated recovery-chat narration from the contract-typed RunDetail
 * (P2A-0014) + RecoveryContext (orchestrator recovery route). All v0 narration
 * is templated from event payloads — thick Forge LLM responses are Phase 3.
 */

import type { RunDetail, RunEventRow, TaskTimelineEntry } from "../../api/types.js";

export interface FailureContext {
  /** What blocked it — structured reason from the planner-feedback loop. */
  blockedReason: string;
  blockedDetail: string;
  /** Last good commit SHA (null when none → rollback disabled). */
  lastGoodCommit: string | null;
  lastGoodAgo: string;
  lastGoodDetail: string;
  /** Elapsed at hatch + retries + dollars + which hatch fired. */
  elapsed: string;
  retries: number;
  dollarsBurned: string;
  hatchLabel: string;
}

function relativeAgo(iso: string | null): string {
  if (iso === null) return "—";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function formatElapsed(startIso: string, endIso: string | null): string {
  const start = Date.parse(startIso);
  const end = endIso === null ? Date.now() : Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "—";
  const secs = Math.max(0, Math.round((end - start) / 1000));
  const mins = Math.floor(secs / 60);
  return `${mins}m ${secs % 60}s`;
}

/** Sum the run's recorded dollars (null-cost rows contribute nothing). */
function sumDollars(detail: RunDetail): string {
  const total = detail.costs.reduce((sum, c) => sum + (c.costUsd === null ? 0 : Number(c.costUsd)), 0);
  return `$${total.toFixed(2)}`;
}

/** Human label for the escape hatch / outcome that fired. */
export function hatchLabel(outcome: string | null): string {
  switch (outcome) {
    case "retry_budget_exhausted":
      return "retry budget exhausted";
    case "escape_hatch_hit":
      return "escape hatch fired";
    case "window_exhausted":
      return "subscription window exhausted";
    case "halted":
      return "run halted";
    default:
      return outcome ?? "halted";
  }
}

/**
 * Pull the most recent auditor/checker rejection from the event history to
 * describe what blocked the run. Falls back to a generic reason.
 */
/** Last element matching a predicate, without mutating or reversing the input. */
function findLast<T>(items: T[], predicate: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item !== undefined && predicate(item)) return item;
  }
  return undefined;
}

function rejectionReason(events: RunEventRow[]): { reason: string; detail: string } {
  // Prefer a concrete auditor/checker rejection (it names the disagreement);
  // only fall back to planner.rerequested when no verdict event is present.
  const rejection =
    findLast(
      events,
      (e) =>
        e.eventType === "auditor.rejected" ||
        e.eventType === "auditor.verdict" ||
        e.eventType === "checker.rejected"
    ) ?? findLast(events, (e) => e.eventType === "planner.rerequested");
  const payload = (rejection?.payload ?? {}) as Record<string, unknown>;
  const reasonText = typeof payload.reason === "string" ? payload.reason
    : typeof payload.rejectionReason === "string" ? payload.rejectionReason
    : undefined;
  const rerunCount = typeof payload.plannerRerunCount === "number" ? payload.plannerRerunCount : undefined;
  if (rejection?.eventType.startsWith("auditor")) {
    return {
      reason: `auditor disagrees with writer${rerunCount !== undefined ? ` · ${rerunCount}×` : ""}`,
      detail: reasonText ?? "writer says behavior demonstrates · auditor disagrees"
    };
  }
  if (rejection?.eventType.startsWith("checker")) {
    return { reason: "checker rejected the writer's change", detail: reasonText ?? "the checker found the change does not satisfy the criterion" };
  }
  return { reason: "the loop hit its escape hatch", detail: reasonText ?? "the planner-feedback loop exhausted its retry budget" };
}

/** The latest captured-commit event detail line. */
function lastCommitDetail(tasks: TaskTimelineEntry[]): string {
  const lastDone = findLast(tasks, (t) => t.kind === "write" && t.status === "done");
  return lastDone === undefined ? "before the failing subtask" : `after ${lastDone.title}`;
}

export function buildFailureContext(
  detail: RunDetail,
  lastGoodCommit: string | null
): FailureContext {
  const { reason, detail: blockedDetail } = rejectionReason(detail.recentEvents);
  const retries = detail.tasks.reduce((sum, t) => sum + t.attempt, 0);
  const gitEvent = findLast(detail.recentEvents, (e) => e.eventType === "workspace.git_captured");
  return {
    blockedReason: reason,
    blockedDetail,
    lastGoodCommit,
    lastGoodAgo: relativeAgo(gitEvent?.ts ?? detail.run.startedAt),
    lastGoodDetail: lastCommitDetail(detail.tasks),
    elapsed: formatElapsed(detail.run.startedAt, detail.run.endedAt),
    retries,
    dollarsBurned: sumDollars(detail),
    hatchLabel: hatchLabel(detail.run.outcome)
  };
}

/** Downstream-blocked specs (flat list in Phase 2; full DAG is Phase 3). */
export interface DownstreamImpact {
  blockedSpecs: string[];
  haltedSpecTitle: string;
}

/**
 * Specs that depend (transitively, one hop in v0) on this run's spec. Derived
 * from the spec list's `dependsOn` edges. Returns titles so the flat list
 * renders human labels.
 */
export function buildDownstreamImpact(
  detail: RunDetail,
  specs: Array<{ specId: string; title: string; dependsOn: string[] }>
): DownstreamImpact {
  const haltedSpecId = detail.run.specId;
  const blocked = specs.filter((s) => s.dependsOn.includes(haltedSpecId)).map((s) => s.title);
  return {
    blockedSpecs: blocked,
    haltedSpecTitle: detail.spec.title
  };
}
