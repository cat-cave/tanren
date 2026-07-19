// The system-scoped READS the demo-on-deploy watcher runs — split out so the watcher
// stays under the dependency/line caps and the SQL lives in one place. All reads run
// under the watcher's system scope (the de-privileged data plane re-reads the runtime
// tables); they are read-only and carry no secret material.

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import { z } from "zod";
import { BehaviorStore } from "../entities/behaviors.js";
import type { ActorContext } from "../../auth/schemas.js";
import type { ReleaseInstanceRecord } from "../contracts/deployAdapter.js";
import type { DemoBehavior } from "../demo/demoEngine.js";
import { ReleaseInstancesStore } from "../repositories/releaseInstances.js";
import { loadValidatedRunEvent } from "./runLineage.js";

type ReadClient = Pick<pg.Pool | pg.PoolClient, "query">;

// The freshest deploy states a live release can be probed/demoed in (mirrors the rv-6
// PgReleaseInstanceBaseUrlResolver): superseded / torn-down / rolled-back / failed are
// never demoed.
const PROBEABLE_STATES = new Set(["built", "preview", "promoting", "live"]);
const DeployVerifiedPayload = z.object({ provider: z.string(), appId: z.string(), deploymentId: z.string() });

/**
 * A run's VERIFIED deploy + the coordinates a demo records under. Resolved from the
 * run's `deploy.verified` event (the proof the deploy is live) joined to its run row
 * (spec + project + org). `alreadyTerminalDemo` reflects a prior TERMINAL demo outcome
 * on the run — either `demo.completed` (success) OR `demo.failed` (durable failure).
 * BOTH must gate: `demo.failed`'s append wakes the run-activity bus (per
 * `eventStore.ts`), so gating only on `demo.completed` self-loops on any real demo
 * failure — the next wake re-enters `check()`, re-throws, re-appends `demo.failed`, and
 * storms `warn`s at the operator per merge. Mirrors `deployOnMerge.ts`'s
 * `alreadyTerminal` discipline (which unifies `deploy.verified` + `deploy.failed` +
 * `deploy.skipped` under one terminal gate).
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
  /** Whether this run already reached a terminal demo outcome (`demo.completed` OR `demo.failed`). */
  alreadyTerminalDemo: boolean;
}

/**
 * Read a run's verified-deploy coordinates, or `undefined` when the run has no
 * `deploy.verified` (no deploy target, or not yet verified) — the clean no-op gate.
 * Joins the latest `deploy.verified` event to the run + project (spec/org) and flags
 * a prior TERMINAL demo outcome (`demo.completed` OR `demo.failed`) for the per-run
 * idempotency short-circuit — the unified terminal check that prevents `demo.failed`
 * from self-looping through the run-activity NOTIFY wake.
 */
export async function loadVerifiedDeploy(client: ReadClient, runId: string): Promise<VerifiedDeploy | undefined> {
  const verified = await loadValidatedRunEvent(client, {
    runId,
    eventType: "deploy.verified",
    requireEventSpec: false,
  });
  if (verified === undefined) return undefined;
  const payload = DeployVerifiedPayload.safeParse(verified.payload);
  if (!payload.success) return undefined;
  const terminal = await client.query<{ demoed: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM events d
        WHERE d.run_id = $1 AND d.org_id = $2 AND d.project_id = $3
          AND d.event_type IN ('demo.completed', 'demo.failed')
     ) AS demoed`,
    [runId, verified.lineage.orgId, verified.lineage.projectId],
  );
  return {
    ...verified.lineage,
    provider: payload.data.provider,
    appId: payload.data.appId,
    deploymentId: payload.data.deploymentId,
    alreadyTerminalDemo: terminal.rows[0]?.demoed ?? false,
  };
}

/**
 * Load the spec's behaviors as the demo engine's `DemoBehavior` exercise inputs (id +
 * title + the free-form metadata that carries `surfacePath`). Read under a
 * platform-admin actor carrying the run's org — the SAME pattern the conflict resolver
 * / DagWalker use to admit org-scoped rows while the client stays RLS-scoped.
 */
/**
 * Load the run's deployed release instance — the one built for THIS run's integration
 * node (rv-6 binds `integration_node_id == runId`; see deployOnMerge). Returns the
 * FRESHEST probeable release with a non-empty URL (org-scoped via the existing
 * RLS-proven {@link ReleaseInstancesStore}; no new tenant SQL), or `undefined` when the
 * run has no probeable release to demo. The proof-backed web demo reads its
 * `behaviorRevisionIds` (which declared behaviors the release delivers) from this row; the
 * rv-6 resolver independently binds the same integration node's URL for the HTTP driver.
 */
export async function loadRunReleaseInstance(
  pool: pg.Pool,
  orgId: string,
  projectId: string,
  runId: string,
): Promise<ReleaseInstanceRecord | undefined> {
  const instances = await runWithOrgScope(pool, orgId, (client) =>
    ReleaseInstancesStore.listForProject(client, orgId, projectId),
  );
  // listForProject orders oldest→newest, so the LAST match is the freshest deploy for
  // this run's integration node.
  let release: ReleaseInstanceRecord | undefined;
  for (const instance of instances) {
    if (instance.integrationNodeId === runId && instance.url !== "" && PROBEABLE_STATES.has(instance.state)) {
      release = instance;
    }
  }
  return release;
}

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
