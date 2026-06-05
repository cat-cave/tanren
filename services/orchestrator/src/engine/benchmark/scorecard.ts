// TrialScorecard projection (docs/roadmap/tanren-method-benchmark.md §2.3). A
// pure reducer (`projectTrialScorecard`) that projects ONE `runs` row plus its
// `events` / `tasks` / `cost_records` into the per-trial scorecard, and a thin
// DB loader (`loadTrialScorecard`) that pulls those rows. Almost everything is
// a projection of already-persisted data (§2.2 "collection is solved"); only
// `reachedAcceptGreen` (the post-merge hidden-accept step, a follow-up) is an
// input here rather than something we derive.

import type pg from "pg";
import { z } from "zod";
import { deriveDoraMetrics } from "../insights/dora/compute.js";

// ---- Scorecard shape (§2.3) ----------------------------------------------

export const TrialTokens = z
  .object({
    input: z.number().int().nonnegative(),
    cachedInput: z.number().int().nonnegative(),
    cacheCreation: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    reasoning: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  })
  .strict();
export type TrialTokens = z.infer<typeof TrialTokens>;

// Count of cost_records per `cost_basis` (§2.2): the attribution sources. A mix
// skewed to `unknown` means costUsd is low-confidence — the aggregate reads this
// to decide whether to trust the dollar figure. `unattributed` (BUDGET-SAFETY C1)
// is a DISTINCT bucket: an unrecognized credential ref (a misconfig) that should
// have priced but could not — NOT folded into honest `unknown`, so a budget-
// defeating misconfig is visible in the scorecard.
export const CostBasisMix = z
  .object({
    // The provider's OWN authoritative per-call charge (OpenRouter's `usage.cost`):
    // the most accurate real-spend basis. A DISTINCT bucket so high-confidence real
    // spend is not folded into the honest `unknown` bucket.
    provider_response: z.number().int().nonnegative(),
    ccusage: z.number().int().nonnegative(),
    credits: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
    unattributed: z.number().int().nonnegative(),
  })
  .strict();
export type CostBasisMix = z.infer<typeof CostBasisMix>;

export const TerminalStatus = z.enum(["done", "completed", "halted", "failed", "cancelled"]);
export type TerminalStatus = z.infer<typeof TerminalStatus>;

export const TrialScorecard = z
  .object({
    runId: z.string().min(1),
    cellId: z.string().min(1).nullable(),
    trialIndex: z.number().int().nonnegative().nullable(),
    // The post-merge hidden accept tier (§2.1). Nullable: the accept step is a
    // follow-up, so null is the honest "not yet evaluated" state.
    reachedAcceptGreen: z.boolean().nullable(),
    terminalStatus: TerminalStatus.nullable(),
    haltReason: z.string().nullable(),
    /** spec.created → merge.completed, in seconds (DORA lead time). Null pre-merge. */
    leadTimeSeconds: z.number().nonnegative().nullable(),
    /** run start → terminal, in seconds (queue wait removed). Null if not terminal. */
    activeExecutionSeconds: z.number().nonnegative().nullable(),
    plannerReruns: z.number().int().nonnegative(),
    plannerRerunsByProducer: z
      .object({ gate: z.number().int().nonnegative(), auditor: z.number().int().nonnegative() })
      .strict(),
    /** Sum of `tasks.attempt` over write tasks (§2.3). */
    writerIterations: z.number().int().nonnegative(),
    gateFailures: z.number().int().nonnegative(),
    reviewIterations: z.number().int().nonnegative(),
    auditedConcerns: z.number().int().nonnegative(),
    tokens: TrialTokens,
    /** null is honest (subscription/unpriced) — the aggregate handles it (§2.1). */
    costUsd: z.number().nullable(),
    costBasisMix: CostBasisMix,
  })
  .strict();
export type TrialScorecard = z.infer<typeof TrialScorecard>;

// ---- Projection inputs (the rows the loader pulls) ------------------------

/** The single `runs` row this trial is built from. */
export interface RunFacts {
  runId: string;
  status: string;
  outcome: string | null;
  startedAt: Date;
  endedAt: Date | null;
  /** spec.created_at — the lead-time clock start (DORA). */
  specCreatedAt: Date;
}

/** A timeline event narrowed to the type + producer the projection needs. */
export interface EventFact {
  eventType: string;
  ts: Date;
  /** `payload.producer` for planner.rerequested; undefined elsewhere. */
  producer?: string | undefined;
}

/** A `tasks` row narrowed to the write-iteration projection. */
export interface TaskFact {
  agentKind: string;
  attempt: number;
}

/** A `cost_records` row narrowed to the token + cost projection. */
export interface CostFact {
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  costUsd: number | null;
  costBasis: string;
}

export interface TrialProjectionInputs {
  run: RunFacts;
  events: EventFact[];
  tasks: TaskFact[];
  costs: CostFact[];
  /** From the experiment_trials join, when known. */
  cellId?: string | null;
  trialIndex?: number | null;
  /** The post-merge accept outcome (§2.1) — input here, null until evaluated. */
  reachedAcceptGreen?: boolean | null;
}

const TERMINAL_STATUSES = new Set(["done", "completed", "halted", "failed", "cancelled"]);

/**
 * Pure projection of one trial's run-set into a `TrialScorecard`. Deterministic
 * over its inputs; the DB loader below is the only impure shell. Lead time
 * reuses `deriveDoraMetrics` (the canonical spec→merge reducer) rather than
 * recomputing the metric — when the run merged, its single merge feeds the DORA
 * reducer and we read back its leadTimeSeconds.
 */
export function projectTrialScorecard(inputs: TrialProjectionInputs): TrialScorecard {
  const { run, events, tasks, costs } = inputs;

  const terminalStatus = TERMINAL_STATUSES.has(run.status) ? (run.status as TerminalStatus) : null;

  // Active execution: run start → terminal, queue wait removed (the run is
  // dequeued before `startedAt`, so startedAt..endedAt is already queue-free).
  const activeExecutionSeconds =
    run.endedAt === null ? null : Math.max(0, (run.endedAt.getTime() - run.startedAt.getTime()) / 1000);

  // Lead time via the canonical DORA reducer: one merge.completed for this run
  // → spec.created→merge lead time. No merge → null (honest).
  const merge = events.find((e) => e.eventType === "merge.completed");
  let leadTimeSeconds: number | null = null;
  if (merge !== undefined) {
    const dora = deriveDoraMetrics(
      {
        merges: [{ specId: run.runId, specCreatedAt: run.specCreatedAt, mergedAt: merge.ts }],
        finishedRuns: [],
        recoveries: [],
      },
      { projectId: run.runId, windowStart: run.specCreatedAt, windowEnd: merge.ts, windowDays: 1 },
    );
    leadTimeSeconds = dora.leadTimeSeconds.value;
  }

  // Planner reruns, split by producer (gate vs auditor) off planner.rerequested.
  let plannerReruns = 0;
  let rerunsGate = 0;
  let rerunsAuditor = 0;
  for (const e of events) {
    if (e.eventType !== "planner.rerequested") continue;
    plannerReruns += 1;
    if (e.producer === "gate") rerunsGate += 1;
    else if (e.producer === "auditor") rerunsAuditor += 1;
  }

  const gateFailures = events.filter((e) => e.eventType === "gate.failed").length;
  // Each changes-requested PR review is one review iteration (§2.2 review.*).
  const reviewIterations = events.filter((e) => e.eventType === "review.changes_requested").length;
  // Audited concerns: each auditor rejection is a concern surfaced (§2.2).
  const auditedConcerns = events.filter((e) => e.eventType === "auditor.rejected").length;

  // Writer iterations: sum of `tasks.attempt` over write tasks.
  const writerIterations = tasks
    .filter((t) => t.agentKind === "writer")
    .reduce((sum, t) => sum + Math.max(0, t.attempt), 0);

  const tokens = costs.reduce(
    (acc, c) => ({
      input: acc.input + c.inputTokens,
      cachedInput: acc.cachedInput + c.cachedInputTokens,
      cacheCreation: acc.cacheCreation + c.cacheCreationTokens,
      output: acc.output + c.outputTokens,
      reasoning: acc.reasoning + c.reasoningOutputTokens,
      total: acc.total + c.totalTokens,
    }),
    { input: 0, cachedInput: 0, cacheCreation: 0, output: 0, reasoning: 0, total: 0 },
  );

  // costUsd: null-honest. If ANY record carries a cost, sum the present ones;
  // if NONE do (all subscription/unpriced), the trial cost is null, not 0.
  const priced = costs.filter((c) => c.costUsd !== null);
  const costUsd = priced.length === 0 ? null : priced.reduce((sum, c) => sum + (c.costUsd ?? 0), 0);

  const costBasisMix: CostBasisMix = {
    provider_response: 0,
    ccusage: 0,
    credits: 0,
    unknown: 0,
    unattributed: 0,
  };
  for (const c of costs) {
    if (c.costBasis === "provider_response") costBasisMix.provider_response += 1;
    else if (c.costBasis === "ccusage") costBasisMix.ccusage += 1;
    else if (c.costBasis === "credits") costBasisMix.credits += 1;
    else if (c.costBasis === "unattributed") costBasisMix.unattributed += 1;
    else costBasisMix.unknown += 1;
  }

  return TrialScorecard.parse({
    runId: run.runId,
    cellId: inputs.cellId ?? null,
    trialIndex: inputs.trialIndex ?? null,
    reachedAcceptGreen: inputs.reachedAcceptGreen ?? null,
    terminalStatus,
    haltReason: run.status === "halted" ? run.outcome : null,
    leadTimeSeconds,
    activeExecutionSeconds,
    plannerReruns,
    plannerRerunsByProducer: { gate: rerunsGate, auditor: rerunsAuditor },
    writerIterations,
    gateFailures,
    reviewIterations,
    auditedConcerns,
    tokens,
    costUsd,
    costBasisMix,
  });
}

// ---- DB loader (the impure shell) -----------------------------------------

interface RunQueryRow {
  run_id: string;
  status: string;
  outcome: string | null;
  started_at: Date;
  ended_at: Date | null;
  spec_created_at: Date;
}
interface EventQueryRow {
  event_type: string;
  ts: Date;
  producer: string | null;
}
interface TaskQueryRow {
  agent_kind: string;
  attempt: number;
}
interface CostQueryRow {
  input_tokens: number;
  cached_input_tokens: number;
  cache_creation_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
  cost_usd: string | null;
  cost_basis: string;
}

export interface LoadTrialScorecardOptions {
  runId: string;
  cellId?: string | null;
  trialIndex?: number | null;
  reachedAcceptGreen?: boolean | null;
}

/**
 * Load the read-only rows for one run (joined to its spec's creation instant)
 * and project them into a `TrialScorecard`. Touches only runs/specs/events/
 * tasks/cost_records — all pre-existing tables. Returns null when the run does
 * not exist (or is invisible under the caller's org scope). Pass an org-scoped
 * client (orgScope.ts) so RLS confines the read to the trial's tenant.
 */
export async function loadTrialScorecard(
  client: Pick<pg.Pool | pg.PoolClient, "query">,
  options: LoadTrialScorecardOptions,
): Promise<TrialScorecard | null> {
  const runResult = await client.query<RunQueryRow>(
    `SELECT r.run_id, r.status, r.outcome, r.started_at, r.ended_at,
            s.created_at AS spec_created_at
       FROM runs r
       INNER JOIN specs s ON s.spec_id = r.spec_id
      WHERE r.run_id = $1`,
    [options.runId],
  );
  const runRow = runResult.rows[0];
  if (runRow === undefined) return null;

  const eventsResult = await client.query<EventQueryRow>(
    `SELECT event_type, ts, payload->>'producer' AS producer
       FROM events
      WHERE run_id = $1
      ORDER BY ts ASC`,
    [options.runId],
  );
  const tasksResult = await client.query<TaskQueryRow>(`SELECT agent_kind, attempt FROM tasks WHERE run_id = $1`, [
    options.runId,
  ]);
  const costsResult = await client.query<CostQueryRow>(
    `SELECT input_tokens, cached_input_tokens, cache_creation_tokens, output_tokens,
            reasoning_output_tokens, total_tokens, cost_usd, cost_basis
       FROM cost_records WHERE run_id = $1`,
    [options.runId],
  );

  return projectTrialScorecard({
    run: {
      runId: runRow.run_id,
      status: runRow.status,
      outcome: runRow.outcome,
      startedAt: new Date(runRow.started_at),
      endedAt: runRow.ended_at === null ? null : new Date(runRow.ended_at),
      specCreatedAt: new Date(runRow.spec_created_at),
    },
    events: eventsResult.rows.map((e) => ({
      eventType: e.event_type,
      ts: new Date(e.ts),
      producer: e.producer ?? undefined,
    })),
    tasks: tasksResult.rows.map((t) => ({ agentKind: t.agent_kind, attempt: Number(t.attempt) })),
    costs: costsResult.rows.map((c) => ({
      inputTokens: Number(c.input_tokens),
      cachedInputTokens: Number(c.cached_input_tokens),
      cacheCreationTokens: Number(c.cache_creation_tokens),
      outputTokens: Number(c.output_tokens),
      reasoningOutputTokens: Number(c.reasoning_output_tokens),
      totalTokens: Number(c.total_tokens),
      costUsd: c.cost_usd === null ? null : Number(c.cost_usd),
      costBasis: c.cost_basis,
    })),
    cellId: options.cellId ?? null,
    trialIndex: options.trialIndex ?? null,
    reachedAcceptGreen: options.reachedAcceptGreen ?? null,
  });
}
