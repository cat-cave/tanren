import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { QueryClient } from "../data/orgScopedDb.js";
import { PgEventStore } from "../eventStore.js";
import { compilePolicy, type CompiledPolicy } from "./policyCompiler.js";
import { PolicyAstSchema } from "./policyAst.js";
import { policyHash } from "./policyHash.js";

const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const SubjectKindSchema = z.enum(["run", "change", "activation"]);
const SnapshotRowSchema = z
  .object({
    id: z.string().min(1),
    project_id: z.string().min(1),
    binding_id: z.string().min(1),
    tier_id: z.string().min(1),
    policy_revision_id: z.string().min(1),
    effective_policy_hash: DigestSchema,
    compiled_body: z.unknown(),
    subject_kind: SubjectKindSchema,
    subject_id: z.string().min(1),
    inputs_digest: DigestSchema,
    created_at: z.string(),
    created_by: z.string().min(1),
  })
  .strict();

const ActiveBindingRowSchema = z
  .object({
    binding_id: z.string().min(1),
    tier_id: z.string().min(1),
    effective_policy_hash: DigestSchema,
    tier_json: z.unknown(),
    policy_revision_id: z.string().min(1).nullable(),
    policy_revision_hash: DigestSchema.nullable(),
  })
  .strict();

export type EffectivePolicySubjectKind = z.infer<typeof SubjectKindSchema>;

export interface EffectivePolicySnapshot {
  readonly id: string;
  readonly projectId: string;
  readonly bindingId: string;
  readonly tierId: string;
  readonly policyRevisionId: string;
  readonly effectivePolicyHash: string;
  readonly compiledBody: unknown;
  readonly subjectKind: EffectivePolicySubjectKind;
  readonly subjectId: string;
  readonly inputsDigest: string;
  readonly createdAt: string;
  readonly createdBy: string;
}

export interface RecordEffectivePolicySnapshotInput {
  readonly orgId: string;
  readonly projectId: string;
  readonly bindingId?: string;
  readonly inputs?: unknown;
  readonly subjectKind: EffectivePolicySubjectKind;
  readonly subjectId: string;
  readonly createdBy: string;
}

export class EffectivePolicyBindingNotFoundError extends Error {
  constructor(projectId: string) {
    super(`active governance binding not found for project: ${projectId}`);
    this.name = "EffectivePolicyBindingNotFoundError";
  }
}

export class EffectivePolicyIntegrityError extends Error {
  constructor(projectId: string) {
    super(`effective governance policy is not reproducibly compiled for project: ${projectId}`);
    this.name = "EffectivePolicyIntegrityError";
  }
}

function decodeSnapshot(input: unknown): EffectivePolicySnapshot {
  const row = SnapshotRowSchema.parse(input);
  return {
    id: row.id,
    projectId: row.project_id,
    bindingId: row.binding_id,
    tierId: row.tier_id,
    policyRevisionId: row.policy_revision_id,
    effectivePolicyHash: row.effective_policy_hash,
    compiledBody: row.compiled_body,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    inputsDigest: row.inputs_digest,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

async function activeBinding(
  client: QueryClient,
  input: { readonly orgId: string; readonly projectId: string; readonly bindingId?: string },
) {
  const result = await client.query(
    `SELECT b.id AS binding_id, b.tier_id, b.effective_policy_hash, t.tier_json,
            r.id AS policy_revision_id, r.policy_hash AS policy_revision_hash
       FROM policy_bindings b
       JOIN governance_tiers t
         ON t.org_id = b.org_id AND t.project_id = b.project_id AND t.id = b.tier_id
      LEFT JOIN governance_policy_revisions r
         ON r.org_id = b.org_id AND r.project_id = b.project_id
        AND r.policy_hash = b.effective_policy_hash
      WHERE b.org_id = $1 AND b.project_id = $2 AND b.is_active
        AND ($3::text IS NULL OR b.id = $3)
      LIMIT 1`,
    [input.orgId, input.projectId, input.bindingId ?? null],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : ActiveBindingRowSchema.parse(row);
}

function compileEffectivePolicy(row: z.infer<typeof ActiveBindingRowSchema>, projectId: string): CompiledPolicy {
  const compiled = compilePolicy(PolicyAstSchema.parse(row.tier_json));
  if (
    compiled.status === "contradictory" ||
    row.policy_revision_id === null ||
    row.policy_revision_hash === null ||
    compiled.policyHash !== row.effective_policy_hash ||
    compiled.policyHash !== row.policy_revision_hash
  ) {
    throw new EffectivePolicyIntegrityError(projectId);
  }
  return compiled;
}

function inputsDigest(input: RecordEffectivePolicySnapshotInput, policyRevisionId: string, bindingId: string): string {
  return policyHash({
    bindingId,
    policyRevisionId,
    projectId: input.projectId,
    inputs: input.inputs ?? null,
    subjectId: input.subjectId,
    subjectKind: input.subjectKind,
  });
}

function snapshotColumns(): string {
  return `id, project_id, binding_id, tier_id, policy_revision_id, effective_policy_hash,
          compiled_body, subject_kind, subject_id, inputs_digest, created_at::text, created_by`;
}

export async function recordEffectivePolicySnapshot(
  client: QueryClient,
  input: RecordEffectivePolicySnapshotInput,
): Promise<EffectivePolicySnapshot> {
  const binding = await activeBinding(client, input);
  if (binding === undefined) throw new EffectivePolicyBindingNotFoundError(input.projectId);
  const compiled = compileEffectivePolicy(binding, input.projectId);
  const policyRevisionId = binding.policy_revision_id;
  if (policyRevisionId === null) throw new EffectivePolicyIntegrityError(input.projectId);
  const snapshotId = `effective_policy_snapshot_${randomUUID()}`;
  const digest = inputsDigest(input, policyRevisionId, binding.binding_id);
  const inserted = await client.query(
    `INSERT INTO effective_policy_snapshots
       (org_id, id, project_id, binding_id, tier_id, policy_revision_id, effective_policy_hash,
        compiled_body, subject_kind, subject_id, inputs_digest, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12)
     RETURNING ${snapshotColumns()}`,
    [
      input.orgId,
      snapshotId,
      input.projectId,
      binding.binding_id,
      binding.tier_id,
      binding.policy_revision_id,
      compiled.policyHash,
      JSON.stringify(compiled.ast),
      input.subjectKind,
      input.subjectId,
      digest,
      input.createdBy,
    ],
  );
  const row = inserted.rows[0];
  if (row === undefined) throw new Error("effective policy snapshot insert returned no row");
  const snapshot = decodeSnapshot(row);
  await new PgEventStore(client).append({
    orgId: input.orgId,
    projectId: input.projectId,
    eventType: "governance.effective_policy.recorded",
    payload: {
      projectId: snapshot.projectId,
      snapshotId: snapshot.id,
      bindingId: snapshot.bindingId,
      tierId: snapshot.tierId,
      policyRevisionId: snapshot.policyRevisionId,
      effectivePolicyHash: snapshot.effectivePolicyHash,
      subjectKind: snapshot.subjectKind,
      subjectId: snapshot.subjectId,
      inputsDigest: snapshot.inputsDigest,
    },
  });
  return snapshot;
}

/**
 * READ-ONLY resolution of a project's effective compiled governance policy body — the same
 * `compiled.ast` {@link recordEffectivePolicySnapshot} would persist, but WITHOUT inserting a
 * snapshot row or emitting an event. It is the source the MQ-2 multi-member land reads its
 * review rules from (`reviewRulesFromCompiledPolicy`). FAIL-CLOSED: a missing active binding
 * throws {@link EffectivePolicyBindingNotFoundError} and a non-reproducibly-compiled policy
 * throws {@link EffectivePolicyIntegrityError} — the batch land cannot proceed on an
 * unresolved policy.
 */
export async function resolveEffectivePolicyBody(
  client: QueryClient,
  orgId: string,
  projectId: string,
): Promise<unknown> {
  const binding = await activeBinding(client, { orgId, projectId });
  if (binding === undefined) throw new EffectivePolicyBindingNotFoundError(projectId);
  return compileEffectivePolicy(binding, projectId).ast;
}

export async function getEffectivePolicySnapshot(
  client: QueryClient,
  orgId: string,
  projectId: string,
  subjectKind: EffectivePolicySubjectKind,
  subjectId: string,
): Promise<EffectivePolicySnapshot | undefined> {
  const result = await client.query(
    `SELECT ${snapshotColumns()}
       FROM effective_policy_snapshots
      WHERE org_id = $1 AND project_id = $2 AND subject_kind = $3 AND subject_id = $4
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [orgId, projectId, subjectKind, subjectId],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : decodeSnapshot(row);
}
