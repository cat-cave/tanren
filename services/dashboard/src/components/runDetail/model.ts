/**
 * Pure presentation helpers for the run-detail surface. These take
 * the contract-typed run-detail payload and derive the view-model
 * the TSX renders: the unified cost bar, the trajectory spine, and the
 * reasoning pane for a selected moment. No DOM, no JSX — kept pure so the unit
 * tests can assert the derivation without rendering.
 *
 * Every field read here is contract-typed (see `../../api/types.ts`). The API
 * ships data; this module composes presentation. No UI-specific shaping is
 * requested back into the API.
 */

import type { RunCostRecord, RunDetail, RunEventRow, TaskTimelineEntry } from "../../api/types.js";
import { summarizeCostRecords, type CostTotalsState } from "../../client/runCostModel.js";

export { formatMicros, formatTokens } from "../../client/runCostModel.js";

/** The token var for a billing mode's cost-source color. */
export function costSourceVar(mode: RunCostRecord["billingMode"]): string {
  switch (mode) {
    case "per_token":
      return "var(--cost-token)";
    case "subscription":
      return "var(--cost-window)";
    case "self_hosted":
      return "var(--cost-opportunity)";
    // BUDGET-SAFETY C1: an unrecognized credential ref (a misconfig) — surfaced
    // distinctly so the operator notices it, reusing the failure token.
    case "unattributed":
      return "var(--cost-unattributed, var(--status-fail))";
    default: {
      const exhaustive: never = mode;
      throw new Error(`costSourceVar: unhandled billing mode ${String(exhaustive)}`);
    }
  }
}

/** Human label for a billing mode. */
export function costSourceLabel(mode: RunCostRecord["billingMode"]): string {
  switch (mode) {
    case "per_token":
      return "per-token";
    case "subscription":
      return "window";
    case "self_hosted":
      return "self-hosted";
    case "unattributed":
      return "unattributed";
    default: {
      const exhaustive: never = mode;
      throw new Error(`costSourceLabel: unhandled billing mode ${String(exhaustive)}`);
    }
  }
}

/** SSR and live streaming consume the same exact aggregation authority. */
export function summarizeCosts(costs: RunCostRecord[]): CostTotalsState {
  return summarizeCostRecords(costs);
}

// ---------------------------------------------------------------------------
// Trajectory spine
// ---------------------------------------------------------------------------

/** A trajectory-spine row derived from a task. */
export interface TrajectoryMoment {
  taskId: string;
  kind: string;
  /** "plan" | "write subtask N" | "check" | "audit" | "ci" | "demo" | "forge". */
  phase: string;
  title: string;
  /** done | live | queued | failed — drives the dot + spine gradient. */
  state: "done" | "live" | "queued" | "failed";
  outcome: string | null;
  failureKind: string | null;
  attempt: number;
  cli: string;
  model: string | null;
  /** Formatted duration, or "" when not yet started. */
  duration: string;
  startedAt: string | null;
  endedAt: string | null;
}

/** Map a task status/outcome to a spine state. */
export function taskState(task: TaskTimelineEntry): TrajectoryMoment["state"] {
  if (task.status === "running" || task.status === "claimed") return "live";
  if (task.status === "queued") return "queued";
  if (
    task.status === "failed" ||
    task.outcome === "failed" ||
    task.outcome === "rejected_by_checker" ||
    task.outcome === "rejected_by_auditor" ||
    task.outcome === "crashed" ||
    task.outcome === "timed_out"
  ) {
    return "failed";
  }
  return "done";
}

/** Format the elapsed time between two ISO timestamps (or "" if unstarted). */
export function formatDuration(startedAt: string | null, endedAt: string | null): string {
  if (startedAt === null) return "";
  const start = Date.parse(startedAt);
  const end = endedAt === null ? Date.now() : Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "";
  const secs = Math.round((end - start) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return rem === 0 ? `${mins}m` : `${mins}m ${rem}s`;
}

/**
 * Build the ordered trajectory from the task timeline. Writer subtasks (child
 * write tasks) are numbered in arrival order; the spine orders by startedAt
 * (queued/unstarted tasks sort to the end in their declared order).
 */
export function buildTrajectory(tasks: TaskTimelineEntry[]): TrajectoryMoment[] {
  const sorted = [...tasks].sort((a, b) => {
    const sa = a.startedAt === null ? Number.POSITIVE_INFINITY : Date.parse(a.startedAt);
    const sb = b.startedAt === null ? Number.POSITIVE_INFINITY : Date.parse(b.startedAt);
    if (sa !== sb) return sa - sb;
    return 0;
  });
  let writeIndex = 0;
  return sorted.map((task) => {
    let phase: string = task.kind;
    if (task.kind === "write") {
      writeIndex += 1;
      phase = `write subtask ${writeIndex}`;
    }
    return {
      taskId: task.taskId,
      kind: task.kind,
      phase,
      title: task.title === "" ? phase : task.title,
      state: taskState(task),
      outcome: task.outcome,
      failureKind: task.failureKind,
      attempt: task.attempt,
      cli: task.cli,
      model: task.model,
      duration: formatDuration(task.startedAt, task.endedAt),
      startedAt: task.startedAt,
      endedAt: task.endedAt,
    } satisfies TrajectoryMoment;
  });
}

/** Spine gradient stops: done-% and live-% for the CSS linear-gradient. */
export function spineProgress(moments: TrajectoryMoment[]): { donePct: number; livePct: number } {
  const total = moments.length;
  if (total === 0) return { donePct: 0, livePct: 0 };
  const doneCount = moments.filter((m) => m.state === "done" || m.state === "failed").length;
  const liveIdx = moments.findIndex((m) => m.state === "live");
  const donePct = (doneCount / total) * 100;
  const livePct = liveIdx === -1 ? donePct : ((liveIdx + 1) / total) * 100;
  return { donePct, livePct };
}

// ---------------------------------------------------------------------------
// Reasoning pane: structured fields from typed semantic events
// ---------------------------------------------------------------------------

/** A structured tool invocation pulled from the event payload. */
export interface ToolInvocation {
  name: string;
  arg: string;
  output: string;
}

/** The reasoning view-model for a selected trajectory moment. */
export interface MomentReasoning {
  /** The writer-stated headline (intent summary), or the moment title. */
  headline: string;
  /** Free-text declared intent, when present in the events. */
  intent: string | null;
  /** Structured tool calls captured during the moment. */
  tools: ToolInvocation[];
  /** Structured decision bullets. */
  decisions: string[];
  /** Events bound to this moment's task (for the redaction-aware events list). */
  events: RunEventRow[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Derive the reasoning pane for a selected task from the run's event stream.
 * Reads structured fields out of the typed event payloads — never parses
 * stdout strings. Redacted fields are skipped (the payload arrives without
 * them; `redactedPaths` is surfaced separately in the events list).
 */
export function reasoningForTask(detail: RunDetail, taskId: string | null): MomentReasoning {
  const events = detail.recentEvents.filter((e) => e.taskId === taskId);
  const tools: ToolInvocation[] = [];
  const decisions: string[] = [];
  let intent: string | null = null;
  let headline: string | null = null;

  for (const event of events) {
    const payload = asRecord(event.payload);
    if (payload === undefined) continue;

    const eventIntent = asString(payload["intent"]) ?? asString(payload["summary"]);
    if (eventIntent !== undefined && intent === null) intent = eventIntent;

    const eventHeadline = asString(payload["headline"]) ?? asString(payload["title"]);
    if (eventHeadline !== undefined && headline === null) headline = eventHeadline;

    // Tool calls: a `tool`/`name` field plus arg/output summaries.
    const toolName = asString(payload["tool"]) ?? asString(payload["toolName"]);
    if (toolName !== undefined) {
      tools.push({
        name: toolName,
        arg: asString(payload["arg"]) ?? asString(payload["args"]) ?? "",
        output: asString(payload["output"]) ?? asString(payload["result"]) ?? "",
      });
    }

    // Decisions: either a single `decision` string or a `decisions` array.
    const decision = asString(payload["decision"]);
    if (decision !== undefined) decisions.push(decision);
    if (Array.isArray(payload["decisions"])) {
      for (const d of payload["decisions"]) {
        const ds = asString(d);
        if (ds !== undefined) decisions.push(ds);
      }
    }
  }

  const task = detail.tasks.find((t) => t.taskId === taskId);
  return {
    headline: headline ?? task?.title ?? "moment",
    intent,
    tools,
    decisions,
    events,
  };
}

// ---------------------------------------------------------------------------
// review / merge state (derived from the run's typed events)
// ---------------------------------------------------------------------------

/** The review/merge phase the operator surface reflects. */
export type ReviewMergePhase =
  | "none"
  | "review_requested"
  | "changes_requested"
  | "approved"
  | "merge_queued"
  | "merge_conflict"
  | "merge_failed"
  | "merged";

export interface ReviewMergeState {
  phase: ReviewMergePhase;
  /** Latest changes-requested / failure / conflict message, when present. */
  message?: string;
  /** Merge commit sha once merged. */
  mergeSha?: string;
  /** Dispatched merge integration recorded on a merge.* event. */
  integration?: string;
}

/**
 * Reduce the run's review.* / merge.* / github.pr.* events into the single
 * review/merge phase the review sub-surface renders. The latest matching event
 * wins (events arrive in order), so a re-reviewed PR reflects its final state.
 */
export function reviewMergeStateFromEvents(events: RunEventRow[]): ReviewMergeState {
  const state: ReviewMergeState = { phase: "none" };
  for (const event of events) {
    const payload = asRecord(event.payload) ?? {};
    const message = asString(payload["message"]);
    const integration = asString(payload["integration"]);
    switch (event.eventType) {
      case "github.pr.ready":
      case "review.requested":
        if (state.phase === "none") state.phase = "review_requested";
        break;
      case "review.changes_requested":
        state.phase = "changes_requested";
        state.message = message;
        break;
      case "review.approved":
        if (state.phase !== "merged") state.phase = "approved";
        break;
      case "merge.queued":
        state.phase = "merge_queued";
        state.integration = integration;
        break;
      case "merge.conflict":
        state.phase = "merge_conflict";
        state.message = message;
        state.integration = integration;
        break;
      case "merge.failed":
        state.phase = "merge_failed";
        state.message = message;
        state.integration = integration;
        break;
      case "merge.completed":
      case "github.pr.merged":
        state.phase = "merged";
        state.mergeSha = asString(payload["mergeSha"]);
        state.integration = integration ?? state.integration;
        break;
      default:
        break;
    }
  }
  return state;
}

// ---------------------------------------------------------------------------
// live preview-deploy URL (derived from per-project config + run state)
// ---------------------------------------------------------------------------

/** Pull the PR number out of a GitHub PR URL (`.../pull/142` → `142`), or null. */
export function prNumberFrom(prUrl: string | null): string | null {
  if (prUrl === null) return null;
  const match = /\/pull\/(\d+)/u.exec(prUrl);
  return match?.[1] ?? null;
}

/**
 * Derive a per-PR preview-deploy URL for the Review iframe from the project's
 * configured `previewUrlPattern` and the run's own state. We never fabricate a
 * URL: if no pattern is configured we return null (the Review surface then shows
 * its graceful empty state). Supported placeholders:
 *   - `{pr}`     the PR number parsed from `run.prUrl` (`.../pull/<n>`)
 *   - `{branch}` the run's branch
 * A pattern that needs `{pr}` but has no PR yet yields null (nothing to preview).
 */
export function derivePreviewUrl(
  previewUrlPattern: string | undefined,
  run: { branch: string; prUrl: string | null },
): string | null {
  if (previewUrlPattern === undefined || previewUrlPattern === "") return null;
  const pr = prNumberFrom(run.prUrl);
  if (previewUrlPattern.includes("{pr}") && pr === null) return null;
  const url = previewUrlPattern.replaceAll("{pr}", pr ?? "").replaceAll("{branch}", encodeURIComponent(run.branch));
  // Only surface an http(s) origin into an iframe `src` (no `javascript:` etc).
  return /^https?:\/\//iu.test(url) ? url : null;
}

/** Did the run fail / halt? Drives the failure-diagnostics banner. */
export function runFailed(detail: RunDetail): boolean {
  const status = detail.run.status;
  return status === "failed" || status === "halted" || status === "cancelled";
}

/** Tasks that failed, for the failure-diagnostics list. */
export function failedTasks(detail: RunDetail): TaskTimelineEntry[] {
  return detail.tasks.filter(
    (t) =>
      t.status === "failed" ||
      t.outcome === "rejected_by_checker" ||
      t.outcome === "rejected_by_auditor" ||
      t.outcome === "crashed" ||
      t.outcome === "timed_out",
  );
}
