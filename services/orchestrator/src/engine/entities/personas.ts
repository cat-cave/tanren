import { randomUUID } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

// P2A-0018: persona is a role-like entity owned by an org and optionally
// project-scoped. The schema uses text ids for parity with existing tables;
// new rows are minted as `persona_<uuid>` but inbound ids only need to be
// stable opaque strings.
export const PersonaScope = z.enum(["org", "project"]);
export type PersonaScope = z.infer<typeof PersonaScope>;

export const PersonaMetadata = z.record(z.string(), z.unknown());
export type PersonaMetadata = z.infer<typeof PersonaMetadata>;

export const PersonaRow = z
  .object({
    id: z.string().min(1),
    scope: PersonaScope,
    orgId: z.string().min(1),
    projectId: z.string().min(1).nullable(),
    name: z.string().min(1),
    description: z.string(),
    metadata: PersonaMetadata,
    createdAt: z.date(),
    updatedAt: z.date()
  })
  .superRefine((row, ctx) => {
    if (row.scope === "org" && row.projectId !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["projectId"],
        message: "org-scoped persona must have a null projectId"
      });
    }
    if (row.scope === "project" && row.projectId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["projectId"],
        message: "project-scoped persona must have a non-null projectId"
      });
    }
  });
export type PersonaRow = z.infer<typeof PersonaRow>;

interface RawPersonaRow {
  id: unknown;
  scope: unknown;
  org_id: unknown;
  project_id: unknown;
  name: unknown;
  description: unknown;
  metadata: unknown;
  created_at: unknown;
  updated_at: unknown;
}

const SELECT_PERSONA_COLUMNS = `
  id,
  scope,
  org_id,
  project_id,
  name,
  description,
  metadata,
  created_at,
  updated_at
`;

function decodePersonaRow(raw: RawPersonaRow): PersonaRow {
  return PersonaRow.parse({
    id: raw.id,
    scope: raw.scope,
    orgId: raw.org_id,
    projectId: raw.project_id,
    name: raw.name,
    description: raw.description,
    metadata: raw.metadata ?? {},
    createdAt: raw.created_at,
    updatedAt: raw.updated_at
  });
}

export const PersonaCreateInput = z
  .object({
    id: z.string().min(1).optional(),
    scope: PersonaScope,
    orgId: z.string().min(1),
    projectId: z.string().min(1).nullable().default(null),
    name: z.string().min(1),
    description: z.string().default(""),
    metadata: PersonaMetadata.default({})
  })
  .superRefine((input, ctx) => {
    if (input.scope === "org" && input.projectId !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["projectId"],
        message: "org-scoped persona must have a null projectId"
      });
    }
    if (input.scope === "project" && input.projectId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["projectId"],
        message: "project-scoped persona must have a projectId"
      });
    }
  });
export type PersonaCreateInput = z.infer<typeof PersonaCreateInput>;

function assertActorMatchesOrg(actor: ActorContext, orgId: string): void {
  if (actor.scopes.includes("platform:admin")) return;
  if (actor.orgId === null || actor.orgId !== orgId) {
    throw new Error(`actor ${actor.userId} is not scoped to org ${orgId}`);
  }
}

function assertActorCanReadProjectPersona(actor: ActorContext, projectId: string | null): void {
  if (projectId === null) return;
  if (actor.scopes.includes("platform:admin")) return;
  if (actor.scopes.includes("org:admin") || actor.scopes.includes("org:member")) return;
  if (actor.projectId === projectId) return;
  throw new Error(`actor ${actor.userId} cannot read project-scoped persona on ${projectId}`);
}

export const PersonaStore = {
  async create(client: QueryClient, input: PersonaCreateInput, actor: ActorContext): Promise<PersonaRow> {
    const parsed = PersonaCreateInput.parse(input);
    assertActorMatchesOrg(actor, parsed.orgId);
    const id = parsed.id ?? `persona_${randomUUID()}`;
    const result = await client.query(
      `INSERT INTO personas (id, scope, org_id, project_id, name, description, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       RETURNING ${SELECT_PERSONA_COLUMNS}`,
      [
        id,
        parsed.scope,
        parsed.orgId,
        parsed.projectId,
        parsed.name,
        parsed.description,
        JSON.stringify(parsed.metadata)
      ]
    );
    return decodePersonaRow(result.rows[0] as RawPersonaRow);
  },

  async get(client: QueryClient, id: string, actor: ActorContext): Promise<PersonaRow | undefined> {
    const result = await client.query(
      `SELECT ${SELECT_PERSONA_COLUMNS} FROM personas WHERE id = $1`,
      [id]
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    const persona = decodePersonaRow(row as RawPersonaRow);
    assertActorMatchesOrg(actor, persona.orgId);
    assertActorCanReadProjectPersona(actor, persona.projectId);
    return persona;
  },

  // Lists personas reachable from a given project: includes both org-scoped
  // personas (visible to any project in the org) and project-scoped personas
  // bound to that project. Mirrors the visibility rule documented in
  // docs/architecture/product-entities.md.
  async listForProject(
    client: QueryClient,
    args: { orgId: string; projectId: string },
    actor: ActorContext
  ): Promise<PersonaRow[]> {
    assertActorMatchesOrg(actor, args.orgId);
    const result = await client.query(
      `SELECT ${SELECT_PERSONA_COLUMNS} FROM personas
       WHERE org_id = $1 AND (scope = 'org' OR project_id = $2)
       ORDER BY name`,
      [args.orgId, args.projectId]
    );
    return result.rows.map((row) => decodePersonaRow(row as RawPersonaRow));
  },

  async listForOrg(client: QueryClient, orgId: string, actor: ActorContext): Promise<PersonaRow[]> {
    assertActorMatchesOrg(actor, orgId);
    const result = await client.query(
      `SELECT ${SELECT_PERSONA_COLUMNS} FROM personas WHERE org_id = $1 ORDER BY name`,
      [orgId]
    );
    return result.rows.map((row) => decodePersonaRow(row as RawPersonaRow));
  }
} as const;
