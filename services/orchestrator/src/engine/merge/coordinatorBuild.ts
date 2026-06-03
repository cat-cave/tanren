// The production assembly of the native MergeCoordinator (autonomy-engine.md §2d),
// wired from the worker's autonomy loops alongside the DagWalker. It composes the
// pg queue model, the per-run MERGE RUNNER (which drives the EXISTING per-run merge
// path — mergeForRun in `native_queue` DRIVE mode), and the org-scoped queue-event
// emitter into the `MergeCoordinator` the subscriber drives on every notification.
//
// The drive REUSES the merge stage — it is NOT a second merge impl. `driveMergeForQueuedRun`
// calls `mergeForRun({ queueDrive: true })` for the claimed head run, which runs the
// SAME directMerge logic: P2a up-to-date/auto-rebase (server-side GitHub update +
// CI re-poll — no runner needed, it is all VcsProvider/CI calls), P2c-1 retarget,
// then merge. A real CONFLICT (P2b) on the drive pass — where the original run's
// runner is gone — is routed back to a REAL re-execution: the conflicting spec is
// reopened and re-enqueued through the SAME createQueuedRunFromSpec path the
// DagWalker/percolation uses, so its gate+checker+auditor re-run against the new
// base (the intent-preserving reconciliation happens inside a run, never a second
// runner outside one). The drive returns `conflict` (a recoverable dequeue); the
// re-run re-enters the queue once it re-gates clean.

import { runWithJobOrgId, runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { VcsProvider } from "../contracts/vcsProvider.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import { migrateProjectConfig } from "../config/projectConfig.js";
import { resolveCredentialsForRun } from "../credentials/resolveCredentials.js";
import { PgEventStore } from "../eventStore.js";
import { createQueuedRunFromSpec } from "../workflow/projectSpec.js";
import { buildReGateCiForQueuedRun } from "./driveCi.js";
import { mergeForRun } from "../workflow/reviewMerge/index.js";
import type { ConflictResolverHook, NativeQueueEnqueuer } from "../workflow/reviewMerge/index.js";
import type { MergeDriveOutcome, MergeCoordinator } from "../contracts/mergeCoordinator.js";
import { EventEmittingMergeCoordinator, type DriveMergeForQueuedRun, PgMergeQueueEventEmitter } from "./coordinator.js";
import { PgMergeQueueModel, PgMergeRunner } from "./coordinatorPg.js";

export interface BuildMergeCoordinatorDeps {
  pool: pg.Pool;
  secrets: SecretStore;
  vcsProvider: VcsProvider;
  githubAppMinter?: GithubAppTokenMinter;
}

interface RunFacts {
  orgId: string;
  projectId: string;
  specId: string;
  githubCredentialRef: string;
}

/** Resolve the queued run's org/project/spec + its GitHub credential ref (system-scoped). */
async function resolveRunFacts(pool: pg.Pool, runId: string): Promise<RunFacts> {
  const base = await runWithSystemScope(pool, async (client) => {
    const result = await client.query<{
      org_id: string | null;
      project_id: string | null;
      spec_id: string | null;
      config: unknown;
    }>(
      `SELECT r.org_id, r.project_id, r.spec_id, p.config
         FROM runs r JOIN projects p ON p.project_id = r.project_id
        WHERE r.run_id = $1`,
      [runId],
    );
    return result.rows[0];
  });
  if (base === undefined || base.org_id === null || base.project_id === null || base.spec_id === null) {
    throw new Error(`cannot drive merge: run ${runId} has no resolvable org/project/spec`);
  }
  const projectConfig = migrateProjectConfig(base.config);
  // `resolveCredentialsForRun` reads `organizations.config` for the org's provider
  // mode + default credential refs — a TENANT-table read. The coordinator drives
  // with no ambient scope, so under the `tanren_app` RLS role this read is denied
  // (empty GUC → zero rows → OrgProviderModeUnresolved for the non-empty org). The
  // org is already resolved above, so run it under that org's scope so the GUC
  // admits the row.
  const orgId = base.org_id;
  const credentials = await runWithOrgScope(pool, orgId, (client) =>
    resolveCredentialsForRun(client, { projectConfig, orgId }),
  );
  return {
    orgId,
    projectId: base.project_id,
    specId: base.spec_id,
    githubCredentialRef: credentials.githubCredentialRef,
  };
}

/**
 * The drive-pass conflict resolver: the original run's runner is gone, so an
 * intent-preserving resolution must happen INSIDE a fresh run, not a second runner.
 * It reopens the conflicting spec + re-enqueues it through the SAME
 * createQueuedRunFromSpec path (the percolation/DagWalker reuse), so the spec's own
 * gate+checker+auditor re-run against the new base. It returns `{ resolved: false }`
 * so the merge stage emits the recoverable `merge.conflict` and the queue dequeues
 * with `conflict` — the re-run re-enters the queue once it re-gates clean.
 */
function buildDriveConflictResolver(pool: pg.Pool, facts: RunFacts): ConflictResolverHook {
  return async () => {
    const actor: ActorContext = {
      userId: "merge-coordinator",
      orgId: facts.orgId,
      projectId: facts.projectId,
      scopes: ["platform:admin"],
      source: "local_dev",
    };
    // Reopen the spec so createQueuedRunFromSpec re-claims it (keep its branch/work
    // intact — only the status moves), then re-enqueue a real re-execution run.
    await runWithOrgScope(pool, facts.orgId, async (client) => {
      await client.query(
        `UPDATE specs SET status = 'pending' WHERE spec_id = $1 AND status NOT IN ('done', 'merged')`,
        [facts.specId],
      );
    });
    await createQueuedRunFromSpec(pool, { specId: facts.specId, trigger: "merge_conflict_reexec" }, actor).catch(
      (error: unknown) => {
        // A re-enqueue failure (e.g. the spec already re-claimed by another path) is
        // non-fatal: the conflict is still surfaced as a recoverable dequeue and the
        // next walk re-evaluates. Logged, never thrown into the merge drive.
        console.warn(`[merge-coordinator] conflict re-execution enqueue for spec ${facts.specId} skipped:`, error);
      },
    );
    return { resolved: false };
  };
}

/**
 * Build the production merge-drive closure: drive ONE queued run's merge through
 * the EXISTING `mergeForRun` path in `native_queue` DRIVE mode. Maps the
 * merge-stage outcome to the coordinator's drive outcome. Exported so the P2d-2
 * batch-coordinator assembly (batchCoordinatorBuild.ts) reuses the SAME drive path.
 */
export function buildDriveMerge(deps: BuildMergeCoordinatorDeps): DriveMergeForQueuedRun {
  return async ({ runId }): Promise<MergeDriveOutcome> => {
    const facts = await resolveRunFacts(deps.pool, runId);
    const eventStore = new PgEventStore(deps.pool);
    // The coordinator subscriber drives this with NO ambient org scope (it wakes on
    // the run-activity bus, not a per-org request), so `mergeForRun` — which appends
    // `task.started` / merge events via `eventStore` and does other tenant
    // reads/writes — would hit the H2 throw (no scope → MissingOrgScopeError) and the
    // outcome would be masked as `blocked`, silently dequeuing every native_queue
    // merge. `facts.orgId` is already resolved (system-scoped) above, so run the
    // whole merge drive under the run's lightweight per-job org id: every tenant
    // `.query` / event append opens a short `runWithOrgScope` carrying the org GUC.
    const merge = await runWithJobOrgId(facts.orgId, () =>
      mergeForRun({
        pool: deps.pool,
        eventStore,
        secrets: deps.secrets,
        vcsProvider: deps.vcsProvider,
        runId,
        resolvedGithubCredentialRef: facts.githubCredentialRef,
        ...(deps.githubAppMinter !== undefined && { githubAppMinter: deps.githubAppMinter }),
        // The DRIVE flag: run the SAME directMerge logic (P2a/P2b/P2c-1), labelled
        // `native_queue`. The first run-loop pass already ENQUEUED — this is the
        // coordinator's actual merge.
        queueDrive: true,
        // P2b on the drive pass: re-route the conflict to a fresh re-execution (the
        // runner is gone), returning unresolved → a recoverable conflict dequeue.
        resolveConflict: buildDriveConflictResolver(deps.pool, facts),
        // P2a re-gate: re-poll the PR's CI via the VcsProvider after an auto-rebase
        // (no runner needed — it is a CI-status read).
        reGateCi: buildReGateCiForQueuedRun({
          pool: deps.pool,
          eventStore,
          secrets: deps.secrets,
          vcsProvider: deps.vcsProvider,
          runId,
          githubCredentialRef: facts.githubCredentialRef,
        }),
      }),
    );
    switch (merge.outcome) {
      case "merged":
        // P2d: the run-loop's first pass left the spec NON-`done` (Tanren owns the
        // merge); the DRIVE pass is what actually merged, so it sets the spec
        // `merged` HERE (the merge dispatcher only finalizes the task). This is the
        // single point the ancestor's status reaches `merged` — which is exactly
        // what unblocks its dependents in `mergedSpecIds` + the P2c-1 hold.
        await markSpecMerged(deps.pool, facts);
        return { kind: "merged", ...(merge.mergeSha !== undefined && { mergeSha: merge.mergeSha }) };
      case "conflict":
        return { kind: "conflict", message: merge.message ?? "merge conflict" };
      case "blocked":
        return { kind: "blocked", message: merge.message ?? "merge blocked" };
      default:
        return { kind: "failed", message: merge.message ?? `merge ${merge.outcome}` };
    }
  };
}

/**
 * Set the merged spec's status to `merged` under RLS (the drive-pass spec
 * finalize). Mirrors what `finalizeMergeOutcome` does in the run loop for a
 * `direct_merge`, but for the coordinator-driven `native_queue` merge — the only
 * place a native_queue spec reaches `merged`. The transition guard keeps it
 * idempotent (a spec already `merged`/`done` is left alone).
 */
async function markSpecMerged(pool: pg.Pool, facts: RunFacts): Promise<void> {
  await runWithOrgScope(pool, facts.orgId, async (client) => {
    await client.query(`UPDATE specs SET status = 'merged' WHERE spec_id = $1 AND status NOT IN ('merged', 'done')`, [
      facts.specId,
    ]);
  });
}

/**
 * Build the production native-queue enqueuer (the run-loop's first-pass hook): a
 * thin closure over the PgMergeQueueModel that persists the queue entry under RLS
 * (idempotent — a run already queued/merging is not re-queued). The run worker
 * wires this into the run loop so a ready `native_queue` run enters the queue.
 */
export function buildNativeQueueEnqueuer(pool: pg.Pool): NativeQueueEnqueuer {
  const model = new PgMergeQueueModel(pool);
  return async (input) => {
    const { created } = await model.enqueue(input);
    return { created };
  };
}

/** Assemble the production native MergeCoordinator (P2d-1: one-at-a-time DAG-ordered). */
export function buildMergeCoordinator(deps: BuildMergeCoordinatorDeps): MergeCoordinator {
  return new EventEmittingMergeCoordinator({
    queue: new PgMergeQueueModel(deps.pool),
    runner: new PgMergeRunner(buildDriveMerge(deps)),
    events: new PgMergeQueueEventEmitter(deps.pool),
  });
}
