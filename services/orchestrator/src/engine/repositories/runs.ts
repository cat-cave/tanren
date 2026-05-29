import type pg from "pg";
import { z } from "zod";
import type { ActorRef } from "../state/actor.js";
import { RunOutcome, RunStatus, transitionRun } from "../state/run.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

export const RunRow = z.object({
  runId: z.string(),
  specId: z.string(),
  projectId: z.string(),
  trigger: z.string(),
  branch: z.string(),
  status: RunStatus,
  outcome: RunOutcome.nullable(),
  prUrl: z.string().nullable(),
  startedAt: z.date(),
  endedAt: z.date().nullable(),
  orgId: z.string(),
  userId: z.string().nullable(),
});
export type RunRow = z.infer<typeof RunRow>;

interface RawRunRow {
  run_id: unknown;
  spec_id: unknown;
  project_id: unknown;
  trigger: unknown;
  branch: unknown;
  status: unknown;
  outcome: unknown;
  pr_url: unknown;
  started_at: unknown;
  ended_at: unknown;
  org_id: unknown;
  user_id: unknown;
}

const SELECT_RUN_COLUMNS = `
  run_id,
  spec_id,
  project_id,
  trigger,
  branch,
  status,
  outcome,
  pr_url,
  started_at,
  ended_at,
  org_id,
  user_id
`;

function decodeRunRow(raw: RawRunRow): RunRow {
  return RunRow.parse({
    runId: raw.run_id,
    specId: raw.spec_id,
    projectId: raw.project_id,
    trigger: raw.trigger,
    branch: raw.branch,
    status: raw.status,
    outcome: raw.outcome,
    prUrl: raw.pr_url,
    startedAt: raw.started_at,
    endedAt: raw.ended_at,
    orgId: raw.org_id,
    userId: raw.user_id,
  });
}

export const RunStore = {
  async get(client: QueryClient, runId: string, _actor: ActorRef): Promise<RunRow | undefined> {
    const result = await client.query(`SELECT ${SELECT_RUN_COLUMNS} FROM runs WHERE run_id = $1`, [runId]);
    const row = result.rows[0];
    if (row === undefined) {
      return undefined;
    }
    return decodeRunRow(row as RawRunRow);
  },

  async list(client: QueryClient, filter: { projectId?: string } | undefined, _actor: ActorRef): Promise<RunRow[]> {
    const projectId = filter?.projectId;
    const result =
      projectId === undefined
        ? await client.query(`SELECT ${SELECT_RUN_COLUMNS} FROM runs ORDER BY started_at DESC`)
        : await client.query(`SELECT ${SELECT_RUN_COLUMNS} FROM runs WHERE project_id = $1 ORDER BY started_at DESC`, [
            projectId,
          ]);
    return result.rows.map((row) => decodeRunRow(row as RawRunRow));
  },

  async updateStatus(
    client: QueryClient,
    runId: string,
    next: {
      from: z.infer<typeof RunStatus>;
      to: z.infer<typeof RunStatus>;
      outcome?: z.infer<typeof RunOutcome>;
      setEndedAt?: boolean;
    },
    _actor: ActorRef,
  ): Promise<RunRow> {
    transitionRun(next.from, next.to);
    const params: unknown[] = [runId, next.to];
    let setOutcome = "";
    if (next.outcome !== undefined) {
      params.push(next.outcome);
      setOutcome = `, outcome = $${params.length}`;
    }
    const setEnded = next.setEndedAt === true ? ", ended_at = now()" : "";
    const result = await client.query(
      `UPDATE runs SET status = $2${setOutcome}${setEnded} WHERE run_id = $1 RETURNING ${SELECT_RUN_COLUMNS}`,
      params,
    );
    if (result.rows.length === 0) {
      throw new Error(`run not found: ${runId}`);
    }
    return decodeRunRow(result.rows[0] as RawRunRow);
  },
} as const;
