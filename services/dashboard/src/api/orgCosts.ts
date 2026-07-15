/**
 * Fail-closed client for the bounded org-cost read model. A successful empty
 * ledger is distinct from every transport, auth, schema, pagination, or domain
 * failure; partial pages are discarded unless the walk reaches exhaustion.
 */

import { z } from "zod";
import type { CostRecord, RunListItem } from "./types.js";

const DecimalString = z.string().regex(/^\d+(?:\.\d+)?$/u);
const WireDate = z.string().datetime({ offset: true });
const SafeId = z.union([z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), z.string().regex(/^\d+$/u)]);
const NonnegativeCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const CostRecordSchema = z
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

const RunListItemSchema = z
  .object({
    runId: z.string().min(1),
    specId: z.string().min(1),
    projectId: z.string().min(1),
    branch: z.string().min(1),
    trigger: z.string().min(1),
    status: z.enum(["queued", "running", "paused", "halted", "completed", "failed", "cancelled"]),
    outcome: z
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
      .nullable(),
    startedAt: WireDate,
    endedAt: WireDate.nullable(),
    prUrl: z.string().nullable(),
    specTitle: z.string(),
    costTotalUsd: DecimalString.nullable(),
    lastEventAt: WireDate.nullable(),
    needsReview: z.boolean(),
  })
  .strict();

const OrgCostsPageSchema = z
  .object({
    orgId: z.string().min(1),
    costs: z.array(CostRecordSchema),
    runs: z.array(RunListItemSchema),
    nextCursor: z.string().min(1).nullable(),
  })
  .strict();

export interface OrgCostsData {
  orgId: string;
  costs: CostRecord[];
  runs: RunListItem[];
}

export type GetOrgCostsResult =
  | { kind: "ok"; data: OrgCostsData }
  | { kind: "auth"; status: 401 | 403 }
  | { kind: "unavailable"; reason: "network" | "upstream" | "malformed"; status?: number };

export interface OrgCostsClientDeps {
  orchestratorUrl: string;
  headers: Record<string, string>;
  fetchImpl: typeof fetch;
}

export async function getOrgCosts(deps: OrgCostsClientDeps, orgId: string): Promise<GetOrgCostsResult> {
  const costs: CostRecord[] = [];
  const runs: RunListItem[] = [];
  const costIds = new Set<string>();
  const runIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  for (;;) {
    const params = new URLSearchParams({ pageSize: "200" });
    if (cursor !== null) params.set("cursor", cursor);
    const url = `${deps.orchestratorUrl}/orgs/${encodeURIComponent(orgId)}/costs?${params.toString()}`;
    let response: Response;
    try {
      response = await deps.fetchImpl(url, { headers: deps.headers });
    } catch {
      return { kind: "unavailable", reason: "network" };
    }
    if (response.status === 401 || response.status === 403) {
      return { kind: "auth", status: response.status };
    }
    if (response.status !== 200) {
      return { kind: "unavailable", reason: "upstream", status: response.status };
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      return { kind: "unavailable", reason: "malformed" };
    }
    const decoded = OrgCostsPageSchema.safeParse(raw);
    if (!decoded.success || decoded.data.orgId !== orgId) {
      return { kind: "unavailable", reason: "malformed" };
    }
    const page = decoded.data;
    for (const cost of page.costs) {
      const id = String(cost.id);
      if (costIds.has(id)) return { kind: "unavailable", reason: "malformed" };
      costIds.add(id);
      costs.push(cost);
    }
    for (const run of page.runs) {
      if (runIds.has(run.runId)) return { kind: "unavailable", reason: "malformed" };
      runIds.add(run.runId);
      runs.push(run);
    }

    if (page.nextCursor === null) break;
    if (page.costs.length === 0 && page.runs.length === 0) {
      return { kind: "unavailable", reason: "malformed" };
    }
    if (seenCursors.has(page.nextCursor)) {
      return { kind: "unavailable", reason: "malformed" };
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }

  const runProjects = new Map(runs.map((run) => [run.runId, run.projectId]));
  for (const cost of costs) {
    if (runProjects.get(cost.runId) !== cost.projectId) {
      return { kind: "unavailable", reason: "malformed" };
    }
  }
  if (!costsAreOrdered(costs) || !runsAreOrdered(runs)) {
    return { kind: "unavailable", reason: "malformed" };
  }
  return { kind: "ok", data: { orgId, costs, runs } };
}

function costsAreOrdered(costs: readonly CostRecord[]): boolean {
  for (let index = 1; index < costs.length; index += 1) {
    const previous = costs[index - 1]!;
    const current = costs[index]!;
    const timeDelta = Date.parse(current.recordedAt) - Date.parse(previous.recordedAt);
    if (timeDelta < 0 || (timeDelta === 0 && BigInt(String(current.id)) <= BigInt(String(previous.id)))) {
      return false;
    }
  }
  return true;
}

function runsAreOrdered(runs: readonly RunListItem[]): boolean {
  for (let index = 1; index < runs.length; index += 1) {
    const previous = runs[index - 1]!;
    const current = runs[index]!;
    const timeDelta = Date.parse(current.startedAt) - Date.parse(previous.startedAt);
    if (timeDelta > 0 || (timeDelta === 0 && current.runId <= previous.runId)) {
      return false;
    }
  }
  return true;
}
