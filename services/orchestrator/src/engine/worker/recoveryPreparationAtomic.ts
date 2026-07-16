import { createHash } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import type { ConflictRecoveryReceipt } from "../contracts/conflictResolution.js";
import type {
  RecoveryPreparationInput,
  RecoveryPreparationOutcome,
  RecoveryPreparationRoute,
} from "../contracts/recoveryPreparation.js";
import { PgEventStore } from "../eventStore.js";
import type { EventPayload } from "../events/index.js";
import { isRecoverableSourceSpecStatus } from "../merge/recoveryOwnership.js";
import { createQueuedRunFromSpecOnClient } from "../workflow/projectSpec.js";
import { applyAppendSpecSteering } from "./runStateLifecycleSql.js";

const routeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("planner_replan"),
      newContext: z.string().min(1),
      otherSpecId: z.string().min(1).optional(),
      conflictSignature: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("regate_writer_rework"),
      prNumber: z.number().int().nonnegative(),
      gateError: z.string().min(1),
      priorReworks: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("batch_writer_rework"),
      prNumber: z.number().int().nonnegative(),
      gateError: z.string().min(1),
      priorReworks: z.number().int().nonnegative(),
    })
    .strict(),
]);

export const recoveryPreparationInputSchema = z
  .object({
    orgId: z.string().min(1),
    projectId: z.string().min(1),
    specId: z.string().min(1),
    oldRunId: z.string().min(1),
    queueId: z.string().min(1).optional(),
    steeringNote: z.string().min(1),
    reopenStatus: z.literal("open"),
    route: routeSchema,
  })
  .strict();

const receiptSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("planner_replan"),
      specId: z.string().min(1),
      run: z
        .object({ kind: z.literal("enqueued"), replanRunId: z.string().min(1), plannerTaskId: z.string().min(1) })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("writer_rework"),
      specId: z.string().min(1),
      run: z
        .object({ kind: z.literal("enqueued"), replanRunId: z.string().min(1), plannerTaskId: z.string().min(1) })
        .strict(),
    })
    .strict(),
]);

export const recoveryPreparationOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("owned"), receipt: receiptSchema, newlyPrepared: z.boolean() }).strict(),
  z
    .object({
      kind: z.literal("terminal_noop"),
      status: z.enum(["merged", "cancelled", "halted"]),
      message: z.string(),
    })
    .strict(),
  z.object({ kind: z.literal("conflict"), message: z.string() }).strict(),
  z
    .object({
      kind: z.literal("failure"),
      reason: z.enum(["invalid_input", "write_failed", "transport_failed"]),
      message: z.string(),
    })
    .strict(),
]);

type PreparationClient = pg.PoolClient;

interface LockedCandidate {
  queue_id: string;
  queue_status: string;
  spec_status: string;
}

interface PreparedEvents {
  routeEventType: string | undefined;
  routePayload: unknown;
  lineageEventType: string | undefined;
  lineagePayload: unknown;
}

export function parseRecoveryPreparationInput(value: unknown): RecoveryPreparationInput | undefined {
  const parsed = recoveryPreparationInputSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function parseRecoveryPreparationOutcome(value: unknown): RecoveryPreparationOutcome | undefined {
  const parsed = recoveryPreparationOutcomeSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function recoveryPreparationFailure(
  reason: "invalid_input" | "write_failed" | "transport_failed",
  message: string,
): RecoveryPreparationOutcome {
  return { kind: "failure", reason, message };
}

/** Apply the complete successor preparation on one already org-scoped transaction. */
export async function applyRecoveryPreparationAtomic(
  client: PreparationClient,
  input: RecoveryPreparationInput,
): Promise<RecoveryPreparationOutcome> {
  const candidate = await lockExactCandidate(client, input);
  if (typeof candidate === "string") return { kind: "conflict", message: candidate };

  const replay = await readPreparedEvents(client, input, candidate.queue_id);
  if (replay !== undefined) return validatePreparedReplay(client, input, candidate.queue_id, replay);

  if (candidate.queue_status !== "queued" && candidate.queue_status !== "merging") {
    return {
      kind: "conflict",
      message: `recovery queue ${candidate.queue_id} is ${candidate.queue_status}, not active`,
    };
  }
  if (
    candidate.spec_status === "merged" ||
    candidate.spec_status === "cancelled" ||
    candidate.spec_status === "halted"
  ) {
    return {
      kind: "terminal_noop",
      status: candidate.spec_status,
      message: `recovery preparation observed terminal spec ${input.specId} (${candidate.spec_status})`,
    };
  }
  if (!isRecoverableSourceSpecStatus(candidate.spec_status)) {
    return { kind: "conflict", message: `spec ${input.specId} is not recoverable from ${candidate.spec_status}` };
  }
  const otherOwner = await client.query<{ run_id: string }>(
    `SELECT run_id
       FROM runs
      WHERE org_id = $1 AND project_id = $2 AND spec_id = $3 AND run_id <> $4
        AND status IN ('queued', 'running', 'paused')
      ORDER BY run_id
      LIMIT 2
      FOR UPDATE`,
    [input.orgId, input.projectId, input.specId, input.oldRunId],
  );
  if (otherOwner.rows.length > 0) {
    return {
      kind: "conflict",
      message: `spec ${input.specId} already has active successor ownership (${otherOwner.rows.map((row) => row.run_id).join(",")})`,
    };
  }

  await applyAppendSpecSteering(client, {
    orgId: input.orgId,
    specId: input.specId,
    steeringNote: input.steeringNote,
  });
  const reopened = await client.query(
    `UPDATE specs
        SET status = 'open'
      WHERE spec_id = $1 AND org_id = $2 AND project_id = $3
        AND status IN ('open', 'in_flight', 'review')
      RETURNING spec_id`,
    [input.specId, input.orgId, input.projectId],
  );
  if (reopened.rows[0] === undefined) {
    return { kind: "conflict", message: `spec ${input.specId} changed while recovery preparation held its owner` };
  }

  const actor: ActorContext = {
    userId: "replan-router",
    orgId: input.orgId,
    projectId: input.projectId,
    scopes: ["platform:admin"],
    source: "local_dev",
  };
  const run = await createQueuedRunFromSpecOnClient(client, { specId: input.specId, trigger: "replan_routed" }, actor);
  const receipt = receiptFor(input.route, input.specId, run.runId, run.plannerTaskId);
  const store = new PgEventStore(client);
  const keys = preparationKeys(input, candidate.queue_id);
  const routeInserted = await appendRouteEvent(store, input, keys.route);
  if (!routeInserted) throw new Error(`recovery route slot already exists without its lineage marker: ${keys.route}`);
  const lineageInserted = await store.appendPriorIfAbsent({
    runId: input.oldRunId,
    specId: input.specId,
    projectId: input.projectId,
    orgId: input.orgId,
    eventType: "recovery.replan_queued",
    idempotencyKey: keys.lineage,
    payload: lineagePayload(input, run.runId, run.plannerTaskId),
  });
  if (!lineageInserted) throw new Error(`recovery lineage slot raced after exact queue lock: ${keys.lineage}`);
  return { kind: "owned", receipt, newlyPrepared: true };
}

/** Read-only durable outcome used after an ambiguous HTTP response. */
export async function readRecoveryPreparationAtomic(
  client: PreparationClient,
  input: RecoveryPreparationInput,
): Promise<RecoveryPreparationOutcome> {
  const candidate = await lockExactCandidate(client, input);
  if (typeof candidate === "string") return { kind: "conflict", message: candidate };
  const events = await readPreparedEvents(client, input, candidate.queue_id);
  if (events !== undefined) return validatePreparedReplay(client, input, candidate.queue_id, events);
  if (
    candidate.spec_status === "merged" ||
    candidate.spec_status === "cancelled" ||
    candidate.spec_status === "halted"
  ) {
    return {
      kind: "terminal_noop",
      status: candidate.spec_status,
      message: `recovery readback observed terminal spec ${input.specId} (${candidate.spec_status})`,
    };
  }
  return { kind: "failure", reason: "transport_failed", message: "recovery preparation has no durable commit receipt" };
}

async function lockExactCandidate(
  client: PreparationClient,
  input: RecoveryPreparationInput,
): Promise<LockedCandidate | string> {
  const result = await client.query<LockedCandidate>(
    `SELECT mq.queue_id, mq.status AS queue_status, s.status AS spec_status
       FROM merge_queue mq
       JOIN runs old_run ON old_run.run_id = mq.run_id AND old_run.spec_id = mq.spec_id
         AND old_run.project_id = mq.project_id AND old_run.org_id = mq.org_id
       JOIN specs s ON s.spec_id = mq.spec_id AND s.project_id = mq.project_id AND s.org_id = mq.org_id
       JOIN projects p ON p.project_id = mq.project_id AND p.org_id = mq.org_id
      WHERE mq.org_id = $1 AND mq.project_id = $2 AND mq.spec_id = $3 AND mq.run_id = $4
        AND ($5::text IS NULL OR mq.queue_id = $5)
      ORDER BY mq.queue_id
      LIMIT 2
      FOR UPDATE OF mq, old_run, s, p`,
    [input.orgId, input.projectId, input.specId, input.oldRunId, input.queueId ?? null],
  );
  if (result.rows.length !== 1) {
    return result.rows.length === 0
      ? `no exact recovery owner for org=${input.orgId} project=${input.projectId} spec=${input.specId} run=${input.oldRunId}`
      : `ambiguous recovery queue owner for run ${input.oldRunId}`;
  }
  return result.rows[0]!;
}

function preparationKeys(input: RecoveryPreparationInput, queueId: string): { route: string; lineage: string } {
  const digest = createHash("sha256")
    .update(JSON.stringify([input.orgId, input.projectId, input.specId, input.oldRunId, queueId]))
    .digest("hex");
  return { route: `recovery-prepare:v1:${digest}:route`, lineage: `recovery-prepare:v1:${digest}:lineage` };
}

async function readPreparedEvents(
  client: PreparationClient,
  input: RecoveryPreparationInput,
  queueId: string,
): Promise<PreparedEvents | undefined> {
  const keys = preparationKeys(input, queueId);
  const result = await client.query<{ idempotency_key: string; event_type: string; payload: unknown }>(
    `SELECT idempotency_key, event_type, payload
       FROM events
      WHERE run_id = $1 AND org_id = $2 AND project_id = $3 AND spec_id = $4
        AND idempotency_key = ANY($5::text[])`,
    [input.oldRunId, input.orgId, input.projectId, input.specId, [keys.route, keys.lineage]],
  );
  const route = result.rows.find((row) => row.idempotency_key === keys.route);
  const lineage = result.rows.find((row) => row.idempotency_key === keys.lineage);
  if (route === undefined && lineage === undefined) return undefined;
  if (route === undefined || lineage === undefined) {
    return {
      routeEventType: route?.event_type,
      routePayload: route?.payload,
      lineageEventType: lineage?.event_type,
      lineagePayload: lineage?.payload,
    };
  }
  return {
    routeEventType: route.event_type,
    routePayload: route.payload,
    lineageEventType: lineage.event_type,
    lineagePayload: lineage.payload,
  };
}

async function validatePreparedReplay(
  client: PreparationClient,
  input: RecoveryPreparationInput,
  queueId: string,
  events: PreparedEvents,
): Promise<RecoveryPreparationOutcome> {
  if (
    events.routeEventType !== expectedRouteEventType(input.route) ||
    events.lineageEventType !== "recovery.replan_queued" ||
    !jsonEqual(events.routePayload, expectedRoutePayload(input)) ||
    typeof events.lineagePayload !== "object"
  ) {
    return { kind: "conflict", message: `recovery preparation slot for ${queueId} belongs to a different request` };
  }
  const lineage = events.lineagePayload as Record<string, unknown>;
  const runId = lineage["replanRunId"];
  const taskId = lineage["plannerTaskId"];
  if (
    typeof runId !== "string" ||
    typeof taskId !== "string" ||
    !jsonEqual(events.lineagePayload, lineagePayload(input, runId, taskId))
  ) {
    return { kind: "conflict", message: `recovery preparation lineage for ${queueId} does not match the request` };
  }
  const receipt = receiptFor(input.route, input.specId, runId, taskId);
  if (!(await hasDurablePreparedSuccessor(client, input, runId, taskId))) {
    return { kind: "conflict", message: `prepared successor ${runId}/${taskId} is missing its exact durable rows` };
  }
  return { kind: "owned", receipt, newlyPrepared: false };
}

async function hasDurablePreparedSuccessor(
  client: PreparationClient,
  input: RecoveryPreparationInput,
  runId: string,
  taskId: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT r.run_id
       FROM runs r
       JOIN tasks t ON t.run_id = r.run_id AND t.org_id = r.org_id
      WHERE r.run_id = $1 AND r.org_id = $2 AND r.project_id = $3 AND r.spec_id = $4
        AND t.task_id = $5 AND t.kind = 'plan'
      LIMIT 1`,
    [runId, input.orgId, input.projectId, input.specId, taskId],
  );
  return result.rows[0] !== undefined;
}

function receiptFor(
  route: RecoveryPreparationRoute,
  specId: string,
  runId: string,
  plannerTaskId: string,
): ConflictRecoveryReceipt {
  return {
    kind: route.kind === "planner_replan" ? "planner_replan" : "writer_rework",
    specId,
    run: { kind: "enqueued", replanRunId: runId, plannerTaskId },
  };
}

function lineagePayload(
  input: RecoveryPreparationInput,
  runId: string,
  plannerTaskId: string,
): EventPayload<"recovery.replan_queued"> {
  return {
    runId: input.oldRunId,
    specId: input.specId,
    action: "replan_with_steering",
    steeringNote: input.steeringNote,
    replanRunId: runId,
    plannerTaskId,
  };
}

function expectedRoutePayload(input: RecoveryPreparationInput): object {
  const route = input.route;
  if (route.kind === "planner_replan") {
    return {
      specId: input.specId,
      ...(route.otherSpecId !== undefined && { otherSpecId: route.otherSpecId }),
      newContext: route.newContext,
      replanStatus: input.reopenStatus,
      conflictSignature: route.conflictSignature,
    };
  }
  return {
    integration: "native_queue",
    specId: input.specId,
    runId: input.oldRunId,
    prNumber: route.prNumber,
    disposition: "reworked",
    gateError: route.gateError,
    priorReworks: route.priorReworks,
  };
}

function expectedRouteEventType(route: RecoveryPreparationRoute): string {
  if (route.kind === "planner_replan") return "merge.conflict.replan_routed";
  return route.kind === "regate_writer_rework" ? "merge.regate.gate_rework_routed" : "merge.batch.gate_rework_routed";
}

function plannerRoutePayload(input: RecoveryPreparationInput): EventPayload<"merge.conflict.replan_routed"> {
  if (input.route.kind !== "planner_replan") throw new Error("planner route payload requested for writer recovery");
  return expectedRoutePayload(input) as EventPayload<"merge.conflict.replan_routed">;
}

function writerRoutePayload(
  input: RecoveryPreparationInput,
): EventPayload<"merge.regate.gate_rework_routed"> | EventPayload<"merge.batch.gate_rework_routed"> {
  if (input.route.kind === "planner_replan") throw new Error("writer route payload requested for planner recovery");
  return expectedRoutePayload(input) as
    | EventPayload<"merge.regate.gate_rework_routed">
    | EventPayload<"merge.batch.gate_rework_routed">;
}

async function appendRouteEvent(
  store: PgEventStore,
  input: RecoveryPreparationInput,
  idempotencyKey: string,
): Promise<boolean> {
  const base = {
    runId: input.oldRunId,
    specId: input.specId,
    projectId: input.projectId,
    orgId: input.orgId,
    idempotencyKey,
  };
  if (input.route.kind === "planner_replan") {
    return store.appendPriorIfAbsent({
      ...base,
      eventType: "merge.conflict.replan_routed",
      payload: plannerRoutePayload(input),
    });
  }
  return store.appendPriorIfAbsent({
    ...base,
    eventType:
      input.route.kind === "regate_writer_rework"
        ? "merge.regate.gate_rework_routed"
        : "merge.batch.gate_rework_routed",
    payload: writerRoutePayload(input),
  });
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left, objectKeysSorted) === JSON.stringify(right, objectKeysSorted);
}

function objectKeysSorted(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
  }
  return value;
}
