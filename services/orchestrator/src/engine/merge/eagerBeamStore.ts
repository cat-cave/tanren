// Durable mq-8 beam state. This store owns the exact-coordinate transitions; it
// does not decide merge eligibility and never writes merge_queue.

import { randomUUID } from "node:crypto";
import { runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import type { EagerBeamPlanV1 } from "../contracts/eagerBeamPlan.js";
import { digest, type MaterializedIntegrationNodeRecord } from "./integrationNodeMaterializer.js";
import { upsertIntegrationNodeOnClient } from "../dag/integrationNodesPg.js";
import { PgEventStore } from "../eventStore.js";

export interface EagerBeamProject {
  readonly orgId: string;
  readonly projectId: string;
  readonly repoUrl: unknown;
  readonly defaultBranch: unknown;
  readonly runnerImage: unknown;
  readonly projectConfig: unknown;
  readonly orgConfig: unknown;
}

export interface EagerBeamCandidate {
  readonly runId: string;
  readonly specId: string;
  readonly branch: unknown;
  readonly ancestorStack: unknown;
  readonly priority: unknown;
  readonly createdAt: unknown;
}

interface BeamRow {
  readonly id: string;
  readonly generation: number;
}

interface StaleBeamRow {
  readonly id: string;
  readonly frontier_run_id: string;
  readonly plan_digest: string | null;
}

export interface EagerBeamProof {
  readonly proofRoot: string;
  readonly quarantineEpoch: number;
  readonly toolchainHash: string;
  readonly designContractVersion: string;
  readonly behaviorManifestHash: string;
  readonly proofUnitIds: readonly string[];
}

/** A competing exact coordinate won. This is not a materialization failure and
 * must never trigger frontier-wide cleanup that could stale the winner. */
export class EagerBeamReadyCasLostError extends Error {
  public override readonly name = "EagerBeamReadyCasLostError";

  public constructor() {
    super("eager beam lost its exact building coordinate before ready transition");
  }
}

/** The frontier run row is gone, so the coordinate cannot be locked. No competing
 * ready winner is established; the stranded building beam must still be held. */
export class EagerBeamFrontierUnavailableError extends Error {
  public override readonly name = "EagerBeamFrontierUnavailableError";

  public constructor() {
    super("eager beam frontier run is unavailable for exact-coordinate locking");
  }
}

/** The ready CAS won but the node it names could not be stamped (row missing). This
 * is a materialization failure, not a competing-winner race, so it must be held. */
export class EagerBeamStampMissError extends Error {
  public override readonly name = "EagerBeamStampMissError";

  public constructor() {
    super("eager beam ready node stamp affected no row");
  }
}

/** PG reader/writer used exclusively by the production EAGER planner. */
export class PgEagerBeamStore {
  public constructor(private readonly pool: pg.Pool) {}

  public async loadProject(projectId: string): Promise<EagerBeamProject | undefined> {
    const orgId = await runWithSystemScope(this.pool, async (client) => {
      const result = await client.query<{ org_id: string | null }>(
        "SELECT org_id FROM projects WHERE project_id = $1",
        [projectId],
      );
      return result.rows[0]?.org_id ?? undefined;
    });
    if (orgId === undefined) return undefined;
    return runWithOrgScope(this.pool, orgId, async (client) => {
      const result = await client.query<{
        repo_url: unknown;
        default_branch: unknown;
        runner_image: unknown;
        project_config: unknown;
        org_config: unknown;
      }>(
        `SELECT p.repo_url, p.default_branch, p.runner_image, p.config AS project_config, o.config AS org_config
           FROM projects p
           LEFT JOIN organizations o ON o.id = p.org_id
          WHERE p.project_id = $1`,
        [projectId],
      );
      const row = result.rows[0];
      return row === undefined
        ? undefined
        : {
            orgId,
            projectId,
            repoUrl: row.repo_url,
            defaultBranch: row.default_branch,
            runnerImage: row.runner_image,
            projectConfig: row.project_config,
            orgConfig: row.org_config,
          };
    });
  }

  public async loadCandidates(project: EagerBeamProject): Promise<EagerBeamCandidate[]> {
    return runWithOrgScope(this.pool, project.orgId, async (client) => {
      const result = await client.query<{
        run_id: string;
        spec_id: string;
        branch: unknown;
        ancestor_stack: unknown;
        priority: unknown;
        created_at: unknown;
      }>(
        `SELECT r.run_id, r.spec_id, r.branch, r.ancestor_stack, s.priority, s.created_at
           FROM merge_queue q
           JOIN runs r ON r.org_id = q.org_id AND r.run_id = q.run_id
           JOIN specs s ON s.org_id = r.org_id AND s.spec_id = r.spec_id
          WHERE q.project_id = $1
            AND q.status = 'queued'
            AND r.ancestor_stack IS NOT NULL
          ORDER BY CASE s.priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END,
                   s.created_at ASC, s.spec_id ASC, r.run_id ASC`,
        [project.projectId],
      );
      return result.rows.map((row) => ({
        runId: row.run_id,
        specId: row.spec_id,
        branch: row.branch,
        ancestorStack: row.ancestor_stack,
        priority: row.priority,
        createdAt: row.created_at,
      }));
    });
  }

  /** Atomically persist a materialized node and the exact beam that names it. */
  public async persistMaterialized(input: {
    record: MaterializedIntegrationNodeRecord;
    plan: EagerBeamPlanV1;
    planDigest: string;
  }): Promise<{ readonly nodeId: string; readonly beamId: string; readonly generation: number }> {
    return runWithOrgScope(this.pool, input.record.orgId, async (client) => {
      await lockFrontier(client, input.record.projectId, input.plan.frontierRunId);
      const winner = await client.query(
        `SELECT 1 FROM merge_eager_beams
          WHERE project_id = $1 AND frontier_run_id = $2 AND state = 'ready'
          LIMIT 1`,
        [input.record.projectId, input.plan.frontierRunId],
      );
      if (winner.rowCount !== 0) throw new EagerBeamReadyCasLostError();
      const { memberKey: _memberKey, runId, specId, ...node } = input.record;
      const nodeId = await upsertIntegrationNodeOnClient(client, node);
      const events = new PgEventStore(client);
      const beam = await client.query<BeamRow>(
        `INSERT INTO merge_eager_beams
           (org_id, id, project_id, frontier_run_id, frontier_spec_id, plan_digest,
            integration_node_id, rank, generation, state, stale_reason, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,'building',NULL,now())
         ON CONFLICT (org_id, plan_digest) DO UPDATE SET
           integration_node_id = EXCLUDED.integration_node_id,
           rank = EXCLUDED.rank,
           state = 'building',
           stale_reason = NULL,
           updated_at = now()
         WHERE merge_eager_beams.project_id = EXCLUDED.project_id
           AND merge_eager_beams.frontier_run_id = EXCLUDED.frontier_run_id
           AND merge_eager_beams.frontier_spec_id = EXCLUDED.frontier_spec_id
           AND merge_eager_beams.state <> 'ready'
         RETURNING id, generation`,
        [
          input.record.orgId,
          `beam_${randomUUID()}`,
          input.record.projectId,
          input.plan.frontierRunId,
          input.plan.frontierSpecId,
          input.planDigest,
          nodeId,
          input.plan.rank,
        ],
      );
      const persisted = beam.rows[0];
      if (persisted === undefined) throw new Error("eager beam plan digest collides outside its frontier");
      await events.append({
        orgId: input.record.orgId,
        projectId: input.record.projectId,
        ...(runId === undefined ? {} : { runId }),
        ...(specId === undefined ? {} : { specId }),
        eventType: "integration.node.materialized",
        payload: {
          projectId: input.record.projectId,
          integrationNodeId: nodeId,
          memberKey: input.record.memberKey,
          baseSha: input.record.baseSha,
          headSha: input.record.headSha,
          treeHash: digest(input.record.treeHash),
        },
      });
      await events.append({
        orgId: input.record.orgId,
        projectId: input.record.projectId,
        ...(runId === undefined ? {} : { runId }),
        ...(specId === undefined ? {} : { specId }),
        eventType: "merge.beam.planned",
        payload: {
          projectId: input.record.projectId,
          beamId: persisted.id,
          frontierRunId: input.plan.frontierRunId,
          frontierSpecId: input.plan.frontierSpecId,
          planDigest: input.planDigest,
          integrationNodeId: nodeId,
          rank: input.plan.rank,
          generation: persisted.generation,
          baseSha: input.plan.baseSha,
          memberShas: input.plan.members.map((member) => member.headSha),
        },
      });
      return { nodeId, beamId: persisted.id, generation: persisted.generation };
    });
  }

  public async hold(input: {
    orgId: string;
    projectId: string;
    frontierRunId: string;
    frontierSpecId: string;
    rank: number;
    reason: string;
    planDigest?: string;
  }): Promise<void> {
    await runWithOrgScope(this.pool, input.orgId, async (client) => {
      await lockFrontier(client, input.projectId, input.frontierRunId);
      const events = new PgEventStore(client);
      if (input.planDigest !== undefined) {
        const stale = await client.query<StaleBeamRow>(
          `UPDATE merge_eager_beams
              SET state = 'stale', stale_reason = $5, updated_at = now()
            WHERE project_id = $1 AND frontier_run_id = $2 AND frontier_spec_id = $3
              AND plan_digest = $4 AND state = 'building'
            RETURNING id, frontier_run_id, plan_digest`,
          [input.projectId, input.frontierRunId, input.frontierSpecId, input.planDigest, input.reason],
        );
        const row = stale.rows[0];
        if (row !== undefined) {
          await appendStale(events, input, row);
        }
        return;
      }
      const winner = await client.query(
        `SELECT 1 FROM merge_eager_beams
          WHERE project_id = $1 AND frontier_run_id = $2 AND state = 'ready'
          LIMIT 1`,
        [input.projectId, input.frontierRunId],
      );
      if (winner.rowCount !== 0) return;
      const held = await client.query<{ id: string }>(
        `INSERT INTO merge_eager_beams
           (org_id, id, project_id, frontier_run_id, frontier_spec_id, rank, generation, state, stale_reason, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,1,'held',$7,now())
         ON CONFLICT (org_id, frontier_run_id) WHERE plan_digest IS NULL DO UPDATE SET
           frontier_spec_id = EXCLUDED.frontier_spec_id,
           rank = EXCLUDED.rank,
           state = 'held',
           stale_reason = EXCLUDED.stale_reason,
           updated_at = now()
         RETURNING id`,
        [
          input.orgId,
          `beam_${randomUUID()}`,
          input.projectId,
          input.frontierRunId,
          input.frontierSpecId,
          input.rank,
          input.reason,
        ],
      );
      const row = held.rows[0];
      if (row === undefined) throw new Error("eager beam hold was not durably recorded");
      await appendStale(events, input, {
        id: row.id,
        frontier_run_id: input.frontierRunId,
        plan_digest: null,
      });
    });
  }

  public async markReady(
    input: {
      orgId: string;
      projectId: string;
      planDigest: string;
      nodeId: string;
      plan: EagerBeamPlanV1;
    },
    evaluate: () => Promise<EagerBeamProof>,
  ): Promise<void> {
    await runWithOrgScope(this.pool, input.orgId, async (client) => {
      await lockFrontier(client, input.projectId, input.plan.frontierRunId);
      const owned = await client.query(
        `SELECT 1
           FROM merge_eager_beams b
           JOIN integration_nodes n ON n.org_id = b.org_id AND n.node_id = b.integration_node_id
          WHERE b.project_id = $1 AND b.frontier_run_id = $2
            AND b.plan_digest = $3 AND b.integration_node_id = $4 AND b.state = 'building'
            AND n.ref = $5 AND n.head_sha = $6 AND n.tree_hash = $7
            AND NOT EXISTS (
              SELECT 1 FROM merge_eager_beams winner
               WHERE winner.project_id = b.project_id
                 AND winner.frontier_run_id = b.frontier_run_id
                 AND winner.state = 'ready'
            )`,
        [
          input.projectId,
          input.plan.frontierRunId,
          input.planDigest,
          input.nodeId,
          input.plan.integration.ref,
          input.plan.integration.headSha,
          input.plan.integration.treeHash,
        ],
      );
      if (owned.rowCount !== 1) throw new EagerBeamReadyCasLostError();
      const proof = await evaluate();
      const result = await client.query(
        `UPDATE merge_eager_beams
            SET state = 'ready', updated_at = now()
          WHERE project_id = $1 AND plan_digest = $2
            AND integration_node_id = $3 AND state = 'building'
          RETURNING id`,
        [input.projectId, input.planDigest, input.nodeId],
      );
      if (result.rowCount !== 1) throw new EagerBeamReadyCasLostError();
      const stamped = await client.query(
        `UPDATE integration_nodes
            SET proof_root = $3, quarantine_epoch = $4, toolchain_hash = $5,
                design_contract_version = $6, behavior_manifest_hash = $7, updated_at = now()
          WHERE project_id = $1 AND node_id = $2
          RETURNING node_id`,
        [
          input.projectId,
          input.nodeId,
          proof.proofRoot,
          proof.quarantineEpoch,
          proof.toolchainHash,
          proof.designContractVersion,
          proof.behaviorManifestHash,
        ],
      );
      if (stamped.rowCount !== 1) throw new EagerBeamStampMissError();
      await new PgEventStore(client).append({
        orgId: input.orgId,
        projectId: input.projectId,
        eventType: "integration.proof_root.composed",
        payload: {
          projectId: input.projectId,
          integrationNodeId: input.nodeId,
          proofRoot: proof.proofRoot,
          proofUnitIds: [...proof.proofUnitIds].sort(),
        },
      });
    });
  }

  public async recordMaterializationFailure(input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly runId?: string;
    readonly specId?: string;
    readonly memberKey: string;
    readonly baseSha: string;
    readonly failureCode: string;
    readonly diagnosticsDigest: string;
  }): Promise<void> {
    await runWithOrgScope(this.pool, input.orgId, async (client) => {
      await new PgEventStore(client).append({
        orgId: input.orgId,
        projectId: input.projectId,
        ...(input.runId === undefined ? {} : { runId: input.runId }),
        ...(input.specId === undefined ? {} : { specId: input.specId }),
        eventType: "integration.node.materialization_failed",
        payload: {
          projectId: input.projectId,
          memberKey: input.memberKey,
          baseSha: input.baseSha,
          failureCode: input.failureCode,
          diagnosticsDigest: input.diagnosticsDigest,
        },
      });
    });
  }
}

async function lockFrontier(client: pg.PoolClient, projectId: string, frontierRunId: string): Promise<void> {
  const locked = await client.query("SELECT run_id FROM runs WHERE project_id = $1 AND run_id = $2 FOR UPDATE", [
    projectId,
    frontierRunId,
  ]);
  if (locked.rowCount !== 1) throw new EagerBeamFrontierUnavailableError();
}

async function appendStale(
  events: PgEventStore,
  input: {
    orgId: string;
    projectId: string;
    frontierRunId: string;
    reason: string;
  },
  row: StaleBeamRow,
): Promise<void> {
  await events.append({
    orgId: input.orgId,
    projectId: input.projectId,
    runId: row.frontier_run_id,
    eventType: "merge.beam.stale",
    payload: {
      projectId: input.projectId,
      beamId: row.id,
      frontierRunId: row.frontier_run_id,
      reason: input.reason,
      ...(row.plan_digest === null ? {} : { planDigest: row.plan_digest }),
    },
  });
}
