import { createHash, randomUUID } from "node:crypto";
import { getOrgScope, runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import { z } from "zod";
import {
  completeDerivationReceipts,
  canonicalDerivationJson,
  canonicalizeDerivation,
  decodeDerivationReceipts,
  derivationJson as json,
  DerivationKindSchema,
  DerivationReceiptValidationError,
  DerivationOwnershipReceiptSchema,
  encodeResultReceipt,
  type CompleteProjectDerivation,
  type DecodedDerivationReceipts,
  type DerivationKind,
  type DerivationOwnershipReceipt,
  type DerivationReceiptKey,
  type DerivationReceiptValueByKey,
  type ExpectedDerivationIdentity,
} from "./projectDerivationReceipts.js";

const DerivationPhase = z.enum(["shell", "template", "graph", "activate", "compensate"]);
export type DerivationPhase = z.infer<typeof DerivationPhase>;

const DerivationStatus = z.enum(["pending", "in_progress", "succeeded", "failed", "compensated"]);
export type DerivationStatus = z.infer<typeof DerivationStatus>;

const JsonRecord = z.record(z.string(), z.unknown());

export const ProjectDerivationRow = z.object({
  orgId: z.string().min(1),
  id: z.string().min(1),
  projectId: z.string().min(1),
  idempotencyFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  phase: DerivationPhase,
  status: DerivationStatus,
  sanitizedInput: JsonRecord,
  sanitizedError: JsonRecord.nullable(),
  templateReceipt: JsonRecord.nullable(),
  resultReceipt: JsonRecord,
  ownershipReceipt: JsonRecord.nullable(),
  completedAt: z.date().nullable(),
});
export type ProjectDerivationRow = z.infer<typeof ProjectDerivationRow>;

export interface RawDerivationRow {
  org_id: unknown;
  id: unknown;
  project_id: unknown;
  idempotency_fingerprint: unknown;
  phase: unknown;
  status: unknown;
  sanitized_input: unknown;
  sanitized_error: unknown;
  template_receipt: unknown;
  result_receipt: unknown;
  ownership_receipt: unknown;
  completed_at: unknown;
}

export const SELECT_DERIVATION_COLUMNS = `
  org_id, id, project_id, idempotency_fingerprint, phase, status,
  sanitized_input, sanitized_error, template_receipt,
  COALESCE(result_receipt, '{}'::jsonb) AS result_receipt,
  ownership_receipt, completed_at
`;

export function decode(row: RawDerivationRow): ProjectDerivationRow {
  return ProjectDerivationRow.parse({
    orgId: row.org_id,
    id: row.id,
    projectId: row.project_id,
    idempotencyFingerprint: row.idempotency_fingerprint,
    phase: row.phase,
    status: row.status,
    sanitizedInput: row.sanitized_input,
    sanitizedError: row.sanitized_error,
    templateReceipt: row.template_receipt,
    resultReceipt: row.result_receipt,
    ownershipReceipt: row.ownership_receipt,
    completedAt: row.completed_at,
  });
}

export function conflictFromReceipt(
  error: DerivationReceiptValidationError,
  projectId: string,
): ProjectDerivationConflictError {
  return new ProjectDerivationConflictError(projectId, error.code);
}

export function decodeReceipts(
  operation: ProjectDerivationRow,
  expected?: ExpectedDerivationIdentity,
): DecodedDerivationReceipts {
  try {
    return decodeDerivationReceipts({
      orgId: operation.orgId,
      projectId: operation.projectId,
      idempotencyFingerprint: operation.idempotencyFingerprint,
      sanitizedInput: operation.sanitizedInput,
      ownershipReceipt: operation.ownershipReceipt,
      templateReceipt: operation.templateReceipt,
      resultReceipt: operation.resultReceipt,
      ...(expected === undefined ? {} : { expected }),
    });
  } catch (error) {
    if (error instanceof DerivationReceiptValidationError) throw conflictFromReceipt(error, operation.projectId);
    throw error;
  }
}

export function requireComplete(operation: ProjectDerivationRow): CompleteProjectDerivation {
  const complete = completeDerivationReceipts(decodeReceipts(operation));
  if (complete === undefined) throw new ProjectDerivationConflictError(operation.projectId, "incomplete_receipts");
  return complete;
}

function assertBeginIdentity(
  operation: ProjectDerivationRow,
  input: {
    projectId: string;
    idempotencyFingerprint: string;
    sanitizedInput: Record<string, unknown>;
    ownershipReceipt: DerivationOwnershipReceipt;
  },
): void {
  if (
    operation.projectId !== input.projectId ||
    operation.idempotencyFingerprint !== input.idempotencyFingerprint ||
    canonicalDerivationJson(operation.sanitizedInput) !== canonicalDerivationJson(input.sanitizedInput) ||
    canonicalDerivationJson(operation.ownershipReceipt) !== canonicalDerivationJson(input.ownershipReceipt)
  ) {
    throw new ProjectDerivationConflictError(input.projectId, "binding_mismatch");
  }
  const kind = DerivationKindSchema.parse(input.sanitizedInput["kind"]);
  decodeReceipts(operation, {
    kind,
    orgId: operation.orgId,
    projectId: input.projectId,
    repoUrl: input.ownershipReceipt.repoUrl,
    idempotencyFingerprint: input.idempotencyFingerprint,
  });
}

export async function inOrgScope<T>(
  pool: pg.Pool,
  orgId: string,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const ambient = getOrgScope();
  if (ambient?.orgId === orgId) return work(ambient.client);
  return runWithOrgScope(pool, orgId, work);
}

/** Stable, secret-free idempotency identity for one repo-bound derivation request. */
export function projectDerivationFingerprint(input: {
  kind: DerivationKind;
  orgId: string;
  repoUrl: string;
  request: unknown;
}): string {
  const body = JSON.stringify([
    "tanren.project-derivation.v1",
    input.kind,
    input.orgId,
    input.repoUrl,
    canonicalizeDerivation(input.request),
  ]);
  return `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`;
}

export class ProjectDerivationConflictError extends Error {
  override readonly name = "ProjectDerivationConflictError";

  constructor(
    readonly projectId: string,
    readonly reason:
      | "fingerprint_mismatch"
      | "invalid_lifecycle"
      | "incomplete_receipts"
      | "binding_mismatch"
      | "invalid_receipt",
  ) {
    super(`project derivation ${projectId} cannot resume: ${reason}`);
  }
}

/** Serialize retries without holding an RLS transaction across provider I/O. */
export async function withProjectDerivationLock<T>(
  pool: pg.Pool,
  orgId: string,
  repoUrl: string,
  work: () => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1), hashtext($2))", [orgId, repoUrl]);
    return await work();
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext($1), hashtext($2))", [orgId, repoUrl]).catch(() => {});
    client.release();
  }
}

export interface BeginDerivationInput {
  orgId: string;
  projectId: string;
  idempotencyFingerprint: string;
  sanitizedInput: Record<string, unknown>;
  ownershipReceipt: DerivationOwnershipReceipt;
}

export async function beginOnClientQuery(
  client: Pick<pg.PoolClient, "query">,
  input: BeginDerivationInput,
): Promise<ProjectDerivationRow> {
  const ownership = DerivationOwnershipReceiptSchema.parse(input.ownershipReceipt);
  const result = await client.query<RawDerivationRow>(
    `INSERT INTO project_derivations
       (org_id, id, project_id, idempotency_fingerprint, phase, status,
        sanitized_input, ownership_receipt, template_receipt, result_receipt, updated_at)
     VALUES ($1, $2, $3, $4, 'shell', 'in_progress', $5::jsonb, $6::jsonb, $7::jsonb, '{}'::jsonb, now())
     ON CONFLICT (org_id, idempotency_fingerprint) DO UPDATE
       SET updated_at = now()
     RETURNING ${SELECT_DERIVATION_COLUMNS}`,
    [
      input.orgId,
      `derivation_${randomUUID()}`,
      input.projectId,
      input.idempotencyFingerprint,
      json(input.sanitizedInput),
      json(ownership),
      null,
    ],
  );
  const operation = decode(result.rows[0]!);
  assertBeginIdentity(operation, { ...input, ownershipReceipt: ownership });
  return operation;
}

export async function recordReceiptOnClientQuery<K extends DerivationReceiptKey>(
  client: Pick<pg.PoolClient, "query">,
  operation: ProjectDerivationRow,
  key: K,
  receipt: DerivationReceiptValueByKey[K],
  phase: DerivationPhase,
): Promise<ProjectDerivationRow> {
  const ownership = decodeReceipts(operation).ownership;
  const encoded = encodeResultReceipt(ownership, key, receipt);
  const result = await client.query<RawDerivationRow>(
    `UPDATE project_derivations
        SET result_receipt = jsonb_set(COALESCE(result_receipt, '{}'::jsonb), ARRAY[$3]::text[], $4::jsonb, true),
            phase = $5,
            sanitized_error = NULL,
            status = 'in_progress',
            updated_at = now()
      WHERE org_id = $1 AND id = $2 AND status = 'in_progress'
        AND ($3::text NOT IN ('design_intent', 'design')
             OR NOT (COALESCE(result_receipt, '{}'::jsonb) ? $3::text))
      RETURNING ${SELECT_DERIVATION_COLUMNS}`,
    [operation.orgId, operation.id, key, json(encoded), phase],
  );
  if (result.rows[0] === undefined) {
    throw new ProjectDerivationConflictError(operation.projectId, "invalid_lifecycle");
  }
  const updated = decode(result.rows[0]);
  decodeReceipts(updated);
  return updated;
}
