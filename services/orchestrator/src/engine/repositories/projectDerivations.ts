import { createHash, randomUUID } from "node:crypto";
import { getOrgScope, notifyDagChanged, runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import { z } from "zod";
import type { ProjectLifecycle } from "./projects.js";

const DerivationKind = z.enum(["direct_greenfield", "interview"]);
export type DerivationKind = z.infer<typeof DerivationKind>;

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
    readonly reason: "fingerprint_mismatch" | "invalid_lifecycle" | "incomplete_receipts",
  ) {
    super(`project derivation ${projectId} cannot resume: ${reason}`);
  }
}

/**
 * Serialize all retries for a repo/project without holding an RLS transaction or
 * tenant-table connection across provider I/O. The dedicated connection owns only
 * the advisory lock; each receipt mutation remains its own short org-scoped tx.
 */
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

export const ProjectDerivationStore = {
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

  async begin(
    pool: pg.Pool,
    input: {
      orgId: string;
      projectId: string;
      idempotencyFingerprint: string;
      sanitizedInput: Record<string, unknown>;
      ownershipReceipt: Record<string, unknown>;
      templateReceipt?: Record<string, unknown>;
    },
  ): Promise<ProjectDerivationRow> {
    return inOrgScope(pool, input.orgId, async (client) => {
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
          json(input.ownershipReceipt),
          input.templateReceipt === undefined ? null : json(input.templateReceipt),
        ],
      );
      return decode(result.rows[0]!);
    });
  },

  async recordTemplate(
    pool: pg.Pool,
    operation: ProjectDerivationRow,
    receipt: unknown,
  ): Promise<ProjectDerivationRow> {
    return updateOperation(pool, operation, "template", "template_receipt = $3::jsonb", [json(receipt)]);
  },

  async recordReceipt(
    pool: pg.Pool,
    operation: ProjectDerivationRow,
    key: "template_intent" | "deploy_intent" | "deploy" | "graph" | "bootstrap",
    receipt: unknown,
    phase: DerivationPhase,
  ): Promise<ProjectDerivationRow> {
    return inOrgScope(pool, operation.orgId, async (client) => {
      const result = await client.query<RawDerivationRow>(
        `UPDATE project_derivations
            SET result_receipt = jsonb_set(COALESCE(result_receipt, '{}'::jsonb), ARRAY[$3]::text[], $4::jsonb, true),
                phase = $5,
                sanitized_error = NULL,
                status = 'in_progress',
                updated_at = now()
          WHERE org_id = $1 AND id = $2 AND status = 'in_progress'
          RETURNING ${SELECT_DERIVATION_COLUMNS}`,
        [operation.orgId, operation.id, key, json(receipt), phase],
      );
      if (result.rows[0] === undefined)
        throw new ProjectDerivationConflictError(operation.projectId, "invalid_lifecycle");
      return decode(result.rows[0]);
    });
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
      if (current.status === "succeeded") {
        const project = await client.query<{ lifecycle: ProjectLifecycle }>(
          "SELECT lifecycle FROM projects WHERE org_id = $1 AND project_id = $2",
          [operation.orgId, operation.projectId],
        );
        if (project.rows[0]?.lifecycle !== "active") {
          throw new ProjectDerivationConflictError(operation.projectId, "invalid_lifecycle");
        }
        return current;
      }

      const kind = DerivationKind.safeParse(current.sanitizedInput["kind"]);
      const required =
        kind.success && kind.data === "interview"
          ? ["template_intent", "deploy_intent", "deploy", "graph", "bootstrap"]
          : ["deploy_intent", "deploy", "bootstrap"];
      if (!kind.success || required.some((key) => current.resultReceipt[key] === undefined)) {
        throw new ProjectDerivationConflictError(operation.projectId, "incomplete_receipts");
      }
      if (kind.data === "interview" && current.templateReceipt === null) {
        throw new ProjectDerivationConflictError(operation.projectId, "incomplete_receipts");
      }

      const activated = await client.query<{ project_id: string }>(
        `UPDATE projects
            SET lifecycle = 'active'
          WHERE org_id = $1 AND project_id = $2 AND lifecycle = 'deriving'
          RETURNING project_id`,
        [operation.orgId, operation.projectId],
      );
      if ((activated.rowCount ?? 0) !== 1) {
        const project = await client.query<{ lifecycle: ProjectLifecycle }>(
          "SELECT lifecycle FROM projects WHERE org_id = $1 AND project_id = $2",
          [operation.orgId, operation.projectId],
        );
        if (project.rows[0]?.lifecycle !== "active") {
          throw new ProjectDerivationConflictError(operation.projectId, "invalid_lifecycle");
        }
      }
      const completed = await client.query<RawDerivationRow>(
        `UPDATE project_derivations
            SET phase = 'activate', status = 'succeeded', sanitized_error = NULL,
                completed_at = COALESCE(completed_at, now()), updated_at = now()
          WHERE org_id = $1 AND id = $2 AND status = 'in_progress'
          RETURNING ${SELECT_DERIVATION_COLUMNS}`,
        [operation.orgId, operation.id],
      );
      const row = completed.rows[0];
      if (row === undefined) throw new ProjectDerivationConflictError(operation.projectId, "invalid_lifecycle");
      await notifyDagChanged(client, operation.projectId);
      return decode(row);
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
    return decode(result.rows[0]);
  });
}
