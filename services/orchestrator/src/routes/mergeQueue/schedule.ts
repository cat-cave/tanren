// MQ-9's read-only semantic-schedule projection. It reports only persisted,
// org-scoped facts; a browser read never claims, checks, or advances a queue row.

import { runWithOrgScope } from "@tanren/db";
import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import { assertProjectAccess, ToolAccessDeniedError } from "../../engine/forge/tools/authz.js";
import { decodeFingerprint, partitionsConflict } from "../../engine/merge/integrationGraphScheduler.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/access.js";

const QueueRowSchema = z
  .object({
    queueId: z.string().min(1),
    runId: z.string().min(1),
    specId: z.string().min(1),
    dependsOn: z.array(z.string().min(1)),
    fingerprint: z.string().min(1).nullable(),
  })
  .strict();
const LeaseRowSchema = z
  .object({
    partitionId: z.string().min(1),
    leaseOwner: z.string().min(1),
    leaseEpoch: z.number().int().min(1),
    generation: z.number().int().min(0),
    fingerprint: z.string().min(1),
  })
  .strict();

interface QueueRow {
  readonly queue_id: string;
  readonly run_id: string;
  readonly spec_id: string;
  readonly depends_on: unknown;
  readonly scope_fingerprint: string | null;
}

interface LeaseRow {
  readonly partition_id: string | null;
  readonly lease_owner: string | null;
  readonly lease_epoch: number;
  readonly generation: number | null;
  readonly scope_key: string | null;
}

function actor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) throw new Error("actor missing on context");
  return c.var.actor;
}

export function createMergeQueueScheduleRoutes(options: { pool: pg.Pool }) {
  const app = new Hono<ActorContextEnv>();
  app.get("/:orgId/projects/:projectId/merge-queue/schedule", async (c) => {
    const requestingActor = actor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(requestingActor, orgId)) return c.json({ error: "merge_queue_schedule_not_found" }, 404);
    const schedule = await readSchedule({
      pool: options.pool,
      actor: requestingActor,
      orgId,
      projectId: c.req.param("projectId"),
    });
    if (schedule === null) return c.json({ error: "merge_queue_schedule_not_found" }, 404);
    return c.json({ schedule });
  });
  return app;
}

async function readSchedule(input: { pool: pg.Pool; actor: ActorContext; orgId: string; projectId: string }) {
  return runWithOrgScope(input.pool, input.orgId, async (client) => {
    try {
      const project = await assertProjectAccess(client, input.projectId, input.actor);
      if (project.orgId !== input.orgId) return null;
    } catch (error) {
      if (error instanceof ToolAccessDeniedError) return null;
      throw error;
    }
    const [queue, leases, merged] = await Promise.all([
      client.query<QueueRow>(
        `SELECT mq.queue_id, mq.run_id, mq.spec_id, s.depends_on, mq.scope_fingerprint
           FROM merge_queue mq JOIN specs s ON s.org_id = mq.org_id AND s.spec_id = mq.spec_id
          WHERE mq.project_id = $1 AND mq.status = 'queued'
          ORDER BY mq.enqueued_at ASC, mq.queue_id ASC`,
        [input.projectId],
      ),
      client.query<LeaseRow>(
        `SELECT mq.partition_id, mq.lease_owner, mq.lease_epoch, p.generation, p.scope_key
           FROM merge_queue mq LEFT JOIN merge_queue_partitions p ON p.org_id = mq.org_id AND p.id = mq.partition_id
          WHERE mq.project_id = $1 AND mq.status = 'merging' AND mq.lease_owner IS NOT NULL`,
        [input.projectId],
      ),
      client.query<{ spec_id: string }>("SELECT spec_id FROM specs WHERE project_id = $1 AND status = 'merged'", [
        input.projectId,
      ]),
    ]);
    const parsedQueue = queue.rows.map((row) =>
      QueueRowSchema.parse({
        queueId: row.queue_id,
        runId: row.run_id,
        specId: row.spec_id,
        dependsOn: row.depends_on,
        fingerprint: row.scope_fingerprint,
      }),
    );
    const parsedLeases = leases.rows.map((row) =>
      LeaseRowSchema.parse({
        partitionId: row.partition_id,
        leaseOwner: row.lease_owner,
        leaseEpoch: row.lease_epoch,
        generation: row.generation,
        fingerprint: row.scope_key,
      }),
    );
    const mergedSpecIds = new Set(merged.rows.map((row) => row.spec_id));
    const blockers: string[] = [];
    const selected = parsedQueue.find((row) => {
      if (!row.dependsOn.every((dependency) => mergedSpecIds.has(dependency))) {
        blockers.push(`dependency:${row.specId}`);
        return false;
      }
      const partition = decodeFingerprint(row.fingerprint);
      if (parsedLeases.some((lease) => partitionsConflict(decodeFingerprint(lease.fingerprint), partition))) {
        blockers.push(`leased_partition:${row.specId}`);
        return false;
      }
      return true;
    });
    return {
      selectedCap: 1,
      selectedRunIds: selected === undefined ? [] : [selected.runId],
      blockers,
      conservativeInput:
        "persisted semantic facts are reported serially; the live coordinator revalidates CodeHost heads and diffs",
      partitions: parsedQueue.map((row) => {
        const partition = decodeFingerprint(row.fingerprint);
        return {
          queueId: row.queueId,
          runId: row.runId,
          specId: row.specId,
          fingerprint: partition.fingerprint,
          classes: partition.classes,
          conservative: partition.conservative,
        };
      }),
      activeLeases: parsedLeases,
    };
  });
}
