// cspell:ignore sorigin
// bh-2 — normalized, append-only provenance for specs opened from an IssueLoop.
// Callers hand this store an org-scoped client; the explicit org/project
// predicates remain a defense in depth against an accidental cross-tenant read.

import { randomUUID } from "node:crypto";
import type pg from "pg";
import { z } from "zod";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

export const SPEC_ORIGIN_ROLES = ["primary_fix", "repair", "rollback", "probe_capability", "followup"] as const;
export type SpecOriginRole = (typeof SPEC_ORIGIN_ROLES)[number];

const SpecOriginRole = z.enum(SPEC_ORIGIN_ROLES);

export const SpecOriginRow = z.object({
  orgId: z.string().min(1),
  projectId: z.string().min(1),
  id: z.string().min(1),
  specId: z.string().min(1),
  issueLoopId: z.string().min(1),
  triageTaskId: z.string().min(1),
  attemptNumber: z.number().int().min(1),
  role: SpecOriginRole,
  ordinal: z.number().int().min(0),
  createdAt: z.date(),
});
export type SpecOriginRow = z.infer<typeof SpecOriginRow>;

export interface SpecOriginWithFindings extends SpecOriginRow {
  sourceFindingIds: string[];
}

interface RawSpecOriginRow {
  org_id: unknown;
  project_id: unknown;
  id: unknown;
  spec_id: unknown;
  issue_loop_id: unknown;
  triage_task_id: unknown;
  attempt_number: unknown;
  role: unknown;
  ordinal: unknown;
  created_at: unknown;
  source_finding_ids?: unknown;
}

const COLUMNS = `
  so.org_id, so.project_id, so.id, so.spec_id, so.issue_loop_id,
  so.triage_task_id, so.attempt_number, so.role, so.ordinal, so.created_at,
  COALESCE(array_agg(sof.source_finding_id ORDER BY sof.source_finding_id)
    FILTER (WHERE sof.source_finding_id IS NOT NULL), '{}'::text[]) AS source_finding_ids
`;

function decode(row: RawSpecOriginRow): SpecOriginWithFindings {
  const origin = SpecOriginRow.parse({
    orgId: row.org_id,
    projectId: row.project_id,
    id: row.id,
    specId: row.spec_id,
    issueLoopId: row.issue_loop_id,
    triageTaskId: row.triage_task_id,
    attemptNumber: Number(row.attempt_number),
    role: row.role,
    ordinal: Number(row.ordinal),
    createdAt: row.created_at,
  });
  const sourceFindingIds = z.array(z.string()).parse(row.source_finding_ids ?? []);
  return { ...origin, sourceFindingIds };
}

export interface RecordSpecOriginInput {
  orgId: string;
  projectId: string;
  specId: string;
  issueLoopId: string;
  triageTaskId: string;
  attemptNumber: number;
  role: SpecOriginRole;
  ordinal: number;
  sourceFindingIds: ReadonlyArray<string>;
}

async function selectOrigin(
  client: QueryClient,
  where: string,
  params: ReadonlyArray<unknown>,
): Promise<SpecOriginWithFindings | undefined> {
  const result = await client.query<RawSpecOriginRow>(
    `SELECT ${COLUMNS}
       FROM spec_origins so
       LEFT JOIN spec_origin_findings sof
         ON sof.org_id = so.org_id AND sof.spec_id = so.spec_id
      WHERE ${where}
      GROUP BY so.org_id, so.project_id, so.id, so.spec_id, so.issue_loop_id,
               so.triage_task_id, so.attempt_number, so.role, so.ordinal, so.created_at`,
    [...params],
  );
  return result.rows[0] === undefined ? undefined : decode(result.rows[0]);
}

export const SpecOriginStore = {
  /** Append one origin and its immutable finding links. There is no update/delete API. */
  async record(client: QueryClient, input: RecordSpecOriginInput): Promise<SpecOriginWithFindings> {
    const id = `sorigin_${randomUUID()}`;
    const result = await client.query<RawSpecOriginRow>(
      `INSERT INTO spec_origins
         (org_id, project_id, id, spec_id, issue_loop_id, triage_task_id,
          attempt_number, role, ordinal)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING org_id, project_id, id, spec_id, issue_loop_id, triage_task_id,
                 attempt_number, role, ordinal, created_at`,
      [
        input.orgId,
        input.projectId,
        id,
        input.specId,
        input.issueLoopId,
        input.triageTaskId,
        input.attemptNumber,
        input.role,
        input.ordinal,
      ],
    );
    await client.query(
      `INSERT INTO spec_origin_findings (org_id, spec_id, source_finding_id)
       SELECT $1, $2, finding_id
         FROM unnest($3::text[]) AS finding_id
       ON CONFLICT DO NOTHING`,
      [input.orgId, input.specId, [...new Set(input.sourceFindingIds)]],
    );
    return (await selectOrigin(client, "so.org_id = $1 AND so.project_id = $2 AND so.id = $3", [
      input.orgId,
      input.projectId,
      result.rows[0]!.id,
    ]))!;
  },

  async get(
    client: QueryClient,
    orgId: string,
    projectId: string,
    originId: string,
  ): Promise<SpecOriginWithFindings | undefined> {
    return selectOrigin(client, "so.org_id = $1 AND so.project_id = $2 AND so.id = $3", [orgId, projectId, originId]);
  },

  async listByIssueLoop(
    client: QueryClient,
    orgId: string,
    projectId: string,
    issueLoopId: string,
  ): Promise<SpecOriginWithFindings[]> {
    const result = await client.query<RawSpecOriginRow>(
      `SELECT ${COLUMNS}
         FROM spec_origins so
         LEFT JOIN spec_origin_findings sof
           ON sof.org_id = so.org_id AND sof.spec_id = so.spec_id
        WHERE so.org_id = $1 AND so.project_id = $2 AND so.issue_loop_id = $3
        GROUP BY so.org_id, so.project_id, so.id, so.spec_id, so.issue_loop_id,
                 so.triage_task_id, so.attempt_number, so.role, so.ordinal, so.created_at
        ORDER BY so.attempt_number, so.ordinal, so.id`,
      [orgId, projectId, issueLoopId],
    );
    return result.rows.map(decode);
  },
};
