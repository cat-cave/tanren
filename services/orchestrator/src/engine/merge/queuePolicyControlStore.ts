// Queue-policy HTTP persistence. This stays separate from eligibility evaluation so
// HTTP controls cannot acquire merge authority or affect the host-land decision.
import { createHash, randomUUID } from "node:crypto";
import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import { PgEventStore } from "../eventStore.js";
import { QueuePolicyV1Schema, QueueWindowV1Schema, type QueuePolicyV1, type QueueWindowV1 } from "./queuePolicy.js";

interface ActivePolicyRow {
  id: string;
  version: number;
  body: unknown;
  compiled_hash: string;
}

export class QueuePolicyRevisionConflictError extends Error {
  constructor() {
    super("queue policy revision precondition failed");
  }
}

export class QueuePolicyControlStore {
  constructor(private readonly pool: pg.Pool) {}

  validatePolicy(body: unknown): { compiledHash: string; policy: QueuePolicyV1 } {
    const policy = QueuePolicyV1Schema.parse(body);
    return { policy, compiledHash: digest(policy) };
  }

  async putPolicy(input: {
    orgId: string;
    projectId: string;
    body: unknown;
    expectedVersion?: number;
  }): Promise<{ id: string; version: number; compiledHash: string }> {
    const validated = this.validatePolicy(input.body);
    return runWithOrgScope(this.pool, input.orgId, async (client) => {
      const current = await client.query<Pick<ActivePolicyRow, "id" | "version">>(
        `SELECT id, version FROM merge_queue_policies
          WHERE org_id = $1 AND project_id = $2 AND active = true FOR UPDATE`,
        [input.orgId, input.projectId],
      );
      const prior = current.rows[0];
      if (input.expectedVersion !== undefined && prior?.version !== input.expectedVersion) {
        throw new QueuePolicyRevisionConflictError();
      }
      const id = `mqp_${randomUUID()}`;
      const version = (prior?.version ?? 0) + 1;
      if (prior !== undefined) {
        const deactivated = await client.query(
          "UPDATE merge_queue_policies SET active = false WHERE id = $1 AND active = true",
          [prior.id],
        );
        if (deactivated.rowCount !== 1) throw new Error("queue policy revision lost its active-policy fence");
      }
      await client.query(
        `INSERT INTO merge_queue_policies
           (org_id, id, project_id, target_branch, version, schema_version, body, compiled_hash, active, supersedes)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, true, $9)`,
        [
          input.orgId,
          id,
          input.projectId,
          "*",
          version,
          validated.policy.schemaVersion,
          JSON.stringify(validated.policy),
          validated.compiledHash,
          prior?.id ?? null,
        ],
      );
      await new PgEventStore(client).append({
        orgId: input.orgId,
        projectId: input.projectId,
        eventType: "merge.policy.revised",
        payload: { policyId: id, version, compiledHash: validated.compiledHash },
      });
      return { id, version, compiledHash: validated.compiledHash };
    });
  }

  async getPolicy(input: { orgId: string; projectId: string }) {
    return runWithOrgScope(this.pool, input.orgId, async (client) => {
      const result = await client.query<ActivePolicyRow>(
        "SELECT id, version, body, compiled_hash FROM merge_queue_policies WHERE org_id = $1 AND project_id = $2 AND active = true",
        [input.orgId, input.projectId],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      return {
        id: row.id,
        version: row.version,
        policy: QueuePolicyV1Schema.parse(row.body),
        compiledHash: row.compiled_hash,
      };
    });
  }

  async addWindow(input: { orgId: string; projectId: string; window: unknown }): Promise<{ id: string }> {
    const window: QueueWindowV1 = QueueWindowV1Schema.parse(input.window);
    if (window.scope.projectId !== input.projectId) {
      throw new Error("queue window project scope does not match route project");
    }
    return runWithOrgScope(this.pool, input.orgId, async (client) => {
      const policy = await this.activePolicy(client, input.orgId, input.projectId);
      if (policy === undefined) throw new Error("cannot add queue window without an active policy");
      const id = `mqw_${randomUUID()}`;
      await client.query(
        `INSERT INTO merge_queue_windows (org_id, id, policy_id, project_id, target_branch, name, timezone, intervals, kind)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
        [
          input.orgId,
          id,
          policy.id,
          input.projectId,
          window.scope.targetBranch ?? null,
          window.name,
          window.timezone,
          JSON.stringify(window.intervals),
          window.kind,
        ],
      );
      await new PgEventStore(client).append({
        orgId: input.orgId,
        projectId: input.projectId,
        eventType: "merge.queue.window_changed",
        payload: { windowId: id, name: window.name, kind: window.kind, action: "created" },
      });
      return { id };
    });
  }

  async listWindows(input: { orgId: string; projectId: string }) {
    return runWithOrgScope(this.pool, input.orgId, async (client) => {
      const result = await client.query<{
        id: string;
        name: string;
        kind: string;
        timezone: string;
        target_branch: string | null;
        intervals: unknown;
      }>(
        "SELECT id, name, kind, timezone, target_branch, intervals FROM merge_queue_windows WHERE org_id = $1 AND project_id = $2 ORDER BY name, id",
        [input.orgId, input.projectId],
      );
      return result.rows.map((row) => ({
        id: row.id,
        ...QueueWindowV1Schema.parse({
          schemaVersion: "queue_window.v1",
          name: row.name,
          kind: row.kind,
          timezone: row.timezone,
          scope: {
            projectId: input.projectId,
            ...(row.target_branch === null ? {} : { targetBranch: row.target_branch }),
          },
          intervals: row.intervals,
        }),
      }));
    });
  }

  async deleteWindow(input: { orgId: string; projectId: string; windowId: string }): Promise<boolean> {
    return runWithOrgScope(this.pool, input.orgId, async (client) => {
      const removed = await client.query<{ name: string; kind: "allow" | "blackout" }>(
        "DELETE FROM merge_queue_windows WHERE org_id = $1 AND project_id = $2 AND id = $3 RETURNING name, kind",
        [input.orgId, input.projectId, input.windowId],
      );
      const row = removed.rows[0];
      if (row === undefined) return false;
      await new PgEventStore(client).append({
        orgId: input.orgId,
        projectId: input.projectId,
        eventType: "merge.queue.window_changed",
        payload: { windowId: input.windowId, name: row.name, kind: row.kind, action: "deleted" },
      });
      return true;
    });
  }

  private async activePolicy(
    client: pg.PoolClient,
    orgId: string,
    projectId: string,
  ): Promise<Pick<ActivePolicyRow, "id"> | undefined> {
    const result = await client.query<Pick<ActivePolicyRow, "id">>(
      "SELECT id FROM merge_queue_policies WHERE org_id = $1 AND project_id = $2 AND active = true",
      [orgId, projectId],
    );
    return result.rows[0];
  }
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
