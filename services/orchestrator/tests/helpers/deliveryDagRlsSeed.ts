// Real-Postgres seed + read helpers for the in-17 delivery DAG RLS test (extracted to keep
// the .test.ts under the 500-line source cap). Seeds run as the DB owner; the merged-run
// signal goes through the single event-writer seam (PgEventStore), never a raw INSERT.

import { runWithJobOrgId, runWithOrgScope } from "@tanren/db";
import type { Pool } from "pg";
import { orgScopingPool } from "../../src/engine/data/orgScopedDb.js";
import { PgEventStore } from "../../src/engine/eventStore.js";
import type { RunMergeWatcher } from "../../src/engine/postMerge/subscriber.js";

export const D = `sha256:${"d".repeat(64)}`;

/** A no-op idempotent cluster runner that records the runIds it was driven for. */
export function recordingRunner(): RunMergeWatcher & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    // eslint-disable-next-line @typescript-eslint/require-await
    check: async (runId: string) => {
      calls.push(runId);
    },
  };
}

export async function seedOrg(owner: Pool, org: string): Promise<void> {
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [org],
  );
}

/** Seed the full lineage + in-16 outbox row for one merged run (as the DB owner). */
export async function seedMergedRun(
  owner: Pool,
  args: {
    org: string;
    project: string;
    run: string;
    spec: string;
    decision: string;
    node: string;
    sha: string;
    deliveryId: string;
  },
): Promise<void> {
  const { org, project, run, spec, decision, node, sha, deliveryId } = args;
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
     VALUES ($1, $1, 'https://example.com/repo.git', 'main', 'runner:v0', $2, '{}'::jsonb)`,
    [project, org],
  );
  await owner.query(
    `INSERT INTO integration_nodes (node_id, project_id, org_id, base_branch, base_sha, ref, purpose, member_key, head_sha, tree_hash, status)
     VALUES ($1, $2, $3, 'main', $4, 'refs/heads/main', 'merge_batch', $1, $4, 'tree-x', 'ready')`,
    [node, project, org, D],
  );
  await owner.query(
    `INSERT INTO authority_decisions
       (org_id, project_id, id, integration_node_id, subject_kind, head_sha, expected_main_sha,
        artifact_digest, proof_root, member_set_hash, policy_version, decision)
     VALUES ($1, $2, $3, $4, 'integration_node', $5, $5, $5, $5, $5, 'v1', 'authorized')`,
    [org, project, decision, node, D],
  );
  await owner.query(
    `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
     VALUES ($1, $2, $3, 't', 'd', 'in_flight')`,
    [spec, project, org],
  );
  await owner.query(
    `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch)
     VALUES ($1, $2, $3, $4, 'test', 'main')`,
    [run, spec, project, org],
  );
  // Seed the merged-run signal through the single event-writer seam (not a raw INSERT).
  await runWithJobOrgId(org, () =>
    new PgEventStore(orgScopingPool(owner)).append({
      runId: run,
      specId: spec,
      projectId: project,
      orgId: org,
      eventType: "merge.completed",
      payload: { prUrl: "https://example.com/pr/1", prNumber: 1, integration: "native_queue", mergeSha: sha },
    }),
  );
  await owner.query(
    `INSERT INTO delivery_runs (org_id, id, project_id, authority_decision_id, merge_sha, status)
     VALUES ($1, $2, $3, $4, $5, 'pending')`,
    [org, deliveryId, project, decision, sha],
  );
}

/** Append a delivery-DAG event (fire-intent / abort marker) through the event-writer seam. */
export async function seedDeliveryEvent(
  owner: Pool,
  lineage: { org: string; run: string; spec: string; project: string },
  eventType: "delivery.demo_stimulus_started",
  payload: Record<string, unknown>,
): Promise<void> {
  await runWithJobOrgId(lineage.org, () =>
    new PgEventStore(orgScopingPool(owner)).append({
      runId: lineage.run,
      specId: lineage.spec,
      projectId: lineage.project,
      orgId: lineage.org,
      eventType,
      payload,
    }),
  );
}

interface DeliveryRow {
  status: string;
  completed_at: string | null;
}
export async function deliveryRow(pool: Pool, org: string, id: string): Promise<DeliveryRow | undefined> {
  return runWithOrgScope(pool, org, async (client) => {
    const r = await client.query<DeliveryRow>(
      "SELECT status, completed_at FROM delivery_runs WHERE org_id = $1 AND id = $2",
      [org, id],
    );
    return r.rows[0];
  });
}

export async function stageStatuses(pool: Pool, org: string, deliveryId: string): Promise<Map<string, string>> {
  return runWithOrgScope(pool, org, async (client) => {
    const r = await client.query<{ stage: string; status: string }>(
      "SELECT stage, status FROM delivery_stage_attempts WHERE org_id = $1 AND delivery_run_id = $2 ORDER BY ordinal, attempt",
      [org, deliveryId],
    );
    const m = new Map<string, string>();
    // last attempt wins
    for (const row of r.rows) m.set(row.stage, row.status);
    return m;
  });
}

export async function deliveryEventTypesFor(pool: Pool, org: string, run: string): Promise<string[]> {
  return runWithOrgScope(pool, org, async (client) => {
    const r = await client.query<{ event_type: string }>(
      "SELECT event_type FROM events WHERE org_id = $1 AND run_id = $2 AND event_type LIKE 'delivery.%'",
      [org, run],
    );
    return r.rows.map((x) => x.event_type);
  });
}
