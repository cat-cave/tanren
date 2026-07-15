/**
 * Pure data-shaping for the chat-primary project view. Takes the raw
 * orchestrator reads (runs, insights, milestones, feed, narration) and derives
 * the view models the components render: KPI numbers, the ranked attention
 * queue, the DAG snapshot nodes, the velocity ETA, and the activity rows.
 *
 * Kept free of JSX + I/O so it is unit-testable and so the route handler stays
 * a thin orchestration layer. No fabricated data: empty success yields empty
 * queues; failed reads stay typed-unavailable rather than silent zeros.
 */

import { RECOVERABLE_OUTCOMES } from "@tanren/db";
import type { KpiItem } from "./shared.js";
import type { ForgeAnswer, InsightSummary, MilestoneSummary, ProjectFeedItem, RunListItem } from "../../api/types.js";

const OPEN_RUN_STATUSES = new Set(["queued", "running"]);

export interface AttentionEntry {
  id: string;
  priority: string;
  title: string;
  sub: string;
  /** In-shell route to navigate to, or null for a no-op (a later surface). */
  href: string | null;
  tone: "hot" | "warn" | "";
}

export interface DagNode {
  /** Milestone label this node belongs under. */
  milestone: string;
  title: string;
  status: "done" | "live" | "review" | "blocked" | "queued";
  /** In-shell route on click, or null (queued/blocked → no-op). */
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

/** Per-source availability for project page reads (true = success, even if empty). */
export interface ProjectReadAvailability {
  runs: boolean;
  insights: boolean;
  milestones: boolean;
  feed: boolean;
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
  availability: ProjectReadAvailability;
  /** True when activity feed read failed (distinct from genuinely empty). */
  activityUnavailable: boolean;
  /** True when run list failed (KPIs that need runs show unavailable markers). */
  runsUnavailable: boolean;
  /** True when attention queue cannot be built because runs read failed. */
  attentionUnavailable: boolean;
}

export interface BuildProjectViewInput {
  projectId: string;
  projectName: string;
  /** undefined = read unavailable (not empty success). */
  runs: RunListItem[] | undefined;
  insights: InsightSummary[] | undefined;
  milestones: MilestoneSummary[] | undefined;
  feed: ProjectFeedItem[] | undefined;
  narration: ForgeAnswer | undefined;
  /** undefined when runs are unavailable — never fabricate $0 from a failed read. */
  weekSpendUsd: number | undefined;
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

/** Sum the run-list cost column (string-encoded numeric per). */
export function sumRunCosts(runs: RunListItem[]): number {
  return runs.reduce((acc, run) => acc + (Number(run.costTotalUsd) || 0), 0);
}

function buildAttention(projectId: string, runs: RunListItem[]): AttentionEntry[] {
  const entries: AttentionEntry[] = [];
  for (const run of runs) {
    if (run.needsReview) {
      entries.push({
        id: `review-${run.runId}`,
        priority: "review",
        title: `${run.specTitle} is review-ready`,
        sub: run.prUrl === null ? `run ${run.runId}` : prHandle(run.prUrl),
        href: runHref(projectId, run.runId),
        tone: "hot",
      });
    }
  }
  for (const run of runs) {
    if (OPEN_RUN_STATUSES.has(run.status) && !run.needsReview) {
      entries.push({
        id: `open-${run.runId}`,
        priority: run.status === "running" ? "in flight" : "queued",
        title: `${run.specTitle} is ${run.status}`,
        sub: `run ${run.runId}`,
        href: runHref(projectId, run.runId),
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

function buildDagNodes(projectId: string, runs: RunListItem[], milestones: MilestoneSummary[]): DagNode[] {
  const milestoneFor = (index: number): string => {
    const milestone = milestones[index % Math.max(1, milestones.length)];
    return milestone?.label ?? "—";
  };
  return runs.slice(0, 12).map((run, index) => {
    const status = dagStatusForRun(run);
    return {
      milestone: milestones.length > 0 ? milestoneFor(index) : "—",
      title: run.specTitle,
      status,
      href: status === "live" || status === "done" || status === "review" ? runHref(projectId, run.runId) : null,
    };
  });
}

function dagStatusForRun(run: RunListItem): DagNode["status"] {
  if (run.needsReview) return "review";
  if (run.status === "running") return "live";
  if (run.status === "queued") return "queued";
  if (run.outcome !== null && RECOVERABLE_OUTCOMES.has(run.outcome)) {
    return "blocked";
  }
  if (run.status === "completed") return "done";
  return "queued";
}

function buildVelocity(runs: RunListItem[], milestones: MilestoneSummary[], now: Date): VelocityModel | null {
  if (milestones.length === 0) return null;
  const target =
    milestones.find((m) => m.status !== "done" && m.eta !== null) ??
    milestones.find((m) => m.eta !== null) ??
    milestones[0];
  if (target === undefined) return null;
  const completed = runs.filter((run) => dagStatusForRun(run) === "done").length;
  const spark = buildSparkline(completed, runs.length);
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
    trendLabel: `${completed} merged · ${runs.length} runs`,
  };
}

function buildSparkline(completed: number, total: number): number[] {
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

function buildActivity(projectId: string, feed: ProjectFeedItem[]): ActivityRow[] {
  return feed.slice(0, 12).map((item) => ({
    ts: item.ts,
    kind: activityKind(item.eventType),
    event: humanizeEvent(item.eventType),
    detail: item.specId === null ? `run ${item.runId}` : `spec ${item.specId}`,
    href: runHref(projectId, item.runId),
  }));
}

function humanizeEvent(eventType: string): string {
  return eventType.replaceAll(/[._]/gu, " ");
}

function unavailableKpi(k: string): KpiItem {
  return { k, v: "—", unavailable: true };
}

export function buildProjectViewModel(input: BuildProjectViewInput): ProjectViewModel {
  const runsOk = input.runs !== undefined;
  const insightsOk = input.insights !== undefined;
  const milestonesOk = input.milestones !== undefined;
  const feedOk = input.feed !== undefined;
  const runs = input.runs ?? [];
  const insights = input.insights ?? [];
  const milestones = input.milestones ?? [];
  const feed = input.feed ?? [];
  const availability: ProjectReadAvailability = {
    runs: runsOk,
    insights: insightsOk,
    milestones: milestonesOk,
    feed: feedOk,
  };

  const inFlight = runs.filter((run) => OPEN_RUN_STATUSES.has(run.status)).length;
  const needsYou = (runsOk ? runs.filter((run) => run.needsReview).length : 0) + (insightsOk ? insights.length : 0);
  const blocked = runs.filter((run) => dagStatusForRun(run) === "blocked").length;
  const velocity = runsOk && milestonesOk ? buildVelocity(runs, milestones, input.now ?? new Date()) : null;

  const kpis: KpiItem[] = [
    runsOk
      ? { k: "in-flight runs", v: String(inFlight), tone: inFlight > 0 ? "hot" : undefined }
      : unavailableKpi("in-flight runs"),
    runsOk && insightsOk
      ? { k: "needs you", v: String(needsYou), tone: needsYou > 0 ? "warn" : undefined }
      : unavailableKpi("needs you"),
    runsOk && input.weekSpendUsd !== undefined
      ? {
          k: "week spend",
          v:
            input.weekCapUsd === undefined
              ? formatUsd(input.weekSpendUsd)
              : `${formatUsd(input.weekSpendUsd)} / ${formatUsd(input.weekCapUsd)}`,
        }
      : unavailableKpi("week spend"),
    milestonesOk && runsOk ? { k: "velocity", v: velocity?.trendLabel ?? "—" } : unavailableKpi("velocity"),
    runsOk ? { k: "blocked", v: String(blocked), tone: blocked > 0 ? "warn" : undefined } : unavailableKpi("blocked"),
  ];

  const pulseHeadline =
    input.narration?.body ??
    defaultPulse(
      input.projectName,
      runsOk ? inFlight : undefined,
      runsOk && insightsOk ? needsYou : undefined,
      input.weekSpendUsd,
    );
  const recentEvent = feedOk ? feed[0] : undefined;
  const pulseSub = feedOk
    ? recentEvent === undefined
      ? "no recent activity"
      : `most recent · ${humanizeEvent(recentEvent.eventType)}`
    : "activity unavailable";

  return {
    pulseHeadline,
    pulseSub,
    liveLabel: feedOk ? `forge live · ${feed.length} events` : "activity unavailable",
    kpis,
    attention: runsOk ? buildAttention(input.projectId, runs) : [],
    dagNodes: runsOk ? buildDagNodes(input.projectId, runs, milestones) : [],
    velocity,
    activity: feedOk ? buildActivity(input.projectId, feed) : [],
    prompts: input.narration?.prompts ?? [
      "What's the next spec I should run?",
      "How is this week's spend distributed?",
    ],
    availability,
    activityUnavailable: !feedOk,
    runsUnavailable: !runsOk,
    attentionUnavailable: !runsOk,
  };
}

function defaultPulse(
  name: string,
  inFlight: number | undefined,
  needsYou: number | undefined,
  spend: number | undefined,
): string {
  if (inFlight === undefined || needsYou === undefined || spend === undefined) {
    return `${name}: some project metrics are unavailable.`;
  }
  const parts: string[] = [];
  if (inFlight > 0) parts.push(`${inFlight} run(s) in flight`);
  if (needsYou > 0) parts.push(`${needsYou} item(s) need you`);
  const lead = parts.length > 0 ? `${name}: ${parts.join(", ")}` : `${name} is idle`;
  return `${lead}; ${formatUsd(spend)} spent this week.`;
}
