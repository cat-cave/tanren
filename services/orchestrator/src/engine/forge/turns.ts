// P2A-0019: Forge turn store. Turns are append-only, ordered within a
// thread, and carry a typed `ForgeAnswer` render payload. The append path
// validates the render against the P2A-0008 schema; readers receive an
// `unknown` they can re-parse if they need exhaustive type safety.
//
// Audience scoping: a turn carries a single `audience` value (the minimum
// scope required to read it). The list/get helpers filter rows the actor's
// scope cannot reach. This is a coarse-grained complement to P2A-0009 which
// redacts individual fields inside event payloads — Forge turns rendered
// for an org-admin audience are simply not visible to project-only members.

import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import { ForgeAnswer } from "../answerers/schemas/forge.js";
import { ForgeThreadStore } from "./threads.js";
import {
  ForgeTurnAppendInput,
  type ForgeTurnAudience,
  type ForgeTurnRow,
  type ForgeTurnSource
} from "./schemas.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

interface RawTurnRow {
  id: unknown;
  thread_id: unknown;
  turn_index: unknown;
  source: unknown;
  audience: unknown;
  author_kind: unknown;
  render: unknown;
  created_at: unknown;
}

const SELECT_TURN_COLUMNS = `
  id,
  thread_id,
  turn_index,
  source,
  audience,
  author_kind,
  render,
  created_at
`;

function decodeTurnRow(raw: RawTurnRow): ForgeTurnRow {
  const source = (typeof raw.source === "string" ? JSON.parse(raw.source) : raw.source) as ForgeTurnSource;
  const render = typeof raw.render === "string" ? JSON.parse(raw.render) : raw.render;
  return {
    id: String(raw.id),
    threadId: String(raw.thread_id),
    index: Number(raw.turn_index),
    source,
    audience: String(raw.audience) as ForgeTurnAudience,
    authorKind: String(raw.author_kind) as ForgeTurnRow["authorKind"],
    render,
    createdAt: raw.created_at as Date
  };
}

// The four audience tiers are ordered from least to most privileged. An
// actor can read a turn iff one of their scopes is at-or-above the turn's
// audience tier.
const AUDIENCE_ORDER: Record<ForgeTurnAudience, number> = {
  "project:member": 0,
  "project:admin": 1,
  "org:admin": 2,
  "platform:admin": 3
};

function actorAudienceTier(actor: ActorContext): number {
  if (actor.scopes.includes("platform:admin")) return AUDIENCE_ORDER["platform:admin"];
  if (actor.scopes.includes("org:admin")) return AUDIENCE_ORDER["org:admin"];
  if (actor.scopes.includes("project:admin")) return AUDIENCE_ORDER["project:admin"];
  if (actor.scopes.includes("org:member") || actor.scopes.includes("project:member")) {
    return AUDIENCE_ORDER["project:member"];
  }
  return -1;
}

export function actorCanViewAudience(actor: ActorContext, audience: ForgeTurnAudience): boolean {
  return actorAudienceTier(actor) >= AUDIENCE_ORDER[audience];
}

export const ForgeTurnStore = {
  async append(
    client: QueryClient,
    input: ForgeTurnAppendInput,
    actor: ActorContext
  ): Promise<ForgeTurnRow> {
    const parsed = ForgeTurnAppendInput.parse(input);
    // Touch the parent thread for authz — this throws if the actor can't
    // reach the thread's scope.
    const thread = await ForgeThreadStore.get(client, parsed.threadId, actor);
    if (thread === undefined) {
      throw new Error(`forge thread not found: ${parsed.threadId}`);
    }

    const id = parsed.id ?? `forge_turn_${randomUUID()}`;
    // The render payload is validated against ForgeAnswer at the input
    // layer; re-parse defensively to ensure no callers bypass validation
    // by typing render as `unknown`.
    const validatedRender = ForgeAnswer.parse(parsed.render);

    // Compute the next index atomically. Postgres unique constraint on
    // (thread_id, turn_index) is the backstop; if two writers race the
    // second one's INSERT will fail and the caller can retry.
    const nextIndexResult = await client.query<{ next_index: number | string | null }>(
      `SELECT COALESCE(MAX(turn_index), -1) + 1 AS next_index
       FROM forge_turns WHERE thread_id = $1`,
      [parsed.threadId]
    );
    const nextIndex = Number(nextIndexResult.rows[0]?.next_index ?? 0);

    const result = await client.query(
      `INSERT INTO forge_turns
         (id, thread_id, turn_index, source, audience, author_kind, render)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb)
       RETURNING ${SELECT_TURN_COLUMNS}`,
      [
        id,
        parsed.threadId,
        nextIndex,
        JSON.stringify(parsed.source),
        parsed.audience,
        parsed.authorKind,
        JSON.stringify(validatedRender)
      ]
    );
    await ForgeThreadStore.touch(client, parsed.threadId);
    return decodeTurnRow(result.rows[0] as RawTurnRow);
  },

  async list(
    client: QueryClient,
    args: { threadId: string; limit?: number; sinceIndex?: number },
    actor: ActorContext
  ): Promise<ForgeTurnRow[]> {
    const thread = await ForgeThreadStore.get(client, args.threadId, actor);
    if (thread === undefined) {
      throw new Error(`forge thread not found: ${args.threadId}`);
    }
    const limit = args.limit ?? 100;
    const sinceIndex = args.sinceIndex ?? -1;
    const result = await client.query(
      `SELECT ${SELECT_TURN_COLUMNS} FROM forge_turns
       WHERE thread_id = $1 AND turn_index > $2
       ORDER BY turn_index ASC
       LIMIT $3`,
      [args.threadId, sinceIndex, limit]
    );
    const rows = result.rows.map((row) => decodeTurnRow(row as RawTurnRow));
    return rows.filter((row) => actorCanViewAudience(actor, row.audience));
  },

  async get(
    client: QueryClient,
    turnId: string,
    actor: ActorContext
  ): Promise<ForgeTurnRow | undefined> {
    const result = await client.query(
      `SELECT ${SELECT_TURN_COLUMNS} FROM forge_turns WHERE id = $1`,
      [turnId]
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    const turn = decodeTurnRow(row as RawTurnRow);
    // Validate the actor can reach the parent thread's scope.
    const thread = await ForgeThreadStore.get(client, turn.threadId, actor);
    if (thread === undefined) {
      // get already throws when the actor cannot reach the thread.
      return undefined;
    }
    if (!actorCanViewAudience(actor, turn.audience)) {
      return undefined;
    }
    return turn;
  }
} as const;
