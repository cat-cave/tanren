import { notifyDagChanged } from "@tanren/db";
import type pg from "pg";
import type { ProjectLifecycle } from "./projects.js";
import { assertProjectDerivationActivationEvidence } from "./integrationProjectAccess.js";
import { prepareIntegrationReadiness } from "./activationReadiness.js";
import { runActivationWithReadinessBlockEvent } from "./projectActivationReadinessEvent.js";
import {
  ProjectDerivationConflictError,
  SELECT_DERIVATION_COLUMNS,
  beginOnClientQuery,
  conflictFromReceipt,
  decode,
  decodeReceipts,
  inOrgScope,
  recordReceiptOnClientQuery,
  requireComplete,
} from "./projectDerivationContracts.js";
import type {
  BeginDerivationInput,
  DerivationPhase,
  ProjectDerivationRow,
  RawDerivationRow,
} from "./projectDerivationContracts.js";
import {
  DerivationReceiptValidationError,
  derivationJson as json,
  encodeTemplateReceipt,
} from "./projectDerivationReceipts.js";
import type {
  CompleteProjectDerivation,
  DecodedDerivationReceipts,
  DerivationReceiptKey,
  DerivationReceiptValueByKey,
  ExpectedDerivationIdentity,
} from "./projectDerivationReceipts.js";

// Durable derivation writes remain together, while their validation and identity
// contracts live in a separate module for low-cost consumers.
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
    return runActivationWithReadinessBlockEvent(pool, operation, async (client) => {
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
      const project = await client.query<{
        lifecycle: ProjectLifecycle;
        repo_url: string;
        name: string;
        default_branch: string;
      }>(
        `SELECT lifecycle, repo_url, name, default_branch FROM projects
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
      try {
        await assertProjectDerivationActivationEvidence(client, complete, {
          name: projectRow.name,
          repoUrl: projectRow.repo_url,
          defaultBranch: projectRow.default_branch,
        });
      } catch (error) {
        if (error instanceof DerivationReceiptValidationError) throw conflictFromReceipt(error, current.projectId);
        throw error;
      }

      await prepareIntegrationReadiness(client, current.orgId, current.projectId);

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
