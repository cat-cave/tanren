import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { QueryClient } from "../data/orgScopedDb.js";
import { PgEventStore } from "../eventStore.js";
import { compilePolicy, type CompiledPolicy, type CompiledPolicyAst } from "./policyCompiler.js";
import { PolicyAstSchema, type PolicyAst } from "./policyAst.js";
import type { ContradictionWitness } from "./contradictionWitness.js";
import { policyHash } from "./policyHash.js";

const RevisionRowSchema = z
  .object({
    id: z.string().min(1),
    project_id: z.string().min(1),
    revision_number: z.number().int().positive(),
    schema_version: z.number().int().positive(),
    source_document: z.unknown(),
    compiled_ast: z.unknown(),
    policy_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    parent_revision_id: z.string().min(1).nullable(),
    created_by: z.string().min(1),
    created_at: z.string(),
  })
  .strict();

export interface PolicyRevision {
  readonly id: string;
  readonly projectId: string;
  readonly revisionNumber: number;
  readonly schemaVersion: number;
  readonly sourceDocument: PolicyAst;
  readonly compiledAst: CompiledPolicyAst;
  readonly policyHash: string;
  readonly parentRevisionId: string | undefined;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface CreatePolicyRevisionInput {
  readonly orgId: string;
  readonly projectId: string;
  readonly sourceDocument: unknown;
  readonly parentRevisionId?: string;
  readonly createdBy: string;
}

export class PolicyContradictionError extends Error {
  readonly witnesses: readonly ContradictionWitness[];

  constructor(witnesses: readonly ContradictionWitness[]) {
    super("policy contains deterministic contradiction witnesses");
    this.name = "PolicyContradictionError";
    this.witnesses = witnesses;
  }
}

export class PolicyRevisionNotFoundError extends Error {
  constructor(revision: string) {
    super(`governance policy revision not found: ${revision}`);
    this.name = "PolicyRevisionNotFoundError";
  }
}

export class PolicyRevisionIntegrityError extends Error {
  constructor(revisionId: string) {
    super(`governance policy revision is not reproducibly compiled: ${revisionId}`);
    this.name = "PolicyRevisionIntegrityError";
  }
}

function decodeCompiledAst(input: unknown): CompiledPolicyAst {
  if (input === null || typeof input !== "object") throw new Error("stored compiled policy is not an object");
  const candidate = input as Partial<CompiledPolicyAst>;
  if (
    candidate.apiVersion !== "tanren.dev/governance/v2" ||
    typeof candidate.schemaVersion !== "number" ||
    !Array.isArray(candidate.aggregationOrder) ||
    !Array.isArray(candidate.rules) ||
    candidate.sourceMap === null ||
    typeof candidate.sourceMap !== "object"
  ) {
    throw new Error("stored compiled policy has an invalid shape");
  }
  return input as CompiledPolicyAst;
}

function decodeRevision(input: unknown): PolicyRevision {
  const row = RevisionRowSchema.parse(input);
  const sourceDocument = PolicyAstSchema.parse(row.source_document);
  return {
    id: row.id,
    projectId: row.project_id,
    revisionNumber: row.revision_number,
    schemaVersion: row.schema_version,
    sourceDocument,
    compiledAst: decodeCompiledAst(row.compiled_ast),
    policyHash: row.policy_hash,
    parentRevisionId: row.parent_revision_id ?? undefined,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

async function lockRevisionSequence(client: QueryClient, projectId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`governance-policy:${projectId}`]);
}

async function compileSource(sourceDocument: unknown): Promise<CompiledPolicy> {
  const compiled = compilePolicy(sourceDocument);
  if (compiled.status === "contradictory") throw new PolicyContradictionError(compiled.contradictionWitnesses);
  return compiled;
}

async function appendCreatedEvent(client: QueryClient, revision: PolicyRevision, orgId: string): Promise<void> {
  await new PgEventStore(client).append({
    orgId,
    projectId: revision.projectId,
    eventType: "governance.policy.created",
    payload: {
      revisionId: revision.id,
      projectId: revision.projectId,
      revisionNumber: revision.revisionNumber,
      schemaVersion: revision.schemaVersion,
      ...(revision.parentRevisionId === undefined ? {} : { parentRevisionId: revision.parentRevisionId }),
      createdBy: revision.createdBy,
    },
  });
}

async function lifecycleEventExists(
  client: QueryClient,
  orgId: string,
  projectId: string,
  eventType: "governance.policy.compiled" | "governance.policy.activated",
  revisionId: string,
): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM events
        WHERE org_id = $1 AND project_id = $2 AND event_type = $3
          AND payload->>'revisionId' = $4
     ) AS exists`,
    [orgId, projectId, eventType, revisionId],
  );
  return result.rows[0]?.exists === true;
}

async function appendCompiledEvent(client: QueryClient, revision: PolicyRevision, orgId: string): Promise<void> {
  if (await lifecycleEventExists(client, orgId, revision.projectId, "governance.policy.compiled", revision.id)) return;
  await new PgEventStore(client).append({
    orgId,
    projectId: revision.projectId,
    eventType: "governance.policy.compiled",
    payload: {
      revisionId: revision.id,
      projectId: revision.projectId,
      revisionNumber: revision.revisionNumber,
      policyHash: revision.policyHash,
      ruleCount: revision.compiledAst.rules.length,
    },
  });
}

async function appendActivatedEvent(client: QueryClient, revision: PolicyRevision, orgId: string): Promise<void> {
  if (await lifecycleEventExists(client, orgId, revision.projectId, "governance.policy.activated", revision.id)) return;
  await new PgEventStore(client).append({
    orgId,
    projectId: revision.projectId,
    eventType: "governance.policy.activated",
    payload: {
      revisionId: revision.id,
      projectId: revision.projectId,
      revisionNumber: revision.revisionNumber,
      policyHash: revision.policyHash,
    },
  });
}

export async function createPolicyRevision(
  client: QueryClient,
  input: CreatePolicyRevisionInput,
): Promise<PolicyRevision> {
  const sourceDocument = PolicyAstSchema.parse(input.sourceDocument);
  const compiled = await compileSource(sourceDocument);
  await lockRevisionSequence(client, input.projectId);
  if (input.parentRevisionId !== undefined) {
    const parent = await client.query<{ project_id: string }>(
      `SELECT project_id FROM governance_policy_revisions WHERE org_id = $1 AND id = $2`,
      [input.orgId, input.parentRevisionId],
    );
    const parentProject = parent.rows[0]?.project_id;
    if (parentProject === undefined) throw new PolicyRevisionNotFoundError(input.parentRevisionId);
    if (parentProject !== input.projectId) throw new Error("parent policy revision belongs to another project");
  }
  const sequence = await client.query<{ revision_number: number }>(
    `SELECT COALESCE(MAX(revision_number), 0) + 1 AS revision_number
       FROM governance_policy_revisions
      WHERE org_id = $1 AND project_id = $2`,
    [input.orgId, input.projectId],
  );
  const revisionNumber = sequence.rows[0]?.revision_number;
  if (revisionNumber === undefined) throw new Error("governance policy revision sequence could not be allocated");
  const id = `policy_revision_${randomUUID()}`;
  const inserted = await client.query<{
    id: string;
    project_id: string;
    revision_number: number;
    schema_version: number;
    source_document: unknown;
    compiled_ast: unknown;
    policy_hash: string;
    parent_revision_id: string | null;
    created_by: string;
    created_at: string;
  }>(
    `INSERT INTO governance_policy_revisions
       (org_id, id, project_id, revision_number, schema_version, source_document, compiled_ast,
        policy_hash, parent_revision_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)
     RETURNING id, project_id, revision_number, schema_version, source_document, compiled_ast,
               policy_hash, parent_revision_id, created_by, created_at::text`,
    [
      input.orgId,
      id,
      input.projectId,
      revisionNumber,
      sourceDocument.schemaVersion,
      JSON.stringify(sourceDocument),
      JSON.stringify(compiled.ast),
      compiled.policyHash,
      input.parentRevisionId ?? null,
      input.createdBy,
    ],
  );
  const row = inserted.rows[0];
  if (row === undefined) throw new Error("governance policy revision insert returned no row");
  const revision = decodeRevision(row);
  await appendCreatedEvent(client, revision, input.orgId);
  return revision;
}

export async function getPolicyRevision(
  client: QueryClient,
  orgId: string,
  projectId: string,
  revision: string,
): Promise<PolicyRevision> {
  const numericRevision = Number.parseInt(revision, 10);
  const result = await client.query(
    `SELECT id, project_id, revision_number, schema_version, source_document, compiled_ast,
            policy_hash, parent_revision_id, created_by, created_at::text
       FROM governance_policy_revisions
      WHERE org_id = $1 AND project_id = $2
        AND (id = $3 OR revision_number = $4)
      LIMIT 1`,
    [orgId, projectId, revision, Number.isInteger(numericRevision) ? numericRevision : -1],
  );
  const row = result.rows[0];
  if (row === undefined) throw new PolicyRevisionNotFoundError(revision);
  return decodeRevision(row);
}

export async function findPolicyRevisionByHash(
  client: QueryClient,
  orgId: string,
  projectId: string,
  policyHashValue: string,
): Promise<PolicyRevision | undefined> {
  const result = await client.query(
    `SELECT id, project_id, revision_number, schema_version, source_document, compiled_ast,
            policy_hash, parent_revision_id, created_by, created_at::text
       FROM governance_policy_revisions
      WHERE org_id = $1 AND project_id = $2 AND policy_hash = $3
      ORDER BY revision_number DESC
      LIMIT 1`,
    [orgId, projectId, policyHashValue],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : decodeRevision(row);
}

export async function validatePolicyRevision(sourceDocument: unknown): Promise<CompiledPolicy> {
  return compileSource(PolicyAstSchema.parse(sourceDocument));
}

export async function compilePolicyRevision(
  client: QueryClient,
  orgId: string,
  revision: PolicyRevision,
): Promise<PolicyRevision> {
  await lockRevisionSequence(client, revision.projectId);
  const compiled = await compileSource(revision.sourceDocument);
  if (compiled.policyHash !== revision.policyHash || policyHash(compiled.ast) !== policyHash(revision.compiledAst)) {
    throw new PolicyRevisionIntegrityError(revision.id);
  }
  await appendCompiledEvent(client, revision, orgId);
  return revision;
}

/**
 * gv-9 owns persisted bindings. gv-7 activation therefore records the frozen
 * activation fact only; it never mutates this revision or invents a binding row.
 */
export async function activatePolicyRevision(
  client: QueryClient,
  orgId: string,
  revision: PolicyRevision,
): Promise<PolicyRevision> {
  await compilePolicyRevision(client, orgId, revision);
  await appendActivatedEvent(client, revision, orgId);
  return revision;
}
