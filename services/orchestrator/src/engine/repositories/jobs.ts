import type pg from "pg";
import { z } from "zod";
import type { ActorRef } from "../state/actor.js";
import { JobKind, JobStatus, transitionJob } from "../state/job.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

export const JobRow = z.object({
  id: z.string(),
  runId: z.string().nullable(),
  taskId: z.string().nullable(),
  taskKind: JobKind,
  status: JobStatus,
  attempts: z.number(),
  failureKind: z.string().nullable(),
  failureMessage: z.string().nullable(),
  tenantId: z.string().nullable(),
  userId: z.string().nullable()
});
export type JobRow = z.infer<typeof JobRow>;

interface RawJobRow {
  id: unknown;
  run_id: unknown;
  task_id: unknown;
  task_kind: unknown;
  status: unknown;
  attempts: unknown;
  failure_kind: unknown;
  failure_message: unknown;
  tenant_id: unknown;
  user_id: unknown;
}

const SELECT_JOB_COLUMNS = `
  id::text AS id,
  run_id,
  task_id,
  task_kind,
  status,
  attempts,
  failure_kind,
  failure_message,
  tenant_id,
  user_id
`;

function decodeJobRow(raw: RawJobRow): JobRow {
  return JobRow.parse({
    id: typeof raw.id === "string" ? raw.id : String(raw.id),
    runId: raw.run_id,
    taskId: raw.task_id,
    taskKind: raw.task_kind,
    status: raw.status,
    attempts: typeof raw.attempts === "number" ? raw.attempts : Number(raw.attempts),
    failureKind: raw.failure_kind,
    failureMessage: raw.failure_message,
    tenantId: raw.tenant_id,
    userId: raw.user_id
  });
}

export const JobStore = {
  async get(client: QueryClient, id: string, _actor: ActorRef): Promise<JobRow | undefined> {
    const result = await client.query(`SELECT ${SELECT_JOB_COLUMNS} FROM job_queue WHERE id = $1`, [id]);
    const row = result.rows[0];
    if (row === undefined) {
      return undefined;
    }
    return decodeJobRow(row as RawJobRow);
  },

  async list(
    client: QueryClient,
    filter: { runId?: string; taskKind?: z.infer<typeof JobKind>; status?: z.infer<typeof JobStatus> } | undefined,
    _actor: ActorRef
  ): Promise<JobRow[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter?.runId !== undefined) {
      params.push(filter.runId);
      clauses.push(`run_id = $${params.length}`);
    }
    if (filter?.taskKind !== undefined) {
      params.push(filter.taskKind);
      clauses.push(`task_kind = $${params.length}`);
    }
    if (filter?.status !== undefined) {
      params.push(filter.status);
      clauses.push(`status = $${params.length}`);
    }
    const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    const result = await client.query(`SELECT ${SELECT_JOB_COLUMNS} FROM job_queue${where} ORDER BY enqueued_at`, params);
    return result.rows.map((row) => decodeJobRow(row as RawJobRow));
  },

  async updateStatus(
    client: QueryClient,
    id: string,
    next: { from: z.infer<typeof JobStatus>; to: z.infer<typeof JobStatus>; failureKind?: string; failureMessage?: string; setEndedAt?: boolean },
    _actor: ActorRef
  ): Promise<JobRow> {
    transitionJob(next.from, next.to);
    const sets: string[] = ["status = $2"];
    const params: unknown[] = [id, next.to];
    if (next.failureKind !== undefined) {
      params.push(next.failureKind);
      sets.push(`failure_kind = $${params.length}`);
    }
    if (next.failureMessage !== undefined) {
      params.push(next.failureMessage);
      sets.push(`failure_message = $${params.length}`);
    }
    if (next.setEndedAt === true) {
      sets.push("ended_at = now()");
    }
    const result = await client.query(
      `UPDATE job_queue SET ${sets.join(", ")} WHERE id = $1 RETURNING ${SELECT_JOB_COLUMNS}`,
      params
    );
    if (result.rows.length === 0) {
      throw new Error(`job not found: ${id}`);
    }
    return decodeJobRow(result.rows[0] as RawJobRow);
  }
} as const;
