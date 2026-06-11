// write-action approval: the Forge action-proposal store.
//
// A Forge answerer PROPOSES a write on its final turn; the conversation engine
// persists each proposal here as `pending` and never executes it. A human
// approves/rejects it through the approve/reject routes, which re-validate and
// authz the APPROVING operator against the underlying write before executing.
//
// Status lifecycle (in-place updates on the row — append-friendly, never a
// rewrite): pending → approved → executed | failed, or pending → rejected.
// Decisions are idempotent: once a proposal leaves `pending` it cannot be
// decided again (the decide helper throws `ProposalAlreadyDecidedError`, which
// the route maps to a typed 409 — so a double-approve never double-executes).
//
// org scoping mirrors the thread store: the parent thread's authz is the gate
// (the store loads the thread through `ForgeThreadStore.get`, which throws when
// the actor cannot reach it), and org_id is persisted + indexed per the
// migration-0026 tenancy pattern.

import { randomUUID } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import { resolveWritableClient } from "../data/orgScopedDb.js";
import { requireRow } from "../data/pgRows.js";
import { ForgeProposedAction, type ForgeWriteToolCall } from "../answerers/schemas/forge.js";
import { ForgeThreadStore } from "./threads.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

export const ForgeProposalStatus = z.enum(["pending", "approved", "rejected", "executed", "failed"]);
export type ForgeProposalStatus = z.infer<typeof ForgeProposalStatus>;

export const ForgeActionProposalRow = z
  .object({
    id: z.string().min(1),
    orgId: z.string().min(1),
    threadId: z.string().min(1),
    proposingTurnId: z.string().min(1),
    toolName: z.string().min(1),
    // The validated ForgeWriteToolCall args the underlying write executes with.
    args: z.record(z.string(), z.unknown()),
    rationale: z.string().min(1),
    status: ForgeProposalStatus,
    proposedAt: z.date(),
    decidedBy: z.string().min(1).nullable(),
    decidedAt: z.date().nullable(),
    result: z.unknown().nullable(),
    error: z.string().nullable(),
  })
  .strict();
export type ForgeActionProposalRow = z.infer<typeof ForgeActionProposalRow>;

export class ProposalNotFoundError extends Error {
  constructor(proposalId: string) {
    super(`forge action proposal not found: ${proposalId}`);
  }
}

// Thrown when a proposal that has already left `pending` is decided again.
// Carries the current status so the route can render an idempotent 409.
export class ProposalAlreadyDecidedError extends Error {
  constructor(
    readonly proposalId: string,
    readonly currentStatus: ForgeProposalStatus,
  ) {
    super(`forge action proposal ${proposalId} already decided: ${currentStatus}`);
  }
}

interface RawProposalRow {
  id: unknown;
  org_id: unknown;
  thread_id: unknown;
  proposing_turn_id: unknown;
  tool_name: unknown;
  args: unknown;
  rationale: unknown;
  status: unknown;
  proposed_at: unknown;
  decided_by: unknown;
  decided_at: unknown;
  result: unknown;
  error: unknown;
}

const SELECT_COLUMNS = `
  id,
  org_id,
  thread_id,
  proposing_turn_id,
  tool_name,
  args,
  rationale,
  status,
  proposed_at,
  decided_by,
  decided_at,
  result,
  error
`;

// A jsonb cell round-trips as either a JSON string or an already-parsed value;
// parse the string form so an unparseable cell THROWS at the boundary.
function parseJsonbCell(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}
const jsonbCell = z.preprocess(parseJsonbCell, z.unknown());

// audit RC-6 trust-at-boundary: decode the raw `forge_action_proposals` row
// through Zod instead of `... as Date` / `parseJsonb(...) as Record` casts. A bad
// status enum, a non-coercible timestamp, or a non-object args cell THROWS at
// `.parse` rather than laundering an untrusted DB row into the typed shape.
const ForgeActionProposalRowDecode = z
  .object({
    id: z.coerce.string().min(1),
    org_id: z.coerce.string().min(1),
    thread_id: z.coerce.string().min(1),
    proposing_turn_id: z.coerce.string().min(1),
    tool_name: z.coerce.string().min(1),
    args: jsonbCell.pipe(z.record(z.string(), z.unknown())),
    rationale: z.coerce.string().min(1),
    status: ForgeProposalStatus,
    proposed_at: z.coerce.date(),
    decided_by: z.coerce.string().min(1).nullish(),
    decided_at: z.coerce.date().nullish(),
    result: jsonbCell.nullish(),
    error: z.coerce.string().nullish(),
  })
  .transform(
    (row): ForgeActionProposalRow => ({
      id: row.id,
      orgId: row.org_id,
      threadId: row.thread_id,
      proposingTurnId: row.proposing_turn_id,
      toolName: row.tool_name,
      args: row.args,
      rationale: row.rationale,
      status: row.status,
      proposedAt: row.proposed_at,
      decidedBy: row.decided_by ?? null,
      decidedAt: row.decided_at ?? null,
      result: row.result ?? null,
      error: row.error ?? null,
    }),
  );

function decodeRow(raw: RawProposalRow): ForgeActionProposalRow {
  return ForgeActionProposalRowDecode.parse(raw);
}

// Reconstructs the typed ForgeWriteToolCall from a persisted row so the
// decide path re-validates the args before executing the write.
export function toolCallForProposal(row: ForgeActionProposalRow): ForgeWriteToolCall {
  return ForgeProposedAction.parse({ toolCall: { tool: row.toolName, args: row.args }, rationale: row.rationale })
    .toolCall;
}

export interface CreateProposalInput {
  orgId: string;
  threadId: string;
  proposingTurnId: string;
  toolCall: ForgeWriteToolCall;
  rationale: string;
}

// RLS R2 cohort-4 (forge): proposal reads/writes route through
// `resolveWritableClient`, same seam as the thread/turn stores. Thread-store
// authz calls below receive the ORIGINAL client and resolve the seam
// themselves, reaching the same ambient scoped client when one is open.
export const ForgeProposalStore = {
  // Persist a proposed action as `pending`. The conversation engine calls this
  // per proposed action on the final answer; it never executes the write.
  async create(client: QueryClient, input: CreateProposalInput): Promise<ForgeActionProposalRow> {
    const id = `forge_proposal_${randomUUID()}`;
    const db = resolveWritableClient(client);
    const result = await db.query<RawProposalRow>(
      `INSERT INTO forge_action_proposals
         (id, org_id, thread_id, proposing_turn_id, tool_name, args, rationale, status)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 'pending')
       RETURNING ${SELECT_COLUMNS}`,
      [
        id,
        input.orgId,
        input.threadId,
        input.proposingTurnId,
        input.toolCall.tool,
        JSON.stringify(input.toolCall.args),
        input.rationale,
      ],
    );
    return decodeRow(requireRow(result.rows[0], "forge proposal insert"));
  },

  // Fetch a proposal, gating on the parent thread's authz (throws when the
  // actor cannot reach the thread). Returns undefined for an unknown id.
  async get(client: QueryClient, proposalId: string, actor: ActorContext): Promise<ForgeActionProposalRow | undefined> {
    const db = resolveWritableClient(client);
    const result = await db.query<RawProposalRow>(
      `SELECT ${SELECT_COLUMNS} FROM forge_action_proposals WHERE id = $1`,
      [proposalId],
    );
    const raw = result.rows[0];
    if (raw === undefined) return undefined;
    const row = decodeRow(raw);
    // Authz: loading the parent thread throws if the actor cannot reach it.
    await ForgeThreadStore.get(client, row.threadId, actor);
    return row;
  },

  // The proposals attached to a thread, newest-first. Gated on thread authz.
  async listForThread(client: QueryClient, threadId: string, actor: ActorContext): Promise<ForgeActionProposalRow[]> {
    await ForgeThreadStore.get(client, threadId, actor);
    const db = resolveWritableClient(client);
    const result = await db.query<RawProposalRow>(
      `SELECT ${SELECT_COLUMNS} FROM forge_action_proposals
       WHERE thread_id = $1
       ORDER BY proposed_at DESC`,
      [threadId],
    );
    return result.rows.map((raw) => decodeRow(raw));
  },

  // Idempotently claim a pending proposal for a decision. Uses a conditional
  // UPDATE so two concurrent deciders cannot both transition the row: only the
  // first `WHERE status = 'pending'` update succeeds. When the row is already
  // decided, re-reads it and throws `ProposalAlreadyDecidedError` so the caller
  // returns a 409 rather than double-executing the write.
  async claimForDecision(
    client: QueryClient,
    proposalId: string,
    decision: "approved" | "rejected",
    actor: ActorContext,
  ): Promise<ForgeActionProposalRow> {
    // Authz first: this throws if the actor cannot reach the thread.
    const existing = await this.get(client, proposalId, actor);
    if (existing === undefined) {
      throw new ProposalNotFoundError(proposalId);
    }
    if (existing.status !== "pending") {
      throw new ProposalAlreadyDecidedError(proposalId, existing.status);
    }
    const db = resolveWritableClient(client);
    const result = await db.query<RawProposalRow>(
      `UPDATE forge_action_proposals
         SET status = $2, decided_by = $3, decided_at = NOW()
       WHERE id = $1 AND status = 'pending'
       RETURNING ${SELECT_COLUMNS}`,
      [proposalId, decision, actor.userId],
    );
    const raw = result.rows[0];
    if (raw === undefined) {
      // Lost the race: another decider claimed it between our read and update.
      const current = await this.get(client, proposalId, actor);
      throw new ProposalAlreadyDecidedError(proposalId, current?.status ?? "approved");
    }
    return decodeRow(raw);
  },

  // Record the outcome of an approved proposal's write. `executed` on success
  // (persists the write's return value), `failed` on a thrown write (persists
  // the error message). Only advances a row already in `approved`.
  async recordOutcome(
    client: QueryClient,
    proposalId: string,
    outcome: { status: "executed"; result: unknown } | { status: "failed"; error: string },
  ): Promise<ForgeActionProposalRow> {
    const db = resolveWritableClient(client);
    const result = await db.query<RawProposalRow>(
      `UPDATE forge_action_proposals
         SET status = $2, result = $3::jsonb, error = $4
       WHERE id = $1
       RETURNING ${SELECT_COLUMNS}`,
      [
        proposalId,
        outcome.status,
        outcome.status === "executed" ? JSON.stringify(outcome.result ?? null) : null,
        outcome.status === "failed" ? outcome.error : null,
      ],
    );
    return decodeRow(requireRow(result.rows[0], "forge proposal recordOutcome"));
  },
} as const;
