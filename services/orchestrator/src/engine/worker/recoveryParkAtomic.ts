// Atomic recovery parking authority. The exact RLS-visible queue/run/spec/project
// tuple is the ownership proof: no matching tuple means no mutation. A fresh apply
// flips the live spec, appends the park event then the dequeue event through
// PgEventStore, and retires the queue row on one caller-owned transaction.

import type pg from "pg";
import { z } from "zod";
import type {
  RecoveryOwnedSettleFailureReason,
  RecoveryOwnedSettleInput,
  RecoveryOwnedSettleOutcome,
  RecoveryParkFailureReason,
  RecoveryParkInput,
  RecoveryParkOutcome,
} from "../contracts/runStateWriter.js";
import { PgEventStore } from "../eventStore.js";
import { readOwnedReceiptEvidence } from "../merge/recoveryEvidencePg.js";
import { verifyRecoveryOwnership } from "../merge/recoveryOwnership.js";
import { recoveryReceiptFingerprint } from "../merge/recoveryReceiptFingerprint.js";
import { RECOVERABLE_RETRY_DELAYS_MS, recoverableRetryDelayMs } from "../merge/retrySchedule.js";

type RecoveryParkClient = Pick<pg.Pool | pg.PoolClient, "query">;

/** First bounded merge-redrive delay; repeated attempts remain paced by the caller's hold ceiling. */
export const RECOVERY_PARK_RETRY_AFTER_MS = recoverableRetryDelayMs(1);

export const recoveryParkInputSchema = z
  .object({
    orgId: z.string().min(1),
    projectId: z.string().min(1),
    queueId: z.string().min(1),
    runId: z.string().min(1),
    specId: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();

const recoveryRunReceiptSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("enqueued"), replanRunId: z.string().min(1), plannerTaskId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("already_running"), runId: z.string().min(1) }).strict(),
]);

const recoveryReceiptSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("planner_replan"), specId: z.string().min(1), run: recoveryRunReceiptSchema }).strict(),
  z.object({ kind: z.literal("writer_rework"), specId: z.string().min(1), run: recoveryRunReceiptSchema }).strict(),
]);

export const recoveryOwnedSettleInputSchema = z
  .object({
    orgId: z.string().min(1),
    projectId: z.string().min(1),
    queueId: z.string().min(1),
    runId: z.string().min(1),
    specId: z.string().min(1),
    receipt: recoveryReceiptSchema,
    reason: z.enum(["conflict", "superseded"]),
    message: z.string().min(1),
  })
  .strict();

const retryAfterMsSchema = z
  .number()
  .int()
  .refine((value) => RECOVERABLE_RETRY_DELAYS_MS.includes(value), "retryAfterMs must use the canonical merge schedule");

const recoveryParkOutcomeSchema = z.union([
  z.object({ kind: z.literal("parked"), newlyParked: z.boolean() }).strict(),
  z
    .object({
      kind: z.literal("parking_failed"),
      reason: z.literal("spec_not_recoverable"),
      queueDisposition: z.literal("retained"),
      retryAfterMs: retryAfterMsSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("parking_failed"),
      reason: z.enum(["invalid_input", "ownership_missing", "queue_not_active", "write_failed", "transport_failed"]),
      queueDisposition: z.literal("unknown"),
      retryAfterMs: retryAfterMsSchema,
    })
    .strict(),
]);

const recoveryOwnedSettleOutcomeSchema = z.union([
  z.object({ kind: z.literal("settled"), newlySettled: z.boolean() }).strict(),
  z
    .object({
      kind: z.literal("settlement_failed"),
      reason: z.literal("evidence_invalid"),
      queueDisposition: z.literal("retained"),
      retryAfterMs: retryAfterMsSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("settlement_failed"),
      reason: z.enum([
        "invalid_input",
        "ownership_missing",
        "queue_not_active",
        "receipt_mismatch",
        "write_failed",
        "transport_failed",
      ]),
      queueDisposition: z.literal("unknown"),
      retryAfterMs: retryAfterMsSchema,
    })
    .strict(),
]);

const ownershipRowSchema = z
  .object({
    queue_status: z.string(),
    dequeue_reason: z.string().nullable(),
    spec_status: z.string(),
    pr_url: z.string().min(1),
    pr_number: z.coerce.number().int().positive(),
  })
  .strict();

const RECOVERABLE_SPEC_STATUSES = new Set(["open", "in_flight", "review"]);
const ACTIVE_QUEUE_STATUSES = new Set(["queued", "merging"]);

export function recoveryParkingFailed(reason: RecoveryParkFailureReason): RecoveryParkOutcome {
  if (reason === "spec_not_recoverable") {
    return { kind: "parking_failed", reason, queueDisposition: "retained", retryAfterMs: RECOVERY_PARK_RETRY_AFTER_MS };
  }
  return { kind: "parking_failed", reason, queueDisposition: "unknown", retryAfterMs: RECOVERY_PARK_RETRY_AFTER_MS };
}

export function recoveryOwnedSettlementFailed(reason: RecoveryOwnedSettleFailureReason): RecoveryOwnedSettleOutcome {
  if (reason === "evidence_invalid") {
    return {
      kind: "settlement_failed",
      reason,
      queueDisposition: "retained",
      retryAfterMs: RECOVERY_PARK_RETRY_AFTER_MS,
    };
  }
  return { kind: "settlement_failed", reason, queueDisposition: "unknown", retryAfterMs: RECOVERY_PARK_RETRY_AFTER_MS };
}

/** Decode the shared client/server request contract without transforming it. */
export function parseRecoveryParkInput(value: unknown): RecoveryParkInput | undefined {
  const parsed = recoveryParkInputSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Strictly decode a remote success body; malformed 2xx responses are transport failures. */
export function parseRecoveryParkOutcome(value: unknown): RecoveryParkOutcome | undefined {
  const parsed = recoveryParkOutcomeSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function parseRecoveryOwnedSettleInput(value: unknown): RecoveryOwnedSettleInput | undefined {
  const parsed = recoveryOwnedSettleInputSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function parseRecoveryOwnedSettleOutcome(value: unknown): RecoveryOwnedSettleOutcome | undefined {
  const parsed = recoveryOwnedSettleOutcomeSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Verify the exact active successor, append the canonical dequeue event, and
 * retire the exact old queue tuple in one caller-owned transaction. The
 * successor run is row-locked through retirement, closing the lookup/dequeue
 * TOCTOU; the queue row is the dropped-ack replay anchor.
 */
export async function applyRecoveryOwnedSettleAtomic(
  client: RecoveryParkClient,
  input: RecoveryOwnedSettleInput,
): Promise<RecoveryOwnedSettleOutcome> {
  const queueResult = await client.query<{
    queue_status: string;
    dequeue_reason: string | null;
    pr_url: string;
    pr_number: string | number;
  }>(
    `SELECT mq.status AS queue_status, mq.dequeue_reason, mq.pr_url, mq.pr_number
       FROM merge_queue mq
       JOIN runs old_run
         ON old_run.run_id = mq.run_id
        AND old_run.spec_id = mq.spec_id
        AND old_run.project_id = mq.project_id
        AND old_run.org_id = mq.org_id
       JOIN specs s
         ON s.spec_id = mq.spec_id
        AND s.project_id = mq.project_id
        AND s.org_id = mq.org_id
       JOIN projects p
         ON p.project_id = mq.project_id
        AND p.org_id = mq.org_id
      WHERE mq.queue_id = $1
        AND mq.org_id = $2
        AND mq.project_id = $3
        AND mq.run_id = $4
        AND mq.spec_id = $5
      FOR UPDATE OF mq`,
    [input.queueId, input.orgId, input.projectId, input.runId, input.specId],
  );
  const queue = queueResult.rows[0];
  if (queue === undefined) return recoveryOwnedSettlementFailed("ownership_missing");
  const receiptFingerprint = recoveryReceiptFingerprint(input);
  if (queue.queue_status === "dequeued" && queue.dequeue_reason === input.reason) {
    const receipt = await client.query<{ event_type: string; payload: Record<string, unknown> }>(
      `SELECT event_type, payload
         FROM events
        WHERE run_id = $1 AND org_id = $2 AND project_id = $3 AND spec_id = $4
          AND idempotency_key = $5
        LIMIT 1`,
      [input.runId, input.orgId, input.projectId, input.specId, receiptFingerprint],
    );
    const event = receipt.rows[0];
    if (
      event?.event_type === "merge.dequeued" &&
      event.payload["integration"] === "native_queue" &&
      event.payload["specId"] === input.specId &&
      event.payload["reason"] === input.reason &&
      event.payload["prUrl"] === queue.pr_url &&
      Number(event.payload["prNumber"]) === Number(queue.pr_number)
    ) {
      return { kind: "settled", newlySettled: false };
    }
    return recoveryOwnedSettlementFailed("receipt_mismatch");
  }
  if (!ACTIVE_QUEUE_STATUSES.has(queue.queue_status)) {
    return recoveryOwnedSettlementFailed("queue_not_active");
  }

  const verified = await verifyRecoveryOwnership({
    evidence: {
      verifyOwnedReceipt: (expected) => readOwnedReceiptEvidence(client, expected, true),
    },
    expectedOrgId: input.orgId,
    expectedProjectId: input.projectId,
    expectedSpecId: input.specId,
    priorRunId: input.runId,
    receipt: input.receipt,
    contextMessage: input.message,
  });
  if (!verified.ok) return recoveryOwnedSettlementFailed("evidence_invalid");

  const eventInserted = await new PgEventStore(client).appendPriorIfAbsent({
    runId: input.runId,
    specId: input.specId,
    projectId: input.projectId,
    orgId: input.orgId,
    eventType: "merge.dequeued",
    idempotencyKey: receiptFingerprint,
    payload: {
      prUrl: queue.pr_url,
      prNumber: Number(queue.pr_number),
      integration: "native_queue",
      specId: input.specId,
      reason: input.reason,
      message: input.message,
    },
  });
  if (!eventInserted) throw new Error(`owned recovery receipt already exists while queue ${input.queueId} is active`);
  const dequeued = await client.query(
    `UPDATE merge_queue
        SET status = 'dequeued', dequeue_reason = $6, settled_at = now()
      WHERE queue_id = $1
        AND org_id = $2
        AND project_id = $3
        AND run_id = $4
        AND spec_id = $5
        AND status IN ('queued', 'merging')
      RETURNING queue_id`,
    [input.queueId, input.orgId, input.projectId, input.runId, input.specId, input.reason],
  );
  if (dequeued.rows[0] === undefined) {
    throw new Error(`owned recovery lost active queue ownership for ${input.queueId}`);
  }
  return { kind: "settled", newlySettled: true };
}

/**
 * Apply the atomic park on an already org-scoped transaction client. The exact
 * queue row is the idempotency anchor: committed `dequeued/needs_attention`
 * returns `newlyParked:false` even if the spec legally progressed before replay.
 */
export async function applyRecoveryParkAtomic(
  client: RecoveryParkClient,
  input: RecoveryParkInput,
): Promise<RecoveryParkOutcome> {
  const owned = await client.query(
    `SELECT mq.status AS queue_status,
            mq.dequeue_reason,
            s.status AS spec_status,
            mq.pr_url,
            mq.pr_number
       FROM merge_queue mq
       JOIN runs r
         ON r.run_id = mq.run_id
        AND r.spec_id = mq.spec_id
        AND r.project_id = mq.project_id
        AND r.org_id = mq.org_id
       JOIN specs s
         ON s.spec_id = mq.spec_id
        AND s.project_id = mq.project_id
        AND s.org_id = mq.org_id
       JOIN projects p
         ON p.project_id = mq.project_id
        AND p.org_id = mq.org_id
      WHERE mq.queue_id = $1
        AND mq.org_id = $2
        AND mq.project_id = $3
        AND mq.run_id = $4
        AND mq.spec_id = $5
      FOR UPDATE OF mq, r, s, p`,
    [input.queueId, input.orgId, input.projectId, input.runId, input.specId],
  );
  const raw = owned.rows[0] as unknown;
  if (raw === undefined) {
    return recoveryParkingFailed("ownership_missing");
  }
  const row = ownershipRowSchema.parse(raw);

  // The exact queue row is the durable commit receipt. Its spec may already have
  // progressed after a human resolved the incident, so replay must not require the
  // current spec status or duplicate either recurring event.
  if (row.queue_status === "dequeued" && row.dequeue_reason === "needs_attention") {
    return { kind: "parked", newlyParked: false };
  }
  if (!ACTIVE_QUEUE_STATUSES.has(row.queue_status)) {
    return recoveryParkingFailed("queue_not_active");
  }
  if (!RECOVERABLE_SPEC_STATUSES.has(row.spec_status)) {
    return recoveryParkingFailed("spec_not_recoverable");
  }

  const parked = await client.query(
    `UPDATE specs
        SET status = 'needs_attention'
      WHERE spec_id = $1
        AND org_id = $2
        AND project_id = $3
        AND status IN ('open', 'in_flight', 'review')
      RETURNING spec_id`,
    [input.specId, input.orgId, input.projectId],
  );
  if (parked.rows[0] === undefined) {
    return recoveryParkingFailed("spec_not_recoverable");
  }

  const events = new PgEventStore(client);
  await events.append({
    runId: input.runId,
    specId: input.specId,
    projectId: input.projectId,
    orgId: input.orgId,
    eventType: "dag.spec.needs_attention",
    payload: {
      source: "merge_conflict",
      specId: input.specId,
      prUrl: row.pr_url,
      prNumber: row.pr_number,
      message: input.message,
    },
  });
  await events.append({
    runId: input.runId,
    specId: input.specId,
    projectId: input.projectId,
    orgId: input.orgId,
    eventType: "merge.dequeued",
    payload: {
      prUrl: row.pr_url,
      prNumber: row.pr_number,
      integration: "native_queue",
      specId: input.specId,
      reason: "needs_attention",
      message: input.message,
    },
  });

  const dequeued = await client.query(
    `UPDATE merge_queue
        SET status = 'dequeued', dequeue_reason = 'needs_attention', settled_at = now()
      WHERE queue_id = $1
        AND org_id = $2
        AND project_id = $3
        AND run_id = $4
        AND spec_id = $5
        AND status IN ('queued', 'merging')
      RETURNING queue_id`,
    [input.queueId, input.orgId, input.projectId, input.runId, input.specId],
  );
  if (dequeued.rows[0] === undefined) {
    // The caller's transaction must roll back the spec + both events; a false
    // success here would strand the exact split state this seam eliminates.
    throw new Error(`recovery park lost active queue ownership for ${input.queueId}`);
  }
  return { kind: "parked", newlyParked: true };
}
