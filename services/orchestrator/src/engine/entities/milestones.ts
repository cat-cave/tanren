import { randomUUID } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

export const MilestoneStatus = z.enum(["planned", "in_flight", "done", "abandoned"]);
export type MilestoneStatus = z.infer<typeof MilestoneStatus>;

export const MilestoneRow = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  label: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable(),
  orderIndex: z.number().int(),
  eta: z.date().nullable(),
  status: MilestoneStatus,
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type MilestoneRow = z.infer<typeof MilestoneRow>;

interface RawMilestoneRow {
  id: unknown;
  project_id: unknown;
  label: unknown;
  name: unknown;
  description: unknown;
  order_index: unknown;
  eta: unknown;
  status: unknown;
  created_at: unknown;
  updated_at: unknown;
}

const SELECT_MILESTONE_COLUMNS = `
  id,
  project_id,
  label,
  name,
  description,
  order_index,
  eta,
  status,
  created_at,
  updated_at
`;

function decodeMilestoneRow(raw: RawMilestoneRow): MilestoneRow {
  return MilestoneRow.parse({
    id: raw.id,
    projectId: raw.project_id,
    label: raw.label,
    name: raw.name,
    description: raw.description,
    orderIndex: typeof raw.order_index === "string" ? Number(raw.order_index) : raw.order_index,
    eta: raw.eta,
    status: raw.status,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  });
}

export const MilestoneCreateInput = z.object({
  id: z.string().min(1).optional(),
  projectId: z.string().min(1),
  label: z.string().min(1),
  // rv-21 — trim-and-reject blank (matches PersonaCreateInput.name/BehaviorCreateInput.title):
  // the interview-derived milestone name is the captured interface name; a whitespace-only
  // name must never persist a junk milestone, even on a direct/programmatic derive.
  name: z.string().trim().min(1),
  description: z.string().nullable().default(null),
  orderIndex: z.number().int(),
  eta: z.date().nullable().default(null),
  status: MilestoneStatus.default("planned"),
});
export type MilestoneCreateInput = z.infer<typeof MilestoneCreateInput>;

function assertActorCanReachProject(actor: ActorContext, projectId: string): void {
  if (actor.scopes.includes("platform:admin")) return;
  if (actor.scopes.includes("org:admin") || actor.scopes.includes("org:member")) return;
  if (actor.projectId === projectId) return;
  throw new Error(`actor ${actor.userId} cannot reach project ${projectId}`);
}

export const MilestoneStore = {
  async create(client: QueryClient, input: MilestoneCreateInput, actor: ActorContext): Promise<MilestoneRow> {
    const parsed = MilestoneCreateInput.parse(input);
    assertActorCanReachProject(actor, parsed.projectId);
    const id = parsed.id ?? `milestone_${randomUUID()}`;
    const result = await client.query(
      `INSERT INTO milestones (id, project_id, label, name, description, order_index, eta, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${SELECT_MILESTONE_COLUMNS}`,
      [
        id,
        parsed.projectId,
        parsed.label,
        parsed.name,
        parsed.description,
        parsed.orderIndex,
        parsed.eta,
        parsed.status,
      ],
    );
    return decodeMilestoneRow(result.rows[0] as RawMilestoneRow);
  },

  async get(client: QueryClient, id: string, actor: ActorContext): Promise<MilestoneRow | undefined> {
    const result = await client.query(`SELECT ${SELECT_MILESTONE_COLUMNS} FROM milestones WHERE id = $1`, [id]);
    const row = result.rows[0];
    if (row === undefined) return undefined;
    const milestone = decodeMilestoneRow(row as RawMilestoneRow);
    assertActorCanReachProject(actor, milestone.projectId);
    return milestone;
  },

  async listForProject(client: QueryClient, projectId: string, actor: ActorContext): Promise<MilestoneRow[]> {
    assertActorCanReachProject(actor, projectId);
    const result = await client.query(
      `SELECT ${SELECT_MILESTONE_COLUMNS} FROM milestones
       WHERE project_id = $1
       ORDER BY order_index`,
      [projectId],
    );
    return result.rows.map((row) => decodeMilestoneRow(row as RawMilestoneRow));
  },

  async linkSpec(
    client: QueryClient,
    args: { specId: string; milestoneId: string },
    _actor: ActorContext,
  ): Promise<void> {
    await client.query(
      `INSERT INTO spec_milestones (spec_id, milestone_id)
       VALUES ($1, $2)
       ON CONFLICT (spec_id, milestone_id) DO NOTHING`,
      [args.specId, args.milestoneId],
    );
  },

  async setSpecMilestone(
    client: QueryClient,
    args: { specId: string; milestoneId: string },
    _actor: ActorContext,
  ): Promise<void> {
    // Enforces the one-milestone-per-spec product rule by clearing prior
    // assignments before linking. The unique index on spec_id is the backstop.
    await client.query("DELETE FROM spec_milestones WHERE spec_id = $1", [args.specId]);
    await client.query(
      `INSERT INTO spec_milestones (spec_id, milestone_id)
       VALUES ($1, $2)`,
      [args.specId, args.milestoneId],
    );
  },

  async getSpecMilestone(client: QueryClient, specId: string, _actor: ActorContext): Promise<MilestoneRow | undefined> {
    const result = await client.query(
      `SELECT m.id, m.project_id, m.label, m.name, m.description, m.order_index,
              m.eta, m.status, m.created_at, m.updated_at
       FROM milestones m
       INNER JOIN spec_milestones sm ON sm.milestone_id = m.id
       WHERE sm.spec_id = $1`,
      [specId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return decodeMilestoneRow(row as RawMilestoneRow);
  },
} as const;
