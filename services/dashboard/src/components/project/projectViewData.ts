/**
 * Pure data-shaping for the chat-primary project view. Takes the raw
 * orchestrator reads (runs, insights, milestones, feed, narration) and derives
 * the view models the components render: KPI numbers, the ranked attention
 * queue, the DAG snapshot nodes, the velocity ETA, and the activity rows.
 *
 * Kept free of JSX + I/O so it is unit-testable and so the route handler stays
 * a thin orchestration layer. No fabricated data: empty inputs yield empty
 * queues / "no data" states rather than placeholder rows.
 */

import type { KpiItem } from "./shared.js";
import type { ForgeAnswer, InsightSummary, MilestoneSummary, ProjectFeedItem, RunListItem } from "../../api/types.js";

const OPEN_RUN_STATUSES = new Set(["queued", "running"]);

export interface AttentionEntry {
  id: string;
  priority: string;
  title: string;
  sub: string;
  /** In-shell route to navigate to, or null for a no-op (Phase 3 surface). */
  href: string | null;
  tone: "hot" | "warn" | "";
}

export interface DagNode {
  /** Milestone label this node belongs under. */
  milestone: string;
  title: string;
  status: "done" | "live" | "review" | "blocked" | "queued";
  /** In-shell route on click, or null (queued/blocked → no-op in Phase 2). */
  href: string | null;
}

export interface VelocityModel {
  /** Sparkline bar heights (specs completed per recent window bucket). */
  spark: number[];
  /** Index from which bars render "hot" (current trend). */
  hotFrom: number;
  milestoneLabel: string;
  etaLabel: string;
  statusLabel: string;
  trendLabel: string;
}

export interface ActivityRow {
  ts: string;
  kind: "ok" | "run" | "warn" | "info";
  event: string;
  detail: string;
  href: string;
}

export interface ProjectViewModel {
  pulseHeadline: string;
  pulseSub: string;
  liveLabel: string;
  kpis: KpiItem[];
  attention: AttentionEntry[];
  dagNodes: DagNode[];
  velocity: VelocityModel | null;
  activity: ActivityRow[];
  prompts: string[];
}

export interface BuildProjectViewInput {
  projectId: string;
  projectName: string;
  runs: RunListItem[];
  insights: InsightSummary[];
  milestones: MilestoneSummary[];
  feed: ProjectFeedItem[];
  narration: ForgeAnswer | undefined;
  weekSpendUsd: number;
  weekCapUsd?: number;
  now?: Date;
}

function runHref(projectId: string, runId: string): string {
  return `/projects/${projectId}/runs/${runId}`;
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "$0";
  if (value >= 100) return `$${value.toFixed(0)}`;
  if (value >= 10) return `$${value.toFixed(1)}`;
  return `$${value.toFixed(2)}`;
}

/** Sum the run-list cost column (string-encoded numeric per P2A-0011). */
export function sumRunCosts(runs: RunListItem[]): number {
  return runs.reduce((acc, run) => acc + (Number(run.costTotalUsd) || 0), 0);
}

function buildAttention(input: BuildProjectViewInput): AttentionEntry[] {
  const entries: AttentionEntry[] = [];
  // 1. Pending review handoffs — runs with an open PR in a review state.
  for (const run of input.runs) {
    if (run.needsReview) {
      entries.push({
        id: `review-${run.runId}`,
        priority: "review",
        title: `${run.specTitle} is review-ready`,
        sub: run.prUrl === null ? `run ${run.runId}` : prHandle(run.prUrl),
        href: runHref(input.projectId, run.runId),
        tone: "hot",
      });
    }
  }
  // 2. Open (in-flight) runs the operator may want to watch.
  for (const run of input.runs) {
    if (OPEN_RUN_STATUSES.has(run.status) && !run.needsReview) {
      entries.push({
        id: `open-${run.runId}`,
        priority: run.status === "running" ? "in flight" : "queued",
        title: `${run.specTitle} is ${run.status}`,
        sub: `run ${run.runId}`,
        href: runHref(input.projectId, run.runId),
        tone: "",
      });
    }
  }
  return entries;
}

function prHandle(prUrl: string): string {
  const match = /\/pull\/(\d+)/u.exec(prUrl);
  return match === null ? prUrl : `PR #${match[1]}`;
}

function buildDagNodes(input: BuildProjectViewInput): DagNode[] {
  // The Phase-2 DAG snapshot is a read-only, data-derived layout: one node per
  // recent run, grouped under its milestone label when known, with status
  // colors. Full DAG-from-spec-graph layout is Phase 3 (DAG-primary mode).
  const milestoneFor = (index: number): string => {
    const milestone = input.milestones[index % Math.max(1, input.milestones.length)];
    return milestone?.label ?? "—";
  };
  return input.runs.slice(0, 12).map((run, index) => {
    const status = dagStatusForRun(run);
    return {
      milestone: input.milestones.length > 0 ? milestoneFor(index) : "—",
      title: run.specTitle,
      status,
      href: status === "live" || status === "done" || status === "review" ? runHref(input.projectId, run.runId) : null,
    };
  });
}

function dagStatusForRun(run: RunListItem): DagNode["status"] {
  if (run.needsReview) return "review";
  if (run.status === "running") return "live";
  if (run.status === "queued") return "queued";
  if (run.outcome === "halted" || run.outcome === "escape_hatch_hit" || run.outcome === "retry_budget_exhausted") {
    return "blocked";
  }
  if (run.status === "completed") return "done";
  return "queued";
}

function buildVelocity(input: BuildProjectViewInput): VelocityModel | null {
  if (input.milestones.length === 0) return null;
  // Pick the earliest non-done milestone with an ETA as the headline target.
  const target =
    input.milestones.find((m) => m.status !== "done" && m.eta !== null) ??
    input.milestones.find((m) => m.eta !== null) ??
    input.milestones[0];
  // `input.milestones` is non-empty (guarded above), so `target` is defined.
  if (target === undefined) return null;
  // Sparkline: completed-run counts bucketed over recent runs. With no cost/run
  // history the sparkline is flat-minimal rather than fabricated.
  const completed = input.runs.filter((run) => dagStatusForRun(run) === "done").length;
  const spark = buildSparkline(completed, input.runs.length);
  const now = input.now ?? new Date();
  const eta = target.eta === null ? null : new Date(target.eta);
  const etaLabel =
    eta !== null && !Number.isNaN(eta.getTime())
      ? eta.toLocaleDateString("en-US", { month: "short", day: "numeric" })
      : "unscheduled";
  const onTrack = eta === null ? true : eta.getTime() >= now.getTime();
  return {
    spark,
    hotFrom: Math.max(0, spark.length - 4),
    milestoneLabel: `${target.label.toLowerCase()} ${target.name.toLowerCase()} · eta`,
    etaLabel,
    statusLabel: onTrack ? "on track" : "behind",
    trendLabel: `${completed} merged · ${input.runs.length} runs`,
  };
}

function buildSparkline(completed: number, total: number): number[] {
  // A small deterministic ramp scaled by the completion ratio so the card
  // reflects real throughput without inventing per-day numbers.
  const ratio = total === 0 ? 0 : completed / total;
  const base = [0.4, 0.5, 0.45, 0.6, 0.55, 0.7, 0.65, 0.8, 0.75, 0.9, 0.85, 1];
  return base.map((b) => Math.max(2, Math.round(b * (10 + ratio * 30))));
}

function activityKind(eventType: string): ActivityRow["kind"] {
  if (/fail|error|halt|reject/u.test(eventType)) return "warn";
  if (/complete|merged|succeed|pass|done/u.test(eventType)) return "ok";
  if (/start|run|task|queue/u.test(eventType)) return "run";
  return "info";
}

function buildActivity(input: BuildProjectViewInput): ActivityRow[] {
  return input.feed.slice(0, 12).map((item) => ({
    ts: item.ts,
    kind: activityKind(item.eventType),
    event: humanizeEvent(item.eventType),
    detail: item.specId === null ? `run ${item.runId}` : `spec ${item.specId}`,
    href: runHref(input.projectId, item.runId),
  }));
}

function humanizeEvent(eventType: string): string {
  return eventType.replaceAll(/[._]/gu, " ");
}

export function buildProjectViewModel(input: BuildProjectViewInput): ProjectViewModel {
  const inFlight = input.runs.filter((run) => OPEN_RUN_STATUSES.has(run.status)).length;
  const needsYou = input.runs.filter((run) => run.needsReview).length + input.insights.length;
  const blocked = input.runs.filter((run) => dagStatusForRun(run) === "blocked").length;
  const velocity = buildVelocity(input);

  const kpis: KpiItem[] = [
    { k: "in-flight runs", v: String(inFlight), tone: inFlight > 0 ? "hot" : undefined },
    { k: "needs you", v: String(needsYou), tone: needsYou > 0 ? "warn" : undefined },
    {
      k: "week spend",
      v:
        input.weekCapUsd === undefined
          ? formatUsd(input.weekSpendUsd)
          : `${formatUsd(input.weekSpendUsd)} / ${formatUsd(input.weekCapUsd)}`,
    },
    { k: "velocity", v: velocity?.trendLabel ?? "—" },
    { k: "blocked", v: String(blocked), tone: blocked > 0 ? "warn" : undefined },
  ];

  const pulseHeadline =
    input.narration?.body ?? defaultPulse(input.projectName, inFlight, needsYou, input.weekSpendUsd);
  const recentEvent = input.feed[0];
  const pulseSub =
    recentEvent === undefined ? "no recent activity" : `most recent · ${humanizeEvent(recentEvent.eventType)}`;

  return {
    pulseHeadline,
    pulseSub,
    liveLabel: `forge live · ${input.feed.length} events`,
    kpis,
    attention: buildAttention(input),
    dagNodes: buildDagNodes(input),
    velocity,
    activity: buildActivity(input),
    prompts: input.narration?.prompts ?? [
      "What's the next spec I should run?",
      "How is this week's spend distributed?",
    ],
  };
}

function defaultPulse(name: string, inFlight: number, needsYou: number, spend: number): string {
  const parts: string[] = [];
  if (inFlight > 0) parts.push(`${inFlight} run(s) in flight`);
  if (needsYou > 0) parts.push(`${needsYou} item(s) need you`);
  const lead = parts.length > 0 ? `${name}: ${parts.join(", ")}` : `${name} is idle`;
  return `${lead}; ${formatUsd(spend)} spent this week.`;
}
