/**
 * Spec-detail model (P3-0013) — shapes the spec drawer + full page from the
 * orchestrator primitives (spec + its dependency edges + run history). Pure +
 * I/O-free so the route handler stays thin and the derivation is testable.
 */

import type { DagStatus } from "../../api/projectDag.js";
import type { RunListItem, SpecSummary } from "../../api/types.js";

export interface SpecRunRow {
  runId: string;
  outcome: string;
  status: string;
  when: string;
  costUsd: string;
  href: string | null;
  live: boolean;
}

export interface SpecDepChip {
  specId: string;
  title: string;
  status: DagStatus;
}

export interface SpecDetail {
  specId: string;
  projectId: string;
  title: string;
  description: string;
  status: DagStatus;
  /** Human status label ("merged"/"forging"/"review-ready"/"blocked"/"queued"). */
  statusLabel: string;
  pill: "ok" | "run" | "warn" | "fail" | "cold";
  glyph: string;
  acceptance: string[];
  dependsOn: SpecDepChip[];
  blocks: SpecDepChip[];
  runs: SpecRunRow[];
  latestRun: SpecRunRow | null;
  /** A short "why blocked" line when the spec is blocked, else null. */
  blockedReason: string | null;
  spendUsd: string;
  /** Primary action route per status, or null (queued/blocked handled inline). */
  primaryAction: { label: string; href: string } | null;
}

const STATUS_META: Record<DagStatus, { label: string; pill: SpecDetail["pill"]; glyph: string }> = {
  done: { label: "merged", pill: "ok", glyph: "✓" },
  live: { label: "forging", pill: "run", glyph: "↻" },
  review: { label: "review-ready", pill: "warn", glyph: "!" },
  blocked: { label: "blocked", pill: "fail", glyph: "⏳" },
  queued: { label: "queued", pill: "cold", glyph: "○" }
};

const HALTED = new Set(["halted", "escape_hatch_hit", "retry_budget_exhausted"]);

function statusForSpec(specStatus: string, latest: RunListItem | undefined): DagStatus {
  if (latest !== undefined) {
    if (latest.needsReview) return "review";
    if (latest.status === "running") return "live";
    if (latest.outcome !== null && HALTED.has(latest.outcome)) return "blocked";
    if (latest.status === "completed" || latest.status === "succeeded") return "done";
    if (latest.status === "queued") return "queued";
  }
  const s = specStatus.toLowerCase();
  if (s === "merged" || s === "done") return "done";
  if (s === "in_flight" || s === "running" || s === "active") return "live";
  if (s === "review") return "review";
  if (s === "blocked" || s === "halted") return "blocked";
  return "queued";
}

function runHref(projectId: string, runId: string): string {
  return `/projects/${projectId}/runs/${runId}`;
}

function toRunRow(projectId: string, run: RunListItem): SpecRunRow {
  const live = run.status === "running" || run.needsReview;
  return {
    runId: run.runId,
    outcome: run.outcome ?? run.status,
    status: run.status,
    when: run.lastEventAt ?? run.startedAt,
    costUsd: run.costTotalUsd,
    href: runHref(projectId, run.runId),
    live
  };
}

export interface BuildSpecDetailInput {
  spec: SpecSummary;
  /** All specs in the project (for dep-chip titles + "blocks" reverse edges). */
  allSpecs: SpecSummary[];
  /** Runs for THIS spec, newest first. */
  runs: RunListItem[];
  /** Latest run per dep spec id → status (for dep-chip colours). */
  statusBySpecId: Map<string, DagStatus>;
}

function depChip(specId: string, allSpecs: SpecSummary[], statusBySpecId: Map<string, DagStatus>): SpecDepChip {
  const found = allSpecs.find((s) => s.specId === specId);
  return {
    specId,
    title: found?.title ?? specId,
    status: statusBySpecId.get(specId) ?? "queued"
  };
}

export function buildSpecDetail(input: BuildSpecDetailInput): SpecDetail {
  const { spec, allSpecs, runs } = input;
  const latest = runs[0];
  const status = statusForSpec(spec.status, latest);
  const meta = STATUS_META[status];
  const projectId = spec.projectId;

  const dependsOn = spec.dependsOn.map((id) => depChip(id, allSpecs, input.statusBySpecId));
  const blocks = allSpecs
    .filter((s) => s.dependsOn.includes(spec.specId))
    .map((s) => depChip(s.specId, allSpecs, input.statusBySpecId));

  const runRows = runs.map((run) => toRunRow(projectId, run));
  const latestRun = runRows[0] ?? null;
  const spend = runs.reduce((acc, run) => acc + (Number(run.costTotalUsd) || 0), 0);

  const blockedDeps = dependsOn.filter((d) => d.status !== "done");
  const blockedReason =
    status === "blocked"
      ? blockedDeps.length > 0
        ? `Waiting on ${blockedDeps.map((d) => d.title).join(", ")} — ${blockedDeps.length} upstream dep(s) not yet merged.`
        : "This spec's latest run halted. Open the run to see why."
      : null;

  let primaryAction: SpecDetail["primaryAction"] = null;
  if (status === "review" && latestRun !== null) {
    primaryAction = { label: "open review ↗", href: `/runs/${latestRun.runId}/review` };
  } else if (status === "live" && latestRun !== null) {
    primaryAction = { label: "open live run ↗", href: runHref(projectId, latestRun.runId) };
  } else if (status === "done" && latestRun !== null) {
    primaryAction = { label: "view merged run ↗", href: runHref(projectId, latestRun.runId) };
  } else if (status === "queued") {
    primaryAction = { label: "forge it now ↗", href: `/projects/${projectId}/specs/new` };
  }

  return {
    specId: spec.specId,
    projectId,
    title: spec.title,
    description: spec.description,
    status,
    statusLabel: meta.label,
    pill: meta.pill,
    glyph: meta.glyph,
    acceptance: spec.acceptanceCriteria,
    dependsOn,
    blocks,
    runs: runRows,
    latestRun,
    blockedReason,
    spendUsd: `$${spend.toFixed(2)}`,
    primaryAction
  };
}
