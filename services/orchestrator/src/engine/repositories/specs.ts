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
    const result = await client.query(`SELECT ${SELECT_SPEC_COLUMNS} FROM specs WHERE spec_id = $1`, [specId]);
    const row = result.rows[0];
    if (row === undefined) {
      return undefined;
    }
    return decodeSpecRow(row as RawSpecRow);
  },

  async list(client: QueryClient, filter: { projectId?: string } | undefined, _actor: ActorRef): Promise<SpecRow[]> {
    const projectId = filter?.projectId;
    const result =
      projectId === undefined
        ? await client.query(`SELECT ${SELECT_SPEC_COLUMNS} FROM specs ORDER BY spec_id`)
        : await client.query(`SELECT ${SELECT_SPEC_COLUMNS} FROM specs WHERE project_id = $1 ORDER BY spec_id`, [
            projectId,
          ]);
    return result.rows.map((row) => decodeSpecRow(row as RawSpecRow));
  },

  /**
   * Run-detail spec header: just the title + description for the spec card.
   * Returns undefined when the spec row is gone (the route renders a fallback).
   */
  async selectSummaryHeader(
    client: QueryClient,
    specId: string,
    _actor: ActorRef,
  ): Promise<{ spec_id: string; title: string; description: string } | undefined> {
    const result = await client.query<{ spec_id: string; title: string; description: string }>(
      "SELECT spec_id, title, description FROM specs WHERE spec_id = $1",
      [specId],
    );
    return result.rows[0];
  },

  /**
   * Behavior ids attached to a spec (P2A-0018). The `spec_behaviors` table may
   * be absent on older deployments; the route degrades to an empty list, so this
   * read surfaces the raw rows and lets the caller own that fallback.
   */
  async selectBehaviorIds(client: QueryClient, specId: string, _actor: ActorRef): Promise<string[]> {
    const result = await client.query<{ behavior_id: string }>(
      "SELECT behavior_id FROM spec_behaviors WHERE spec_id = $1 ORDER BY behavior_id",
      [specId],
    );
    return result.rows.map((row) => row.behavior_id);
  },

  /** The spec's milestone id, if any (`spec_milestones`); same fallback caveat. */
  async selectMilestoneId(client: QueryClient, specId: string, _actor: ActorRef): Promise<string | null> {
    const result = await client.query<{ milestone_id: string }>(
      "SELECT milestone_id FROM spec_milestones WHERE spec_id = $1 LIMIT 1",
      [specId],
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
    const result = await client.query(
      `UPDATE specs SET status = $2 WHERE spec_id = $1 RETURNING ${SELECT_SPEC_COLUMNS}`,
      [specId, next.to],
    );
    if (result.rows.length === 0) {
      throw new Error(`spec not found: ${specId}`);
    }
    return decodeSpecRow(result.rows[0] as RawSpecRow);
  },
} as const;
