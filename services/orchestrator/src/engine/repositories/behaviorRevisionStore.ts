// rv-1 — the production WRITE consumer for the immutable persona/behavior
// revision spine (tables + interfaces shipped by SP-1 / migration 0034; this is
// the missing mint path). A revision's CONTENT is content-addressed and
// immutable: re-minting identical content is idempotent (returns the SAME
// revision, SAME digest), changed content mints a NEW revision (number + 1) and
// supersedes the prior active one via a status-ONLY transition. Immutability is
// enforced at BOTH layers: the store never issues a content UPDATE, and the
// migration 0090 trigger rejects any content-column UPDATE / DELETE at the DB.
//
// All writes run on an ALREADY org-scoped client (the caller holds the
// `runWithOrgScope` transaction) so the mint is atomic with the behavior + spec
// link it freezes, and RLS (FORCE, org policy) is satisfied by the ambient
// `app.current_org_id`.

import { randomUUID } from "node:crypto";
import { parseDigest } from "../contracts/cas.js";
import {
  type BehaviorRevision,
  type BehaviorRevisionBody,
  behaviorRevisionDigest,
  type BehaviorRevisionId,
  type CreateBehaviorRevisionInput,
  type CreatePersonaRevisionInput,
  parseBehaviorRevisionId,
  parsePersonaRevisionId,
  type PersonaRevision,
  type PersonaRevisionBody,
  personaRevisionDigest,
  type PersonaRevisionId,
  type RevisionDigest,
  type RevisionStatus,
} from "../contracts/behaviorRevision.js";
import type { QueryClient } from "../data/orgScopedDb.js";
import type { CanonicalBody } from "../contracts/cas.js";

/** Postgres unique-violation SQLSTATE — the append-only revision-number backstop. */
const UNIQUE_VIOLATION = "23505";

/**
 * A persisted revision's content was attacked directly (a raw content UPDATE the
 * 0090 trigger refused, or a concurrent minter that already claimed this
 * revision number). Never a silent success — the immutability invariant failed
 * loud and is surfaced typed. Fail-closed.
 */
export class RevisionImmutabilityError extends Error {
  public override readonly name = "RevisionImmutabilityError";

  public constructor(kind: "persona" | "behavior", lineageId: string, cause: string) {
    super(`${kind} revision content is immutable (lineage ${lineageId}): ${cause}`);
  }
}

/**
 * A behavior revision was asked to bind to a persona revision that does not
 * exist in this org (a dangling / mismatched revision reference). Rejected — a
 * spec's frozen behavior may only cite a revision that is actually persisted.
 */
export class RevisionBindingError extends Error {
  public override readonly name = "RevisionBindingError";

  public constructor(subject: string) {
    super(`behavior revision binding rejected — not a persisted revision: ${subject}`);
  }
}

interface PersonaRevisionRow {
  id: string;
  org_id: string;
  project_id: string | null;
  persona_id: string;
  scope: string;
  revision_number: number;
  name: string;
  description: string;
  attributes: Record<string, unknown> | null;
  content_digest: string;
  authoring_provenance: Record<string, unknown> | null;
  supersedes_id: string | null;
  status: string;
  created_at: string;
}

interface BehaviorRevisionRow {
  id: string;
  org_id: string;
  project_id: string | null;
  behavior_id: string;
  persona_revision_id: string;
  revision_number: number;
  title: string;
  given: string;
  when: string;
  then: string;
  acceptance: Record<string, unknown> | null;
  content_digest: string;
  design_contract_digest: string | null;
  authoring_provenance: Record<string, unknown> | null;
  supersedes_id: string | null;
  status: string;
  created_at: string;
}

const PERSONA_COLUMNS = `id, org_id, project_id, persona_id, scope, revision_number, name, description,
  attributes, content_digest, authoring_provenance, supersedes_id, status, created_at::text AS created_at`;

const BEHAVIOR_COLUMNS = `id, org_id, project_id, behavior_id, persona_revision_id, revision_number, title,
  given, "when", "then", acceptance, content_digest, design_contract_digest, authoring_provenance,
  supersedes_id, status, created_at::text AS created_at`;

function asRecord(value: Record<string, unknown> | null): Readonly<Record<string, unknown>> {
  return value ?? {};
}

function toCanonicalRecord(value: Readonly<Record<string, unknown>>): { readonly [k: string]: CanonicalBody } {
  // The revision bodies are already JSON-safe (persisted jsonb); re-typing as the
  // canonical body is a narrowing, not a transform — the SP-3 serializer key-sorts.
  return value as { readonly [k: string]: CanonicalBody };
}

function decodePersona(row: PersonaRevisionRow): PersonaRevision {
  return {
    id: parsePersonaRevisionId(row.id),
    orgId: row.org_id,
    projectId: row.project_id,
    personaId: row.persona_id,
    scope: row.scope === "org" ? "org" : "project",
    revisionNumber: row.revision_number,
    name: row.name,
    description: row.description,
    attributes: asRecord(row.attributes),
    contentDigest: parseDigest(row.content_digest),
    authoringProvenance: asRecord(row.authoring_provenance),
    supersedesId: row.supersedes_id === null ? null : parsePersonaRevisionId(row.supersedes_id),
    status: row.status as RevisionStatus,
    createdAt: row.created_at,
  };
}

/* eslint-disable unicorn/no-thenable */
// `then` is the BDD Given/When/Then field name; it is a persisted content field,
// not a thenable — the lint does not apply to these revision bodies.
function decodeBehavior(row: BehaviorRevisionRow): BehaviorRevision {
  return {
    id: parseBehaviorRevisionId(row.id),
    orgId: row.org_id,
    projectId: row.project_id,
    behaviorId: row.behavior_id,
    personaRevisionId: parsePersonaRevisionId(row.persona_revision_id),
    revisionNumber: row.revision_number,
    title: row.title,
    given: row.given,
    when: row.when,
    then: row.then,
    acceptance: asRecord(row.acceptance),
    contentDigest: parseDigest(row.content_digest),
    designContractDigest: row.design_contract_digest === null ? null : parseDigest(row.design_contract_digest),
    authoringProvenance: asRecord(row.authoring_provenance),
    supersedesId: row.supersedes_id === null ? null : parseBehaviorRevisionId(row.supersedes_id),
    status: row.status as RevisionStatus,
    createdAt: row.created_at,
  };
}

function personaBodyAt(
  input: CreatePersonaRevisionInput,
  revisionNumber: number,
  supersedesId: string | null,
): PersonaRevisionBody {
  return {
    personaId: input.personaId,
    scope: input.scope,
    projectId: input.projectId,
    revisionNumber,
    name: input.name,
    description: input.description,
    attributes: toCanonicalRecord(input.attributes),
    supersedesId,
    authoringProvenance: toCanonicalRecord(input.authoringProvenance),
  };
}

function behaviorBodyAt(
  input: CreateBehaviorRevisionInput,
  revisionNumber: number,
  supersedesId: string | null,
): BehaviorRevisionBody {
  return {
    behaviorId: input.behaviorId,
    personaRevisionId: input.personaRevisionId,
    projectId: input.projectId,
    revisionNumber,
    title: input.title,
    given: input.given,
    when: input.when,
    then: input.then,
    acceptance: toCanonicalRecord(input.acceptance),
    designContractDigest: input.designContractDigest ?? null,
    supersedesId,
    authoringProvenance: toCanonicalRecord(input.authoringProvenance),
  };
}
/* eslint-enable unicorn/no-thenable */

async function lockLineage(client: QueryClient, orgId: string, kind: string, lineageId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${kind}:${orgId}:${lineageId}`]);
}

function wrapImmutability(kind: "persona" | "behavior", lineageId: string, error: unknown): never {
  const code = (error as { code?: string } | null)?.code;
  if (code === UNIQUE_VIOLATION) {
    throw new RevisionImmutabilityError(kind, lineageId, "revision number already persisted");
  }
  throw error;
}

/**
 * Mint (or idempotently return) the org-scoped ACTIVE persona revision for a
 * lineage. Content-addressed: identical content to the current active revision
 * returns it unchanged (same digest); changed content supersedes it with a new
 * revision number.
 */
export class PgPersonaRevisionStore {
  public constructor(private readonly client: QueryClient) {}

  public async create(input: CreatePersonaRevisionInput): Promise<PersonaRevision> {
    await lockLineage(this.client, input.orgId, "persona_revision", input.personaId);
    const newest = await this.newest(input.orgId, input.personaId);
    if (newest !== undefined && newest.status === "active") {
      const candidate = personaRevisionDigest(personaBodyAt(input, newest.revisionNumber, newest.supersedesId));
      if (candidate === newest.contentDigest) return newest;
    }
    const revisionNumber = (newest?.revisionNumber ?? 0) + 1;
    const supersedesId = newest?.id ?? null;
    const contentDigest = personaRevisionDigest(personaBodyAt(input, revisionNumber, supersedesId));
    if (newest !== undefined && newest.status === "active") {
      await this.supersede(input.orgId, newest.id);
    }
    const id = `persona_revision_${randomUUID()}`;
    try {
      const inserted = await this.client.query<PersonaRevisionRow>(
        `INSERT INTO persona_revisions
           (id, org_id, project_id, persona_id, scope, revision_number, name, description,
            attributes, content_digest, authoring_provenance, supersedes_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::jsonb, $12)
         RETURNING ${PERSONA_COLUMNS}`,
        [
          id,
          input.orgId,
          input.projectId,
          input.personaId,
          input.scope,
          revisionNumber,
          input.name,
          input.description,
          JSON.stringify(input.attributes),
          contentDigest,
          JSON.stringify(input.authoringProvenance),
          supersedesId,
        ],
      );
      return decodePersona(inserted.rows[0]!);
    } catch (error) {
      return wrapImmutability("persona", input.personaId, error);
    }
  }

  public async getById(orgId: string, id: PersonaRevisionId): Promise<PersonaRevision | undefined> {
    const result = await this.client.query<PersonaRevisionRow>(
      `SELECT ${PERSONA_COLUMNS} FROM persona_revisions WHERE org_id = $1 AND id = $2`,
      [orgId, id],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : decodePersona(row);
  }

  public async getActiveForLineage(orgId: string, personaId: string): Promise<PersonaRevision | undefined> {
    const result = await this.client.query<PersonaRevisionRow>(
      `SELECT ${PERSONA_COLUMNS} FROM persona_revisions
        WHERE org_id = $1 AND persona_id = $2 AND status = 'active'
        ORDER BY revision_number DESC LIMIT 1`,
      [orgId, personaId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : decodePersona(row);
  }

  private async newest(orgId: string, personaId: string): Promise<PersonaRevision | undefined> {
    const result = await this.client.query<PersonaRevisionRow>(
      `SELECT ${PERSONA_COLUMNS} FROM persona_revisions
        WHERE org_id = $1 AND persona_id = $2
        ORDER BY revision_number DESC LIMIT 1`,
      [orgId, personaId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : decodePersona(row);
  }

  private async supersede(orgId: string, id: PersonaRevisionId): Promise<void> {
    await this.client.query(
      `UPDATE persona_revisions SET status = 'superseded' WHERE org_id = $1 AND id = $2 AND status = 'active'`,
      [orgId, id],
    );
  }
}

export class PgBehaviorRevisionStore {
  public constructor(private readonly client: QueryClient) {}

  public async create(input: CreateBehaviorRevisionInput): Promise<BehaviorRevision> {
    await this.assertPersonaRevisionExists(input.orgId, input.personaRevisionId);
    await lockLineage(this.client, input.orgId, "behavior_revision", input.behaviorId);
    const newest = await this.newest(input.orgId, input.behaviorId);
    if (newest !== undefined && newest.status === "active") {
      const candidate = behaviorRevisionDigest(behaviorBodyAt(input, newest.revisionNumber, newest.supersedesId));
      if (candidate === newest.contentDigest) return newest;
    }
    const revisionNumber = (newest?.revisionNumber ?? 0) + 1;
    const supersedesId = newest?.id ?? null;
    const contentDigest = behaviorRevisionDigest(behaviorBodyAt(input, revisionNumber, supersedesId));
    if (newest !== undefined && newest.status === "active") {
      await this.supersede(input.orgId, newest.id);
    }
    const id = `behavior_revision_${randomUUID()}`;
    try {
      const inserted = await this.client.query<BehaviorRevisionRow>(
        `INSERT INTO behavior_revisions
           (id, org_id, project_id, behavior_id, persona_revision_id, revision_number, title,
            given, "when", "then", acceptance, content_digest, design_contract_digest,
            authoring_provenance, supersedes_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14::jsonb, $15)
         RETURNING ${BEHAVIOR_COLUMNS}`,
        [
          id,
          input.orgId,
          input.projectId,
          input.behaviorId,
          input.personaRevisionId,
          revisionNumber,
          input.title,
          input.given,
          input.when,
          input.then,
          JSON.stringify(input.acceptance),
          contentDigest,
          input.designContractDigest ?? null,
          JSON.stringify(input.authoringProvenance),
          supersedesId,
        ],
      );
      return decodeBehavior(inserted.rows[0]!);
    } catch (error) {
      return wrapImmutability("behavior", input.behaviorId, error);
    }
  }

  public async getById(orgId: string, id: BehaviorRevisionId): Promise<BehaviorRevision | undefined> {
    const result = await this.client.query<BehaviorRevisionRow>(
      `SELECT ${BEHAVIOR_COLUMNS} FROM behavior_revisions WHERE org_id = $1 AND id = $2`,
      [orgId, id],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : decodeBehavior(row);
  }

  /** Fail-closed digest binding: resolve a persisted revision by its content digest, or reject. */
  public async getByDigest(orgId: string, digest: RevisionDigest): Promise<BehaviorRevision | undefined> {
    const result = await this.client.query<BehaviorRevisionRow>(
      `SELECT ${BEHAVIOR_COLUMNS} FROM behavior_revisions
        WHERE org_id = $1 AND content_digest = $2
        ORDER BY revision_number DESC LIMIT 1`,
      [orgId, digest],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : decodeBehavior(row);
  }

  public async getActiveForLineage(orgId: string, behaviorId: string): Promise<BehaviorRevision | undefined> {
    const result = await this.client.query<BehaviorRevisionRow>(
      `SELECT ${BEHAVIOR_COLUMNS} FROM behavior_revisions
        WHERE org_id = $1 AND behavior_id = $2 AND status = 'active'
        ORDER BY revision_number DESC LIMIT 1`,
      [orgId, behaviorId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : decodeBehavior(row);
  }

  private async assertPersonaRevisionExists(orgId: string, personaRevisionId: PersonaRevisionId): Promise<void> {
    const result = await this.client.query<{ one: number }>(
      `SELECT 1 AS one FROM persona_revisions WHERE org_id = $1 AND id = $2`,
      [orgId, personaRevisionId],
    );
    if (result.rows[0] === undefined) throw new RevisionBindingError(personaRevisionId);
  }

  private async newest(orgId: string, behaviorId: string): Promise<BehaviorRevision | undefined> {
    const result = await this.client.query<BehaviorRevisionRow>(
      `SELECT ${BEHAVIOR_COLUMNS} FROM behavior_revisions
        WHERE org_id = $1 AND behavior_id = $2
        ORDER BY revision_number DESC LIMIT 1`,
      [orgId, behaviorId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : decodeBehavior(row);
  }

  private async supersede(orgId: string, id: BehaviorRevisionId): Promise<void> {
    await this.client.query(
      `UPDATE behavior_revisions SET status = 'superseded' WHERE org_id = $1 AND id = $2 AND status = 'active'`,
      [orgId, id],
    );
  }
}
