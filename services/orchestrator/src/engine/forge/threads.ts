// Forge thread store. Threads are scoped to org / project / run
// and are the parent for an ordered append-only sequence of turns. The
// store is intentionally thin — the heavier per-turn logic (redaction on
// read, schema validation on append) lives in `turns.ts`.

import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import { resolveWritableClient } from "../data/orgScopedDb.js";
import { ForgeThreadCreateInput, type ForgeThreadRow, type ForgeThreadScope } from "./schemas.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

interface RawThreadRow {
  id: unknown;
  org_id: unknown;
  project_id: unknown;
  run_id: unknown;
  scope: unknown;
  title: unknown;
  created_at: unknown;
  updated_at: unknown;
  closed_at: unknown;
}

const SELECT_THREAD_COLUMNS = `
  id,
  org_id,
  project_id,
  run_id,
  scope,
  title,
  created_at,
  updated_at,
  closed_at
`;

function decodeThreadRow(raw: RawThreadRow): ForgeThreadRow {
  return {
    id: String(raw.id),
    orgId: String(raw.org_id),
    projectId: raw.project_id === null || raw.project_id === undefined ? null : String(raw.project_id),
    runId: raw.run_id === null || raw.run_id === undefined ? null : String(raw.run_id),
    scope: String(raw.scope) as ForgeThreadScope,
    title: raw.title === null || raw.title === undefined ? null : String(raw.title),
    createdAt: raw.created_at as Date,
    updatedAt: raw.updated_at as Date,
    closedAt: raw.closed_at === null || raw.closed_at === undefined ? null : (raw.closed_at as Date),
  };
}

export class ForgeThreadAccessDeniedError extends Error {
  constructor(threadId: string) {
    super(`actor cannot access forge thread: ${threadId}`);
  }
}

function assertActorReachesScope(actor: ActorContext, orgId: string, projectId: string | null): void {
  if (actor.scopes.includes("platform:admin")) return;
  if (actor.orgId === orgId && (actor.scopes.includes("org:admin") || actor.scopes.includes("org:member"))) {
    return;
  }
  if (projectId !== null && actor.projectId === projectId) {
    return;
  }
  throw new Error(`actor ${actor.userId} cannot reach org ${orgId} project ${projectId ?? "<none>"}`);
}

// RLS R2 cohort-4 (forge): every store method routes its query through
// `resolveWritableClient` so a tenant-table read/write joins the ambient
// org-scoped transaction when a `runWithOrgScope` scope is open (the forge
// routes/bundle open one), and falls back to the handed pool when none is —
// inert in R1 (no policies read `app.current_org_id`), behavior-identical to
// the pre-cohort pool path. A handed-in client (a caller that already owns a
// transaction, or a unit-test memory client) is used verbatim.
export const ForgeThreadStore = {
  async create(client: QueryClient, input: ForgeThreadCreateInput, actor: ActorContext): Promise<ForgeThreadRow> {
    const parsed = ForgeThreadCreateInput.parse(input);
    assertActorReachesScope(actor, parsed.orgId, parsed.projectId);
    const id = parsed.id ?? `forge_thread_${randomUUID()}`;
    const db = resolveWritableClient(client);
    const result = await db.query(
      `INSERT INTO forge_threads (id, org_id, project_id, run_id, scope, title)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${SELECT_THREAD_COLUMNS}`,
      [id, parsed.orgId, parsed.projectId, parsed.runId, parsed.scope, parsed.title],
    );
    return decodeThreadRow(result.rows[0] as RawThreadRow);
  },

  async get(client: QueryClient, threadId: string, actor: ActorContext): Promise<ForgeThreadRow | undefined> {
    const db = resolveWritableClient(client);
    const result = await db.query(`SELECT ${SELECT_THREAD_COLUMNS} FROM forge_threads WHERE id = $1`, [threadId]);
    const row = result.rows[0];
    if (row === undefined) return undefined;
    const thread = decodeThreadRow(row as RawThreadRow);
    try {
      assertActorReachesScope(actor, thread.orgId, thread.projectId);
    } catch {
      throw new ForgeThreadAccessDeniedError(thread.id);
    }
    return thread;
  },

  async listForProject(
    client: QueryClient,
    args: { orgId: string; projectId: string },
    actor: ActorContext,
  ): Promise<ForgeThreadRow[]> {
    assertActorReachesScope(actor, args.orgId, args.projectId);
    const db = resolveWritableClient(client);
    const result = await db.query(
      `SELECT ${SELECT_THREAD_COLUMNS} FROM forge_threads
       WHERE org_id = $1 AND project_id = $2
       ORDER BY updated_at DESC`,
      [args.orgId, args.projectId],
    );
    return result.rows.map((row) => decodeThreadRow(row as RawThreadRow));
  },

  async listForRun(
    client: QueryClient,
    args: { orgId: string; projectId: string; runId: string },
    actor: ActorContext,
  ): Promise<ForgeThreadRow[]> {
    assertActorReachesScope(actor, args.orgId, args.projectId);
    const db = resolveWritableClient(client);
    const result = await db.query(
      `SELECT ${SELECT_THREAD_COLUMNS} FROM forge_threads
       WHERE org_id = $1 AND project_id = $2 AND run_id = $3
       ORDER BY updated_at DESC`,
      [args.orgId, args.projectId, args.runId],
    );
    return result.rows.map((row) => decodeThreadRow(row as RawThreadRow));
  },

  async touch(client: QueryClient, threadId: string): Promise<void> {
    const db = resolveWritableClient(client);
    await db.query(`UPDATE forge_threads SET updated_at = NOW() WHERE id = $1`, [threadId]);
  },

  async close(client: QueryClient, threadId: string, actor: ActorContext): Promise<ForgeThreadRow> {
    const thread = await this.get(client, threadId, actor);
    if (thread === undefined) {
      throw new Error(`forge thread not found: ${threadId}`);
    }
    const db = resolveWritableClient(client);
    const result = await db.query(
      `UPDATE forge_threads SET closed_at = NOW(), updated_at = NOW()
       WHERE id = $1
       RETURNING ${SELECT_THREAD_COLUMNS}`,
      [threadId],
    );
    return decodeThreadRow(result.rows[0] as RawThreadRow);
  },
} as const;
