// gv-2 durable intended-verdict fence (migration-free, eventStore-backed).
//
// First-wins authority for the Answerer decision on an exact head BEFORE any
// forge I/O. Concurrent workers may compute different answers, but both must
// adopt the single durable winner. Intent is NOT a terminal review and must
// never authorize land (landSignals only reads review.approved /
// review.changes_requested / review.auto_approved).

import type pg from "pg";
import { getOrgScopedClient } from "@tanren/db";
import type { z } from "zod";
import { type EventStore, type PriorEventInput } from "../../eventStore.js";
import { ReviewSimulatedIntentPayload } from "../../events/schemas/eventVocabularyW0.js";
import { isPool, resolveWritableClient } from "../../data/orgScopedDb.js";
import { SimulatedReviewPublicationError } from "./simulatedReviewPublication.js";

export const REVIEW_SIMULATED_INTENT_EVENT = "review.simulated_intent" as const;

export type SimulatedReviewIntent = z.infer<typeof ReviewSimulatedIntentPayload>;

export function simulatedReviewIntentKey(runId: string, headSha: string): string {
  return `${runId}:simulated-review-intent:${headSha.toLowerCase()}`;
}

export function parseSimulatedReviewIntent(payload: unknown): SimulatedReviewIntent {
  return ReviewSimulatedIntentPayload.parse(payload);
}

/** Port for durable intent lookup + first-wins record. */
export interface SimulatedReviewIntentRepository {
  lookup(orgId: string, runId: string, headSha: string): Promise<SimulatedReviewIntent | undefined>;
  /**
   * Append candidate under the head-keyed first-wins key, then read back and
   * return the durable winner (this caller or a concurrent peer).
   */
  adoptOrRecord(input: {
    runId: string;
    orgId: string;
    projectId: string;
    specId?: string;
    taskId?: string;
    candidate: SimulatedReviewIntent;
  }): Promise<SimulatedReviewIntent>;
}

type IntentQueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

type PriorCapableStore = EventStore & {
  appendPriorIfAbsent: <N extends "review.simulated_intent">(input: PriorEventInput<N>) => Promise<boolean>;
};

/**
 * Production intent repository: eventStore first-wins append + SQL readback.
 * Uses the existing events table (no second store / no migration).
 */
export class PgSimulatedReviewIntentRepository implements SimulatedReviewIntentRepository {
  private readonly store: PriorCapableStore;

  constructor(
    private readonly pool: IntentQueryClient,
    store: PriorCapableStore,
  ) {
    this.store = store;
  }

  async lookup(orgId: string, runId: string, headSha: string): Promise<SimulatedReviewIntent | undefined> {
    const key = simulatedReviewIntentKey(runId, headSha);
    const client = resolveWritableClient(this.pool);
    const result = await client.query<{ payload: unknown }>(
      `SELECT payload FROM events
        WHERE run_id = $1
          AND event_type = $2
          AND idempotency_key = $3
          AND org_id = $4
        ORDER BY ts ASC, id ASC
        LIMIT 1`,
      [runId, REVIEW_SIMULATED_INTENT_EVENT, key, orgId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    try {
      return parseSimulatedReviewIntent(row.payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new SimulatedReviewPublicationError(`simulated review intent corrupt for head ${headSha}: ${message}`);
    }
  }

  async adoptOrRecord(input: {
    runId: string;
    orgId: string;
    projectId: string;
    specId?: string;
    taskId?: string;
    candidate: SimulatedReviewIntent;
  }): Promise<SimulatedReviewIntent> {
    const headSha = input.candidate.headSha;
    const key = simulatedReviewIntentKey(input.runId, headSha);
    // First-wins: concurrent appends collide on (run_id, idempotency_key).
    try {
      await this.store.appendPriorIfAbsent({
        runId: input.runId,
        orgId: input.orgId,
        projectId: input.projectId,
        ...(input.specId !== undefined && { specId: input.specId }),
        ...(input.taskId !== undefined && { taskId: input.taskId }),
        eventType: REVIEW_SIMULATED_INTENT_EVENT,
        payload: input.candidate,
        idempotencyKey: key,
      });
    } catch (err) {
      // ON CONFLICT is represented by a clean `false`, never an exception. An
      // exception may still be an ambiguous transport response loss, but a SQL
      // statement error aborts its transaction: issuing lookup SQL on that same
      // client only produces 25P02 and masks the primary RLS/schema failure.
      // Recover only from a pool/autocommit boundary with no ambient transaction.
      if (canReadBackAfterAppendFailure(this.pool, err)) {
        try {
          const existingAfterResponseLoss = await this.lookup(input.orgId, input.runId, headSha);
          if (existingAfterResponseLoss !== undefined) return existingAfterResponseLoss;
        } catch {
          // Fail closed with the primary append failure. A recovery-read error
          // must never replace the causal provider/SQL failure in diagnostics.
        }
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new SimulatedReviewPublicationError(
        `simulated review intent append failed for head ${headSha}: ${message}`,
      );
    }
    const winner = await this.lookup(input.orgId, input.runId, headSha);
    if (winner === undefined) {
      // Response-loss on append: re-append is first-wins no-op if peer won;
      // if still absent, fail loud (never publish without durable intent).
      throw new SimulatedReviewPublicationError(
        `simulated review intent readback empty after append for head ${headSha}`,
      );
    }
    return winner;
  }
}

function canReadBackAfterAppendFailure(pool: IntentQueryClient, error: unknown): boolean {
  if (isSqlStatementFailure(error)) return false;
  if (getOrgScopedClient() !== undefined) return false;
  return isPool(pool);
}

function isSqlStatementFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = Reflect.get(error, "code");
  return typeof code === "string" && /^[0-9A-Z]{5}$/u.test(code);
}

/**
 * Production composition: reads from the org-scoped events table and writes
 * through the one writer-backed atomic prior-event seam. An append-only store
 * is never silently replaced with process-local memory.
 */
export function durableSimulatedReviewIntentRepository(
  pool: IntentQueryClient,
  store: EventStore,
): PgSimulatedReviewIntentRepository {
  if (typeof store.appendPriorIfAbsent !== "function") {
    throw new SimulatedReviewPublicationError(
      "strict simulated review requires a durable EventStore appendPriorIfAbsent seam; in-memory intent is test-only",
    );
  }
  return new PgSimulatedReviewIntentRepository(pool, store as PriorCapableStore);
}

/**
 * In-memory first-wins intent repository for unit tests (same key semantics as
 * production events_prior_idempotency_unique). Optionally mirrors into an
 * EventStore so timeline assertions see the intent event.
 */
export class InMemorySimulatedReviewIntentRepository implements SimulatedReviewIntentRepository {
  private readonly byKey = new Map<string, SimulatedReviewIntent>();

  constructor(
    private readonly mirror?: {
      append: (input: {
        runId: string;
        orgId: string;
        projectId?: string;
        specId?: string;
        taskId?: string;
        eventType: "review.simulated_intent";
        payload: SimulatedReviewIntent;
        idempotencyKey?: string;
      }) => Promise<void>;
    },
  ) {}

  async lookup(_orgId: string, runId: string, headSha: string): Promise<SimulatedReviewIntent | undefined> {
    return this.byKey.get(simulatedReviewIntentKey(runId, headSha));
  }

  async adoptOrRecord(input: {
    runId: string;
    orgId: string;
    projectId: string;
    specId?: string;
    taskId?: string;
    candidate: SimulatedReviewIntent;
  }): Promise<SimulatedReviewIntent> {
    const key = simulatedReviewIntentKey(input.runId, input.candidate.headSha);
    const existing = this.byKey.get(key);
    if (existing !== undefined) return existing;
    this.byKey.set(key, input.candidate);
    if (this.mirror !== undefined) {
      await this.mirror.append({
        runId: input.runId,
        orgId: input.orgId,
        projectId: input.projectId,
        ...(input.specId !== undefined && { specId: input.specId }),
        ...(input.taskId !== undefined && { taskId: input.taskId }),
        eventType: REVIEW_SIMULATED_INTENT_EVENT,
        payload: input.candidate,
        idempotencyKey: key,
      });
    }
    return input.candidate;
  }

  /** Test helper: seed a pre-existing durable intent (crash-after-intent). */
  seed(runId: string, intent: SimulatedReviewIntent): void {
    this.byKey.set(simulatedReviewIntentKey(runId, intent.headSha), intent);
  }
}
