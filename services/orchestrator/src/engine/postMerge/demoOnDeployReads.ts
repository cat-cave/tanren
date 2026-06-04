// The system-scoped READS the demo-on-deploy watcher runs — split out so the watcher
// stays under the dependency/line caps and the SQL lives in one place. All reads run
// under the watcher's system scope (the de-privileged data plane re-reads the runtime
// tables); they are read-only and carry no secret material.

import type pg from "pg";
import { BehaviorStore } from "../entities/behaviors.js";
import type { ActorContext } from "../../auth/schemas.js";
import type { DemoBehavior } from "../demo/demoEngine.js";

type ReadClient = Pick<pg.Pool | pg.PoolClient, "query">;

/**
 * A run's VERIFIED deploy + the coordinates a demo records under. Resolved from the
 * run's `deploy.verified` event (the proof the deploy is live) joined to its run row
 * (spec + project + org). `alreadyDemoed` reflects a prior `demo.completed` on the run
 * (the per-run idempotency marker).
 */
export interface VerifiedDeploy {
  runId: string;
  specId: string;
  projectId: string;
  orgId: string;
  /** The deploy provider kind (`deploy.vercel` | `deploy.flyio`). */
  provider: string;
  /** The deployed app/project id the demo surface resolves against. */
  appId: string;
  /** The provider's deployment handle the demo surface status read targets. */
  deploymentId: string;
  /** Whether this run already ran a demo (a prior `demo.completed` exists). */
  alreadyDemoed: boolean;
}

interface DeployVerifiedRow {
  payload: { provider?: unknown; appId?: unknown; deploymentId?: unknown } | null;
  spec_id: string | null;
  project_id: string | null;
  org_id: string | null;
  demoed: boolean;
}

/**
 * Read a run's verified-deploy coordinates, or `undefined` when the run has no
 * `deploy.verified` (no deploy target, or not yet verified) — the clean no-op gate.
 * Joins the latest `deploy.verified` event to the run + project (spec/org) and flags
 * a prior `demo.completed` for the per-run idempotency short-circuit.
 */
export async function loadVerifiedDeploy(client: ReadClient, runId: string): Promise<VerifiedDeploy | undefined> {
  const result = await client.query<DeployVerifiedRow>(
    `SELECT v.payload,
            r.spec_id,
            r.project_id,
            p.org_id,
            EXISTS (
              SELECT 1 FROM events d WHERE d.run_id = $1 AND d.event_type = 'demo.completed'
            ) AS demoed
       FROM events v
       JOIN runs r ON r.run_id = v.run_id
       JOIN projects p ON p.project_id = r.project_id
      WHERE v.run_id = $1 AND v.event_type = 'deploy.verified'
      ORDER BY v.ts DESC, v.id DESC
      LIMIT 1`,
    [runId],
  );
  const row = result.rows[0];
  if (row === undefined || row.payload === null) return undefined;
  if (row.spec_id === null || row.project_id === null || row.org_id === null) return undefined;
  const provider = row.payload.provider;
  const appId = row.payload.appId;
  const deploymentId = row.payload.deploymentId;
  if (typeof provider !== "string" || typeof appId !== "string" || typeof deploymentId !== "string") return undefined;
  return {
    runId,
    specId: row.spec_id,
    projectId: row.project_id,
    orgId: row.org_id,
    provider,
    appId,
    deploymentId,
    alreadyDemoed: row.demoed,
  };
}

/**
 * Load the spec's behaviors as the demo engine's `DemoBehavior` exercise inputs (id +
 * title + the free-form metadata that carries `surfacePath`). Read under a
 * platform-admin actor carrying the run's org — the SAME pattern the conflict resolver
 * / DagWalker use to admit org-scoped rows while the client stays RLS-scoped.
 */
export async function loadSpecBehaviors(
  client: ReadClient,
  specId: string,
  orgId: string,
  projectId: string,
): Promise<DemoBehavior[]> {
  const actor: ActorContext = {
    userId: "demo-engine",
    orgId,
    projectId,
    scopes: ["platform:admin"],
    source: "local_dev",
  };
  const rows = await BehaviorStore.listForSpec(client, specId, actor);
  return rows.map((row) => ({ behaviorId: row.id, behaviorTitle: row.title, metadata: row.metadata }));
}
