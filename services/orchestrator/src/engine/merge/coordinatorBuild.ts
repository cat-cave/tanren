// The production drive closures for the native merge queue (autonomy-engine.md §2d),
// wired from the worker's autonomy loops alongside the DagWalker. `buildDriveMerge`
// is the per-run MERGE RUNNER (it drives the EXISTING per-run merge path — mergeForRun
// in `native_queue` DRIVE mode); `buildNativeQueueEnqueuer` is the run-loop's first-pass
// enqueue hook. The batch coordinator assembly (batchCoordinatorBuild.ts) composes these
// into the `MergeCoordinator` the subscriber drives on every notification.
//
// The drive REUSES the merge stage — it is NOT a second merge impl. `driveMergeForQueuedRun`
// calls `mergeForRun({ queueDrive: true })` for the claimed head run, which runs the
// SAME directMerge logic: up-to-date/auto-rebase (server-side GitHub update +
// CI re-poll — no runner needed, it is all VcsProvider/CI calls), retarget,
// then merge. A real CONFLICT on the drive pass — where the original run's
// runner is gone — is now resolved by the REAL intent-preserving conflict resolver
// driveConflictResolve.ts: the drive PROVISIONS a short-lived runner + workspace
// and runs the SAME resolver the in-loop direct_merge path runs, then CLASSIFIES the
// outcome (resolved → the merge retries + lands; bounded re-plan → recoverable
// `conflict`; genuine product clash / re-plan budget exhausted → the `needs_attention`
// escalation PR1 parks; percolation owns the spec → a recoverable hold). The
// blind-re-exec stub is GONE — a drive-path conflict now reasons, never just re-runs.

import { runWithJobOrgId, runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import { orgScopingPool } from "../data/orgScopedDb.js";
import type { Allocator } from "../contracts/allocator.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import type { VcsProvider } from "../contracts/vcsProvider.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import { migrateProjectConfig } from "../config/projectConfig.js";
import { resolveCredentialsForRun } from "../credentials/resolveCredentials.js";
import { PgEventStore } from "../eventStore.js";
import { buildReGateCiForQueuedRun } from "./driveCi.js";
import {
  buildDriveConflictResolve,
  type DriveConflictVerdict,
  PercolationOwnsSpecError,
} from "./driveConflictResolve.js";
import { mergeForRun } from "../workflow/reviewMerge/index.js";
import type { NativeQueueEnqueuer } from "../workflow/reviewMerge/index.js";
import type { MergeDriveOutcome } from "../contracts/mergeCoordinator.js";
import type { DriveMergeForQueuedRun } from "./coordinator.js";
import { PgMergeQueueModel } from "./coordinatorPg.js";

/** The default timeout (ms) the drive-path resolver's SSH/git/model ops run under. */
const DRIVE_RESOLVER_TIMEOUT_MS = 600_000;

export interface BuildMergeCoordinatorDeps {
  pool: pg.Pool;
  secrets: SecretStore;
  vcsProvider: VcsProvider;
  githubAppMinter?: GithubAppTokenMinter;
  /**
   * The runner allocator the drive-path conflict resolver provisions a short-lived
   * runner from (the original run's runner is gone by drive time). REQUIRED for a
   * managed/native_queue run — a missing allocator is a LOUD throw on the conflict
   * path, NEVER a silent revert to the deleted blind-re-exec.
   */
  allocator: Allocator;
  /** The SSH substrate the drive-path resolver clones + re-gates over. REQUIRED (see allocator). */
  ssh: CommandSubstrate;
  /** The runner identity key ref (same value the worker boot seeds). REQUIRED for the resolver. */
  identitySecretRef: string;
  /**
   * Plane-split (autonomy loops): the control-plane run-state writer. When present
   * (remote-writes on), the coordinator routes EVERY tenant write it drives through
   * the control plane: the merge stage's events/tasks/runs/specs (mergeForRun's
   * `eventStore` + `runStateWriter` seams), the drive-pass spec-status finalize, the
   * conflict resolver's replan spec-status write, and the queue/batch event
   * emissions. Absent (single-role dev), the coordinator writes those tables
   * directly — byte-identical to today.
   */
  runStateWriter?: RunStateWriter;
}

interface RunFacts {
  orgId: string;
  projectId: string;
  specId: string;
  runId: string;
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
    runId,
    githubCredentialRef: credentials.githubCredentialRef,
  };
}

/**
 * Build the production merge-drive closure: drive ONE queued run's merge through
 * the EXISTING `mergeForRun` path in `native_queue` DRIVE mode. Maps the
 * merge-stage outcome to the coordinator's drive outcome. Exported so the batch former
 * batch-coordinator assembly (batchCoordinatorBuild.ts) reuses the SAME drive path.
 */
export function buildDriveMerge(deps: BuildMergeCoordinatorDeps): DriveMergeForQueuedRun {
  return async ({ runId }): Promise<MergeDriveOutcome> => {
    const facts = await resolveRunFacts(deps.pool, runId);
    // RLS scope for the merge drive's TENANT-TABLE READS. The coordinator subscriber
    // wakes on the run-activity bus with NO ambient org scope (not a per-org request),
    // so a raw `deps.pool.query` for a tenant table runs under the `tanren_app`
    // (NOBYPASSRLS) role with an EMPTY `app.current_org_id` GUC → deny-by-default RLS
    // returns ZERO rows. The merge stage's first read is `loadReviewMergeRunContext`
    // (runs ⋈ projects ⋈ organizations) — an empty result there throws
    // `ReviewMergeRunNotFoundError`, the coordinator masks the throw as
    // `{kind:"blocked"}`, and a CLEAN, mergeable PR is silently dequeued and stranded.
    // `resolveSpeculativeState`, `ensureMergeTask`'s SELECT, and the re-gate CI poll's
    // run/PR reads are the same class of read on the same raw pool.
    //
    // `facts.orgId` is already resolved (system-scoped) above, so we run the whole
    // drive under the run's lightweight per-job org id (`runWithJobOrgId`, holds NO
    // connection) AND hand the read paths an `orgScopingPool`: its `.query` self-routes
    // EACH statement through a SHORT `runWithOrgScope` carrying the org GUC (the same
    // seam the run executor / intake feed the workflow). A connection is held only for
    // the duration of one DB op, NEVER across the GitHub merge/CI calls `mergeForRun`
    // interleaves — so we scope the reads without pinning a connection across I/O.
    const scopedPool = orgScopingPool(deps.pool);
    // Plane-split: when a writer is wired, the merge stage appends its events +
    // drives its run/spec/task writes through the control plane (the writer IS an
    // EventStore + carries the run/spec/task lifecycle writer). Absent, the merge
    // stage uses the in-process PgEventStore over the org-scoping pool (its appends
    // self-route through the per-job org scope) — byte-identical to today.
    const eventStore = deps.runStateWriter ?? new PgEventStore(scopedPool);
    // The §2c classify-then-escalate capture cell: the merge dispatcher only sees the
    // conflict hook's `{resolved:boolean}`, so the drive-path resolver records its
    // autonomous disposition (resolved / bounded-replan / escalate / percolation-yield)
    // HERE for the outcome map below. The conflict resolver provisions a fresh runner +
    // workspace + runs the REAL intent-preserving resolver (the blind-re-exec stub is gone).
    const verdict: DriveConflictVerdict = {};
    // §5 cutover: the gate + review verdicts are RE-READ FRESH at land time by the
    // bundle builder (`buildBundleForMergeStage` → `resolveLandTimeSignals`), AFTER any
    // drive-pass resolver re-gates — so the DRIVE pass authorizes against the LATEST
    // durable verdict, identical to the in-loop path. The coordinator no longer threads
    // a pre-captured verdict (that risked authorizing against pre-resolution state).
    let merge;
    try {
      merge = await runWithJobOrgId(facts.orgId, () =>
        mergeForRun({
          pool: scopedPool,
          eventStore,
          // Plane-split: route the merge stage's run/spec/task lifecycle writes
          // through the control plane when wired (else the in-process org-scoped
          // writes run — byte-identical to today).
          ...(deps.runStateWriter !== undefined && { runStateWriter: deps.runStateWriter }),
          secrets: deps.secrets,
          vcsProvider: deps.vcsProvider,
          runId,
          resolvedGithubCredentialRef: facts.githubCredentialRef,
          ...(deps.githubAppMinter !== undefined && { githubAppMinter: deps.githubAppMinter }),
          // The DRIVE flag: run the SAME directMerge logic (up-to-date/rebase +
          // conflict-resolution + retarget), labelled `native_queue`. The first
          // run-loop pass already ENQUEUED — this is the
          // coordinator's actual merge.
          queueDrive: true,
          // on the drive pass: the REAL intent-preserving conflict resolver. It
          // provisions a short-lived runner (the original run's is gone), clones
          // head+base, runs the same resolver the in-loop direct_merge path runs, and
          // classifies the outcome into `verdict` (resolved → retry+land; bounded
          // re-plan → recoverable conflict; genuine clash / budget exhausted →
          // needs_attention; percolation owns it → a yield throw). LOUD if deps missing.
          resolveConflict: buildDriveConflictResolve({
            pool: deps.pool,
            scopedPool,
            facts,
            allocator: deps.allocator,
            ssh: deps.ssh,
            secrets: deps.secrets,
            vcsProvider: deps.vcsProvider,
            ...(deps.githubAppMinter !== undefined && { githubAppMinter: deps.githubAppMinter }),
            ...(deps.runStateWriter !== undefined && { runStateWriter: deps.runStateWriter }),
            eventStore,
            identitySecretRef: deps.identitySecretRef,
            timeoutMs: DRIVE_RESOLVER_TIMEOUT_MS,
            verdict,
          }),
          // NATIVE re-gate (no-Actions): after an auto-rebase the prior verdict is
          // stale, so provision a FRESH runner, clone the PR head, install deps, and
          // run the `pre_merge` gate over SSH (the merge authority — no forge poll).
          // The runs⋈projects⋈org bootstrap read is system-scoped on `deps.pool`; the
          // runner allocation + events scope to the run's org.
          reGateCi: buildReGateCiForQueuedRun({
            pool: deps.pool,
            scopedPool,
            eventStore,
            secrets: deps.secrets,
            vcsProvider: deps.vcsProvider,
            allocator: deps.allocator,
            ssh: deps.ssh,
            identitySecretRef: deps.identitySecretRef,
            orgId: facts.orgId,
            projectId: facts.projectId,
            specId: facts.specId,
            runId,
            githubCredentialRef: facts.githubCredentialRef,
            ...(deps.githubAppMinter !== undefined && { githubAppMinter: deps.githubAppMinter }),
            timeoutMs: DRIVE_RESOLVER_TIMEOUT_MS,
          }),
        }),
      );
    } catch (error) {
      // PERCOLATION MUTUAL EXCLUSION: the conflict hook threw because
      // change-percolation already owns this spec. The drive YIELDS — a recoverable
      // `blocked` hold (the entry leaves the head; the subscriber re-drives later),
      // NEVER an escalation and NEVER a race with percolation's own re-exec.
      if (error instanceof PercolationOwnsSpecError) {
        return { kind: "blocked", message: error.message };
      }
      throw error;
    }
    switch (merge.outcome) {
      case "merged":
        // the run-loop's first pass left the spec NON-`done` (Tanren owns the
        // merge); the DRIVE pass is what actually merged, so it sets the spec
        // `merged` HERE (the merge dispatcher only finalizes the task). This is the
        // single point the ancestor's status reaches `merged` — which is exactly
        // what unblocks its dependents in `mergedSpecIds` + the merge-hold.
        await markSpecMerged(deps.pool, facts, deps.runStateWriter);
        return { kind: "merged", ...(merge.mergeSha !== undefined && { mergeSha: merge.mergeSha }) };
      case "conflict":
        // CLASSIFY-THEN-ESCALATE: the merge stage emitted a recoverable `conflict`
        // (the resolver returned `{resolved:false}`). The drive-path resolver's
        // disposition decides what the queue does with it:
        //   - `escalate` — the two intents are GENUINELY incompatible (the bounded
        //     re-plan budget is exhausted): park the spec at `needs_attention` (PR1's
        //     escalator), NEVER re-queued. A product decision, not an error.
        //   - `replanned` (default) — a bounded autonomous re-plan is in flight (the
        //     resolver routed a spec back to the planner WITH the other change): a
        //     recoverable `conflict` — the re-planned spec re-runs + re-enters the queue.
        if (verdict.disposition === "escalate") {
          return { kind: "needs_attention", message: verdict.message ?? merge.message ?? "specs' intents conflict" };
        }
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
async function markSpecMerged(pool: pg.Pool, facts: RunFacts, runStateWriter?: RunStateWriter): Promise<void> {
  // Plane-split: route the guarded merged-status finalize through the control plane
  // when a writer is wired; else the in-process org-scoped UPDATE — byte-identical.
  if (runStateWriter !== undefined) {
    await runStateWriter.setSpecStatus({
      specId: facts.specId,
      orgId: facts.orgId,
      status: "merged",
      notFromStatuses: ["merged"],
    });
    return;
  }
  await runWithOrgScope(pool, facts.orgId, async (client) => {
    await client.query(`UPDATE specs SET status = 'merged' WHERE spec_id = $1 AND status <> 'merged'`, [facts.specId]);
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
