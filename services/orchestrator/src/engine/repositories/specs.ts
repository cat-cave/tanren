import type pg from "pg";
import { z } from "zod";
import type { ActorRef } from "../state/actor.js";
import { SpecPriority, SpecStatus, transitionSpec } from "../state/spec.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

export const SpecRow = z.object({
  specId: z.string(),
  projectId: z.string(),
  title: z.string(),
  description: z.string(),
  acceptanceCriteria: z.array(z.string()),
  dependsOn: z.array(z.string()),
  status: SpecStatus,
  priority: SpecPriority,
  orgId: z.string(),
});
export type SpecRow = z.infer<typeof SpecRow>;

interface RawSpecRow {
  spec_id: unknown;
  project_id: unknown;
  title: unknown;
  description: unknown;
  acceptance_criteria: unknown;
  depends_on: unknown;
  status: unknown;
  priority: unknown;
  org_id: unknown;
}

const SELECT_SPEC_COLUMNS = `
  spec_id,
  project_id,
  title,
  description,
  acceptance_criteria,
  depends_on,
  status,
  priority,
  org_id
`;

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function decodeSpecRow(raw: RawSpecRow): SpecRow {
  return SpecRow.parse({
    specId: raw.spec_id,
    projectId: raw.project_id,
    title: raw.title,
    description: raw.description,
    acceptanceCriteria: asStringArray(raw.acceptance_criteria),
    dependsOn: asStringArray(raw.depends_on),
    status: raw.status,
    priority: raw.priority,
    orgId: raw.org_id,
  });
}

export const SpecStore = {
  async get(client: QueryClient, specId: string, _actor: ActorRef): Promise<SpecRow | undefined> {
    const result = await client.query<RawSpecRow>(`SELECT ${SELECT_SPEC_COLUMNS} FROM specs WHERE spec_id = $1`, [
      specId,
    ]);
    const row = result.rows[0];
    if (row === undefined) {
      return undefined;
    }
    return decodeSpecRow(row);
  },

  async list(client: QueryClient, filter: { projectId?: string } | undefined, _actor: ActorRef): Promise<SpecRow[]> {
    const projectId = filter?.projectId;
    const result =
      projectId === undefined
        ? await client.query<RawSpecRow>(`SELECT ${SELECT_SPEC_COLUMNS} FROM specs ORDER BY spec_id`)
        : await client.query<RawSpecRow>(
            `SELECT ${SELECT_SPEC_COLUMNS} FROM specs WHERE project_id = $1 ORDER BY spec_id`,
            [projectId],
          );
    return result.rows.map((row) => decodeSpecRow(row));
  },

  /**
   * Run-detail spec header constrained by the authorized run's
   * `(orgId, projectId, specId)`. Specs RLS is org-only, so the project
   * predicate is mandatory to prevent same-org cross-project title leaks.
   * Returns undefined when the triple does not bind (gone, wrong project, or
   * RLS-denied) — the route fails non-200 rather than inventing a card.
   */
  async selectSummaryHeader(
    client: QueryClient,
    args: { specId: string; projectId: string; orgId: string },
    _actor: ActorRef,
  ): Promise<{ spec_id: string; title: string; description: string } | undefined> {
    const result = await client.query<{ spec_id: string; title: string; description: string }>(
      "SELECT spec_id, title, description FROM specs WHERE spec_id = $1 AND project_id = $2 AND org_id = $3",
      [args.specId, args.projectId, args.orgId],
    );
    return result.rows[0];
  },

  /**
   * Behavior ids attached to a same-org/same-project spec. Genuine empty is
   * valid; relation/DB failure must surface to the caller (no soft fallback).
   */
  async selectBehaviorIds(
    client: QueryClient,
    args: { specId: string; projectId: string; orgId: string },
    _actor: ActorRef,
  ): Promise<string[]> {
    const result = await client.query<{ behavior_id: string }>(
      `SELECT sb.behavior_id
         FROM spec_behaviors sb
         INNER JOIN specs s ON s.spec_id = sb.spec_id
        WHERE sb.spec_id = $1 AND s.project_id = $2 AND s.org_id = $3
        ORDER BY sb.behavior_id`,
      [args.specId, args.projectId, args.orgId],
    );
    return result.rows.map((row) => row.behavior_id);
  },

  /**
   * The spec's milestone id when the triple binds. Empty association is null;
   * relation/DB failure surfaces to the caller.
   */
  async selectMilestoneId(
    client: QueryClient,
    args: { specId: string; projectId: string; orgId: string },
    _actor: ActorRef,
  ): Promise<string | null> {
    const result = await client.query<{ milestone_id: string }>(
      `SELECT sm.milestone_id
         FROM spec_milestones sm
         INNER JOIN specs s ON s.spec_id = sm.spec_id
        WHERE sm.spec_id = $1 AND s.project_id = $2 AND s.org_id = $3
        LIMIT 1`,
      [args.specId, args.projectId, args.orgId],
    );
    return result.rows[0]?.milestone_id ?? null;
  },

  async updateStatus(
    client: QueryClient,
    specId: string,
    next: { from: z.infer<typeof SpecStatus>; to: z.infer<typeof SpecStatus> },
    _actor: ActorRef,
  ): Promise<SpecRow> {
    transitionSpec(next.from, next.to);
    const result = await client.query<RawSpecRow>(
      `UPDATE specs SET status = $2 WHERE spec_id = $1 RETURNING ${SELECT_SPEC_COLUMNS}`,
      [specId, next.to],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`spec not found: ${specId}`);
    }
    return decodeSpecRow(row);
  },
} as const;
