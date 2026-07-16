import { createHash, randomUUID } from "node:crypto";
import { getOrgScope, notifyDagChanged, runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import { z } from "zod";
import type { ProjectLifecycle } from "./projects.js";
import {
  completeDerivationReceipts,
  decodeDerivationReceipts,
  DerivationKindSchema,
  DerivationReceiptValidationError,
  DerivationOwnershipReceiptSchema,
  encodeResultReceipt,
  encodeTemplateReceipt,
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

interface RawDerivationRow {
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

const SELECT_DERIVATION_COLUMNS = `
  org_id, id, project_id, idempotency_fingerprint, phase, status,
  sanitized_input, sanitized_error, template_receipt,
  COALESCE(result_receipt, '{}'::jsonb) AS result_receipt,
  ownership_receipt, completed_at
`;

function decode(row: RawDerivationRow): ProjectDerivationRow {
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

function json(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("project derivation receipt must be JSON-serializable");
  return encoded;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function conflictFromReceipt(
  error: DerivationReceiptValidationError,
  projectId: string,
): ProjectDerivationConflictError {
  return new ProjectDerivationConflictError(projectId, error.code);
}

function decodeReceipts(
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

function requireComplete(operation: ProjectDerivationRow): CompleteProjectDerivation {
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
    canonicalJson(operation.sanitizedInput) !== canonicalJson(input.sanitizedInput) ||
    canonicalJson(operation.ownershipReceipt) !== canonicalJson(input.ownershipReceipt)
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

async function inOrgScope<T>(pool: pg.Pool, orgId: string, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
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
    canonicalize(input.request),
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

interface BeginDerivationInput {
  orgId: string;
  projectId: string;
  idempotencyFingerprint: string;
  sanitizedInput: Record<string, unknown>;
  ownershipReceipt: DerivationOwnershipReceipt;
}

async function beginOnClientQuery(
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

async function recordReceiptOnClientQuery<K extends DerivationReceiptKey>(
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

export const ProjectDerivationStore = {
  decode(operation: ProjectDerivationRow, expected?: ExpectedDerivationIdentity): DecodedDerivationReceipts {
    return decodeReceipts(operation, expected);
  },

  requireComplete(operation: ProjectDerivationRow): CompleteProjectDerivation {
    return requireComplete(operation);
  },

  async findForProject(pool: pg.Pool, orgId: string, projectId: string): Promise<ProjectDerivationRow | undefined> {
    return inOrgScope(pool, orgId, async (client) => {
      const result = await client.query<RawDerivationRow>(
        `SELECT ${SELECT_DERIVATION_COLUMNS}
           FROM project_derivations
          WHERE org_id = $1 AND project_id = $2
          ORDER BY created_at DESC
          LIMIT 1`,
        [orgId, projectId],
      );
      return result.rows[0] === undefined ? undefined : decode(result.rows[0]);
    });
  },

  async findByFingerprint(
    pool: pg.Pool,
    orgId: string,
    idempotencyFingerprint: string,
  ): Promise<ProjectDerivationRow | undefined> {
    return inOrgScope(pool, orgId, async (client) => {
      const result = await client.query<RawDerivationRow>(
        `SELECT ${SELECT_DERIVATION_COLUMNS}
           FROM project_derivations
          WHERE org_id = $1 AND idempotency_fingerprint = $2`,
        [orgId, idempotencyFingerprint],
      );
      return result.rows[0] === undefined ? undefined : decode(result.rows[0]);
    });
  },

  async begin(pool: pg.Pool, input: BeginDerivationInput): Promise<ProjectDerivationRow> {
    return inOrgScope(pool, input.orgId, (client) => beginOnClientQuery(client, input));
  },

  async beginOnClient(
    client: Pick<pg.PoolClient, "query">,
    input: BeginDerivationInput,
  ): Promise<ProjectDerivationRow> {
    return beginOnClientQuery(client, input);
  },

  async recordTemplate(
    pool: pg.Pool,
    operation: ProjectDerivationRow,
    receipt: NonNullable<DecodedDerivationReceipts["template"]>,
  ): Promise<ProjectDerivationRow> {
    const ownership = decodeReceipts(operation).ownership;
    return updateOperation(pool, operation, "template", "template_receipt = $3::jsonb", [
      json(encodeTemplateReceipt(ownership, receipt)),
    ]);
  },

  async recordReceipt<K extends DerivationReceiptKey>(
    pool: pg.Pool,
    operation: ProjectDerivationRow,
    key: K,
    receipt: DerivationReceiptValueByKey[K],
    phase: DerivationPhase,
  ): Promise<ProjectDerivationRow> {
    return inOrgScope(pool, operation.orgId, (client) =>
      recordReceiptOnClientQuery(client, operation, key, receipt, phase),
    );
  },

  async recordReceiptOnClient<K extends DerivationReceiptKey>(
    client: Pick<pg.PoolClient, "query">,
    operation: ProjectDerivationRow,
    key: K,
    receipt: DerivationReceiptValueByKey[K],
    phase: DerivationPhase,
  ): Promise<ProjectDerivationRow> {
    return recordReceiptOnClientQuery(client, operation, key, receipt, phase);
  },

  async recordFailure(pool: pg.Pool, operation: ProjectDerivationRow, error: unknown): Promise<void> {
    const sanitizedError = {
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
      observedAt: new Date().toISOString(),
    };
    await inOrgScope(pool, operation.orgId, async (client) => {
      await client.query(
        `UPDATE project_derivations
            SET sanitized_error = $3::jsonb, updated_at = now()
          WHERE org_id = $1 AND id = $2 AND status = 'in_progress'`,
        [operation.orgId, operation.id, json(sanitizedError)],
      );
    });
  },

  async activate(pool: pg.Pool, operation: ProjectDerivationRow): Promise<ProjectDerivationRow> {
    return inOrgScope(pool, operation.orgId, async (client) => {
      const locked = await client.query<RawDerivationRow>(
        `SELECT ${SELECT_DERIVATION_COLUMNS}
           FROM project_derivations
          WHERE org_id = $1 AND id = $2
          FOR UPDATE`,
        [operation.orgId, operation.id],
      );
      const current = locked.rows[0] === undefined ? undefined : decode(locked.rows[0]);
      if (current === undefined) throw new ProjectDerivationConflictError(operation.projectId, "invalid_lifecycle");
      if (
        current.projectId !== operation.projectId ||
        current.idempotencyFingerprint !== operation.idempotencyFingerprint
      ) {
        throw new ProjectDerivationConflictError(operation.projectId, "binding_mismatch");
      }
      const complete = requireComplete(current);
      const project = await client.query<{ lifecycle: ProjectLifecycle; repo_url: string }>(
        `SELECT lifecycle, repo_url FROM projects
          WHERE org_id = $1 AND project_id = $2
          FOR UPDATE`,
        [current.orgId, current.projectId],
      );
      const projectRow = project.rows[0];
      if (
        projectRow === undefined ||
        projectRow.repo_url.replace(/\.git$/u, "") !== complete.ownership.repoUrl.replace(/\.git$/u, "")
      ) {
        throw new ProjectDerivationConflictError(current.projectId, "binding_mismatch");
      }
      if (current.status === "succeeded") {
        if (projectRow.lifecycle !== "active") {
          throw new ProjectDerivationConflictError(current.projectId, "invalid_lifecycle");
        }
        return current;
      }

      const activated = await client.query<{ project_id: string }>(
        `UPDATE projects
            SET lifecycle = 'active'
          WHERE org_id = $1 AND project_id = $2 AND lifecycle = 'deriving'
          RETURNING project_id`,
        [current.orgId, current.projectId],
      );
      if ((activated.rowCount ?? 0) !== 1) {
        const reread = await client.query<{ lifecycle: ProjectLifecycle }>(
          "SELECT lifecycle FROM projects WHERE org_id = $1 AND project_id = $2",
          [current.orgId, current.projectId],
        );
        if (reread.rows[0]?.lifecycle !== "active") {
          throw new ProjectDerivationConflictError(current.projectId, "invalid_lifecycle");
        }
      }
      const completed = await client.query<RawDerivationRow>(
        `UPDATE project_derivations
            SET phase = 'activate', status = 'succeeded', sanitized_error = NULL,
                completed_at = COALESCE(completed_at, now()), updated_at = now()
          WHERE org_id = $1 AND id = $2 AND status = 'in_progress'
          RETURNING ${SELECT_DERIVATION_COLUMNS}`,
        [current.orgId, current.id],
      );
      const row = completed.rows[0];
      if (row === undefined) throw new ProjectDerivationConflictError(current.projectId, "invalid_lifecycle");
      await notifyDagChanged(client, current.projectId);
      const decoded = decode(row);
      requireComplete(decoded);
      return decoded;
    });
  },
} as const;

async function updateOperation(
  pool: pg.Pool,
  operation: ProjectDerivationRow,
  phase: DerivationPhase,
  assignment: string,
  values: unknown[],
): Promise<ProjectDerivationRow> {
  return inOrgScope(pool, operation.orgId, async (client) => {
    const result = await client.query<RawDerivationRow>(
      `UPDATE project_derivations
          SET ${assignment}, phase = $4, sanitized_error = NULL, status = 'in_progress', updated_at = now()
        WHERE org_id = $1 AND id = $2 AND status = 'in_progress'
        RETURNING ${SELECT_DERIVATION_COLUMNS}`,
      [operation.orgId, operation.id, ...values, phase],
    );
    if (result.rows[0] === undefined)
      throw new ProjectDerivationConflictError(operation.projectId, "invalid_lifecycle");
    const updated = decode(result.rows[0]);
    decodeReceipts(updated);
    return updated;
  });
}

export {
  buildDerivationOwnership,
  explicitRepositoryMarker,
  repositoryOwnershipMarker,
} from "./projectDerivationReceipts.js";
export type {
  CompleteDirectDerivation,
  CompleteInterviewDerivation,
  CompleteProjectDerivation,
  DecodedDerivationReceipts,
  DerivationKind,
  DerivationOwnershipReceipt,
  ExpectedDerivationIdentity,
} from "./projectDerivationReceipts.js";
