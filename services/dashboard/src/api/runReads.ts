/**
 * Canonical strict wire decoders for run-list and run-detail HTTP reads.
 * Exact HTTP 200 + Zod decoding of the full envelope and every row field.
 * Malformed JSON/schema, non-200 (including other 2xx), and domain-binding
 * mismatches become typed unavailable — never an empty list, partial object,
 * or cast. Shared with org-costs so schemas cannot drift.
 */

import { z } from "zod";
import type { RunDetail, RunListItem } from "./types.js";

const DecimalString = z.string().regex(/^\d+(?:\.\d+)?$/u);
const WireDate = z.string().datetime({ offset: true });
const SafeId = z.union([z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), z.string().regex(/^\d+$/u)]);
const NonnegativeCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const RunStatus = z.enum(["queued", "running", "paused", "halted", "completed", "failed", "cancelled"]);
const RunOutcome = z
  .enum([
    "ok",
    "halted",
    "escape_hatch_hit",
    "retry_budget_exhausted",
    "convergence_stalled",
    "window_exhausted",
    "window_paused",
    "awaiting_review",
    "cancelled",
    "failed",
  ])
  .nullable();

export const RunListItemWire = z
  .object({
    runId: z.string().min(1),
    specId: z.string().min(1),
    projectId: z.string().min(1),
    branch: z.string().min(1),
    trigger: z.string().min(1),
    status: RunStatus,
    outcome: RunOutcome,
    startedAt: WireDate,
    endedAt: WireDate.nullable(),
    prUrl: z.string().nullable(),
    specTitle: z.string(),
    costTotalUsd: DecimalString.nullable(),
    lastEventAt: WireDate.nullable(),
    needsReview: z.boolean(),
  })
  .strict();

const CostRecordWire = z
  .object({
    id: SafeId,
    runId: z.string().min(1),
    taskId: z.string().min(1),
    projectId: z.string().min(1),
    cli: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    inputTokens: NonnegativeCount,
    cachedInputTokens: NonnegativeCount,
    cacheCreationTokens: NonnegativeCount,
    outputTokens: NonnegativeCount,
    reasoningOutputTokens: NonnegativeCount,
    totalTokens: NonnegativeCount,
    costUsd: DecimalString.nullable(),
    notionalCostUsd: DecimalString.nullable(),
    billingMode: z.enum(["per_token", "subscription", "self_hosted", "unattributed"]),
    costBasis: z.enum(["ccusage", "provider_response", "credits", "unknown", "unattributed"]),
    recordedAt: WireDate,
  })
  .strict()
  .superRefine((record, context) => {
    const bucketTotal =
      record.inputTokens +
      record.cachedInputTokens +
      record.cacheCreationTokens +
      record.outputTokens +
      record.reasoningOutputTokens;
    if (record.totalTokens !== bucketTotal) {
      context.addIssue({ code: "custom", path: ["totalTokens"], message: "token buckets do not sum to totalTokens" });
    }
    if ((record.costBasis === "unknown" || record.costBasis === "unattributed") && record.costUsd !== null) {
      context.addIssue({ code: "custom", path: ["costUsd"], message: "unpriced cost basis must carry null costUsd" });
    }
  });

const TaskStatus = z.enum(["queued", "claimed", "running", "done", "failed", "cancelled"]);
const TaskKind = z.enum([
  "plan",
  "write",
  "check",
  "audit",
  "ci",
  "review",
  "merge",
  "demo",
  "forge",
  "triage",
  "convergence",
  "designOracle",
]);
const TaskOutcome = z
  .enum([
    "passed",
    "ok",
    "pending",
    "failed",
    "rejected_by_checker",
    "rejected_by_auditor",
    "timed_out",
    "crashed",
    "window_exhausted",
    "cancelled",
  ])
  .nullable();

const TaskTimelineWire = z
  .object({
    taskId: z.string().min(1),
    runId: z.string().min(1),
    kind: TaskKind,
    parentTaskId: z.string().nullable(),
    title: z.string(),
    status: TaskStatus,
    outcome: TaskOutcome,
    failureKind: z.string().nullable(),
    attempt: z.number().int().nonnegative(),
    cli: z.string().min(1),
    model: z.string().nullable(),
    startedAt: WireDate.nullable(),
    endedAt: WireDate.nullable(),
  })
  .strict();

const RunEventWire = z
  .object({
    id: SafeId,
    ts: WireDate,
    runId: z.string().nullable(),
    taskId: z.string().nullable(),
    specId: z.string().nullable(),
    projectId: z.string().nullable(),
    eventType: z.string().min(1),
    payload: z.unknown(),
    redactedPaths: z.array(z.string()).default([]),
  })
  .strict();

const RunSummaryWire = z
  .object({
    runId: z.string().min(1),
    specId: z.string().min(1),
    projectId: z.string().min(1),
    branch: z.string().min(1),
    trigger: z.string().min(1),
    status: RunStatus,
    outcome: RunOutcome,
    startedAt: WireDate,
    endedAt: WireDate.nullable(),
    prUrl: z.string().nullable(),
  })
  .strict();

const RunSpecSummaryWire = z
  .object({
    specId: z.string().min(1),
    title: z.string(),
    description: z.string(),
    behaviorIds: z.array(z.string().min(1)),
    milestoneId: z.string().nullable(),
  })
  .strict();

const RunForgeBundleWire = z
  .object({
    threadId: z.string().min(1),
    recentTurns: z.array(z.unknown()),
  })
  .strict();

export const RunDetailWire = z
  .object({
    run: RunSummaryWire,
    spec: RunSpecSummaryWire,
    tasks: z.array(TaskTimelineWire),
    recentEvents: z.array(RunEventWire),
    costs: z.array(CostRecordWire),
    insights: z.array(z.unknown()),
    forgeThread: RunForgeBundleWire.nullable(),
  })
  .strict();

export const RunListPageWire = z
  .object({
    items: z.array(RunListItemWire),
  })
  .strict();

export type RunReadUnavailable = {
  kind: "unavailable";
  reason: "network" | "upstream" | "malformed";
  status?: number;
};

export type RunListReadResult = { kind: "ok"; items: RunListItem[] } | RunReadUnavailable;

export type RunDetailReadResult = { kind: "ok"; detail: RunDetail } | RunReadUnavailable;

export interface RunReadClientDeps {
  orchestratorUrl: string;
  headers: Record<string, string>;
  fetchImpl: typeof fetch;
}

async function exactJson200(
  deps: RunReadClientDeps,
  path: string,
): Promise<{ kind: "ok"; raw: unknown } | RunReadUnavailable> {
  let response: Response;
  try {
    response = await deps.fetchImpl(`${deps.orchestratorUrl}${path}`, { headers: deps.headers });
  } catch {
    return { kind: "unavailable", reason: "network" };
  }
  if (response.status !== 200) {
    return { kind: "unavailable", reason: "upstream", status: response.status };
  }
  try {
    return { kind: "ok", raw: await response.json() };
  } catch {
    return { kind: "unavailable", reason: "malformed" };
  }
}

/**
 * Strict project run list. Exact 200 + full-row Zod decode. Optional
 * expectedProjectId binds every row to the requested project.
 */
export async function readRunList(
  deps: RunReadClientDeps,
  orgId: string,
  projectId: string,
  query: { status?: string; specId?: string } = {},
): Promise<RunListReadResult> {
  const params = new URLSearchParams();
  if (query.status !== undefined && query.status !== "") params.set("status", query.status);
  if (query.specId !== undefined && query.specId !== "") params.set("specId", query.specId);
  const qs = params.toString();
  const path = `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/runs${qs ? `?${qs}` : ""}`;
  const fetched = await exactJson200(deps, path);
  if (fetched.kind !== "ok") return fetched;
  const decoded = RunListPageWire.safeParse(fetched.raw);
  if (!decoded.success) return { kind: "unavailable", reason: "malformed" };
  for (const item of decoded.data.items) {
    if (item.projectId !== projectId) {
      return { kind: "unavailable", reason: "malformed" };
    }
    if (query.specId !== undefined && query.specId !== "" && item.specId !== query.specId) {
      return { kind: "unavailable", reason: "malformed" };
    }
  }
  return { kind: "ok", items: decoded.data.items as RunListItem[] };
}

/**
 * Strict run-detail snapshot. Exact 200 + full envelope decode. Binds
 * run.projectId / run.runId / cost.runId / cost.projectId to the request.
 */
export async function readRunDetail(
  deps: RunReadClientDeps,
  loc: { orgId: string; projectId: string },
  runId: string,
  opts: { rawView?: boolean; extraHeaders?: Record<string, string> } = {},
): Promise<RunDetailReadResult> {
  const query = opts.rawView === true ? "?raw=true" : "";
  const path = `/orgs/${encodeURIComponent(loc.orgId)}/projects/${encodeURIComponent(loc.projectId)}/runs/${encodeURIComponent(runId)}${query}`;
  const headers = opts.extraHeaders === undefined ? deps.headers : { ...deps.headers, ...opts.extraHeaders };
  const fetched = await exactJson200({ ...deps, headers }, path);
  if (fetched.kind !== "ok") return fetched;
  const decoded = RunDetailWire.safeParse(fetched.raw);
  if (!decoded.success) return { kind: "unavailable", reason: "malformed" };
  const detail = decoded.data;
  if (detail.run.runId !== runId || detail.run.projectId !== loc.projectId) {
    return { kind: "unavailable", reason: "malformed" };
  }
  if (detail.spec.specId !== detail.run.specId) {
    return { kind: "unavailable", reason: "malformed" };
  }
  for (const cost of detail.costs) {
    if (cost.runId !== runId || cost.projectId !== loc.projectId) {
      return { kind: "unavailable", reason: "malformed" };
    }
  }
  for (const task of detail.tasks) {
    if (task.runId !== runId) return { kind: "unavailable", reason: "malformed" };
  }
  return { kind: "ok", detail: detail as unknown as RunDetail };
}
