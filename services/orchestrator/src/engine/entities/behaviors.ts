import { randomUUID } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import { PersonaStore } from "./personas.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

// behavior is a Given/When/Then scenario owned by a persona.
// Check/Audit answerers can reference behavior ids when reporting verdicts.
export const BehaviorMetadata = z.record(z.string(), z.unknown());
export type BehaviorMetadata = z.infer<typeof BehaviorMetadata>;

/* eslint-disable unicorn/no-thenable */
// "then" is part of the BDD Given/When/Then vocabulary and is the persisted
// column name; the lint warning about thenable objects does not apply to a
// Zod schema field name.
export const BehaviorRow = z.object({
  id: z.string().min(1),
  personaId: z.string().min(1),
  title: z.string().min(1),
  given: z.string(),
  when: z.string(),
  then: z.string(),
  description: z.string().nullable(),
  metadata: BehaviorMetadata,
  createdAt: z.date(),
  updatedAt: z.date(),
});
/* eslint-enable unicorn/no-thenable */
export type BehaviorRow = z.infer<typeof BehaviorRow>;

interface RawBehaviorRow {
  id: unknown;
  persona_id: unknown;
  title: unknown;
  given: unknown;
  when: unknown;
  then: unknown;
  description: unknown;
  metadata: unknown;
  created_at: unknown;
  updated_at: unknown;
}

const SELECT_BEHAVIOR_COLUMNS = `
  id,
  persona_id,
  title,
  given,
  "when",
  "then",
  description,
  metadata,
  created_at,
  updated_at
`;

function decodeBehaviorRow(raw: RawBehaviorRow): BehaviorRow {
  /* eslint-disable unicorn/no-thenable */
  return BehaviorRow.parse({
    id: raw.id,
    personaId: raw.persona_id,
    title: raw.title,
    given: raw.given,
    when: raw.when,
    then: raw.then,
    description: raw.description,
    metadata: raw.metadata ?? {},
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  });
  /* eslint-enable unicorn/no-thenable */
}

/* eslint-disable unicorn/no-thenable */
export const BehaviorCreateInput = z.object({
  id: z.string().min(1).optional(),
  personaId: z.string().min(1),
  // rv-21 — TRIM-AND-REJECT blank (matches PersonaCreateInput.name): a whitespace-only
  // title must never persist a junk behavior entity, even on a direct/programmatic derive.
  title: z.string().trim().min(1),
  given: z.string(),
  when: z.string(),
  then: z.string(),
  description: z.string().nullable().default(null),
  metadata: BehaviorMetadata.default({}),
});
/* eslint-enable unicorn/no-thenable */
export type BehaviorCreateInput = z.infer<typeof BehaviorCreateInput>;

export const BehaviorStore = {
  async create(client: QueryClient, input: BehaviorCreateInput, actor: ActorContext): Promise<BehaviorRow> {
    const parsed = BehaviorCreateInput.parse(input);
    // Reuse PersonaStore.get to assert the actor can address this persona.
    const persona = await PersonaStore.get(client, parsed.personaId, actor);
    if (persona === undefined) {
      throw new Error(`persona not found: ${parsed.personaId}`);
    }
    const id = parsed.id ?? `behavior_${randomUUID()}`;
    const result = await client.query(
      `INSERT INTO behaviors (id, persona_id, title, given, "when", "then", description, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       RETURNING ${SELECT_BEHAVIOR_COLUMNS}`,
      [
        id,
        parsed.personaId,
        parsed.title,
        parsed.given,
        parsed.when,
        parsed.then,
        parsed.description,
        JSON.stringify(parsed.metadata),
      ],
    );
    return decodeBehaviorRow(result.rows[0] as RawBehaviorRow);
  },

  async get(client: QueryClient, id: string, actor: ActorContext): Promise<BehaviorRow | undefined> {
    const result = await client.query(`SELECT ${SELECT_BEHAVIOR_COLUMNS} FROM behaviors WHERE id = $1`, [id]);
    const row = result.rows[0];
    if (row === undefined) return undefined;
    const behavior = decodeBehaviorRow(row as RawBehaviorRow);
    // Authorize via the parent persona's org/project scoping.
    const persona = await PersonaStore.get(client, behavior.personaId, actor);
    if (persona === undefined) {
      throw new Error(`persona missing for behavior ${behavior.id}`);
    }
    return behavior;
  },

  async listForPersona(client: QueryClient, personaId: string, actor: ActorContext): Promise<BehaviorRow[]> {
    const persona = await PersonaStore.get(client, personaId, actor);
    if (persona === undefined) {
      throw new Error(`persona not found: ${personaId}`);
    }
    const result = await client.query(
      `SELECT ${SELECT_BEHAVIOR_COLUMNS} FROM behaviors WHERE persona_id = $1 ORDER BY title`,
      [personaId],
    );
    return result.rows.map((row) => decodeBehaviorRow(row as RawBehaviorRow));
  },

  async listForSpec(client: QueryClient, specId: string, _actor: ActorContext): Promise<BehaviorRow[]> {
    const result = await client.query(
      `SELECT b.id, b.persona_id, b.title, b.given, b."when", b."then",
              b.description, b.metadata, b.created_at, b.updated_at
       FROM behaviors b
       INNER JOIN spec_behaviors sb ON sb.behavior_id = b.id
       WHERE sb.spec_id = $1
       ORDER BY b.title`,
      [specId],
    );
    return result.rows.map((row) => decodeBehaviorRow(row as RawBehaviorRow));
  },

  async linkToSpec(
    client: QueryClient,
    args: { specId: string; behaviorId: string },
    _actor: ActorContext,
  ): Promise<void> {
    await client.query(
      `INSERT INTO spec_behaviors (spec_id, behavior_id)
       VALUES ($1, $2)
       ON CONFLICT (spec_id, behavior_id) DO NOTHING`,
      [args.specId, args.behaviorId],
    );
  },

  async unlinkFromSpec(
    client: QueryClient,
    args: { specId: string; behaviorId: string },
    _actor: ActorContext,
  ): Promise<void> {
    await client.query(`DELETE FROM spec_behaviors WHERE spec_id = $1 AND behavior_id = $2`, [
      args.specId,
      args.behaviorId,
    ]);
  },
} as const;
