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
// native re-gate that provisions a FRESH runner + clones the PR head + runs `pre_merge`
// over SSH — the merge authority, no forge poll), retarget, then merge. A real CONFLICT on the drive pass — where the original run's
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
import type { GitHubHttpClient } from "../providers/github.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import { migrateProjectConfig } from "../config/projectConfig.js";
import { orgScopeFromRunOrgId, resolveCredentialsForRun } from "../credentials/resolveCredentials.js";
import { buildReGateCiForQueuedRun } from "./driveCi.js";
import {
  buildDriveConflictResolve,
  type DriveConflictVerdict,
  PercolationOwnsSpecError,
} from "./driveConflictResolve.js";
import { mergeForRun } from "../workflow/reviewMerge/index.js";
import type {
  MergeForRunInput,
  NativeQueueEnqueuer,
  NativeQueueOnClientEnqueuer,
} from "../workflow/reviewMerge/index.js";
import { buildDriveReGateGateRework } from "./driveReGateRework.js";
import type { MergeDriveOutcome } from "../contracts/mergeCoordinator.js";
import type { DriveMergeForQueuedRun } from "./coordinator.js";
import { PgMergeQueueModel } from "./coordinatorPg.js";
import { buildBaseShiftCoordinator } from "../dag/percolationBuild.js";
import { buildBaseShiftRebaseHook } from "../dag/baseShiftRebaseHook.js";

export interface BuildMergeCoordinatorDeps {
  pool: pg.Pool;
  secrets: SecretStore;
  /** The shared (timed) GitHub HTTP client the run/merge host seams build over. */
  githubHttp: GitHubHttpClient;
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
   * REQUIRED (audit finding D3/H3 sweep): the coordinator routes every
   * tenant write it drives through this writer — the merge stage's
   * events/tasks/runs/specs (mergeForRun's `eventStore` + `runStateWriter`
   * seams), the drive-pass spec-status finalize, the conflict resolver's
   * replan spec-status write, and the queue/batch event emissions. Default
   * is the in-process `DirectRunStateWriter` (byte-identical to the prior
   * direct path); the cross-process `worker` container resolves it to an
   * `HttpRunStateWriter` over mTLS.
   */
  runStateWriter: RunStateWriter;
  /**
   * TEST SEAM: the merge-stage freshness/retarget probe. Production OMITS it → the drive
   * builds the real `CodeHost`-derived freshness probe from the GitHub provider (§5h). A
   * no-DB unit run (no GitHub provider) injects it so the drive's freshness read does not
   * require a GitHub HTTP client.
   */
  mergeProbe?: MergeForRunInput["mergeProbe"];
  /**
   * TEST SEAM: the in-loop `behind` base-shift hook. Production OMITS it → the drive wires
   * the live `BaseShiftCoordinator` (§5h). A no-DB unit run injects a scripted hook so the
   * `behind` rebase surfaces a controlled outcome without allocating a runner.
   */
  baseShiftRebaseOverride?: MergeForRunInput["baseShiftRebase"];
}

interface RunFacts {
  orgId: string;
  projectId: string;
  specId: string;
  runId: string;
  githubCredentialRef: string;
  /** The run's PR number (for the re-gate-rework router's observable event); 0 when unresolvable. */
  prNumber: number;
}

/** Resolve the queued run's org/project/spec + its GitHub credential ref (system-scoped). */
async function resolveRunFacts(pool: pg.Pool, runId: string): Promise<RunFacts> {
  const base = await runWithSystemScope(pool, async (client) => {
    const result = await client.query<{
      org_id: string | null;
      project_id: string | null;
      spec_id: string | null;
      config: unknown;
      pr_number: string | null;
    }>(
      `SELECT r.org_id, r.project_id, r.spec_id, p.config, mq.pr_number
         FROM runs r
         JOIN projects p ON p.project_id = r.project_id
         LEFT JOIN merge_queue mq ON mq.run_id = r.run_id
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
    resolveCredentialsForRun(client, { projectConfig, orgScope: orgScopeFromRunOrgId(orgId) }),
  );
  const prNumber = base.pr_number === null ? 0 : Number(base.pr_number);
  return {
    orgId,
    projectId: base.project_id,
    specId: base.spec_id,
    runId,
    githubCredentialRef: credentials.githubCredentialRef,
    prNumber: Number.isFinite(prNumber) ? prNumber : 0,
  };
}

/**
 * Build the production merge-drive closure: drive ONE queued run's merge through
 * the EXISTING `mergeForRun` path in `native_queue` DRIVE mode. Maps the
 * merge-stage outcome to the coordinator's drive outcome. Exported so the batch former
 * batch-coordinator assembly (batchCoordinatorBuild.ts) reuses the SAME drive path.
 */
export function buildDriveMerge(deps: BuildMergeCoordinatorDeps): DriveMergeForQueuedRun {
  // THE ONE BASE-SHIFT HANDLER (§7): the merge-path `behind` rebase routes through the
  // SAME `BaseShiftCoordinator` the change-percolation kick-off uses (the live jj seams;
  // the allocator/ssh/identity are the SAME the drive resolver uses) — never a second
  // server-side update-branch. Built once per drive build.
  const baseShiftCoordinator = buildBaseShiftCoordinator(
    {
      pool: deps.pool,
      githubHttp: deps.githubHttp,
      secrets: deps.secrets,
      ...(deps.githubAppMinter !== undefined && { githubAppMinter: deps.githubAppMinter }),
      runStateWriter: deps.runStateWriter,
      allocator: deps.allocator,
      ssh: deps.ssh,
      identitySecretRef: deps.identitySecretRef,
    },
    // P1 fix: the merge-queue `behind` rebase is SYNCHRONOUS (this drive re-gates + merges
    // in the same pass) — suppress the `percolation_pending` marker so the run is NEVER
    // picked up + mis-settled by the change-percolation poller.
    { suppressInFlightMarker: true },
  );
  const baseShiftRebase =
    deps.baseShiftRebaseOverride ?? buildBaseShiftRebaseHook({ pool: deps.pool, coordinator: baseShiftCoordinator });
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
    // Audit finding D3/H3 sweep: the writer is REQUIRED and itself IS an
    // EventStore, so the merge stage's event surface is just the writer.
    const eventStore = deps.runStateWriter;
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
          // Audit finding D3/H3 sweep: writer is REQUIRED at the merge seam.
          runStateWriter: deps.runStateWriter,
          secrets: deps.secrets,
          githubHttp: deps.githubHttp,
          runId,
          resolvedGithubCredentialRef: facts.githubCredentialRef,
          // TEST SEAM: an injected freshness/retarget probe (a no-DB unit run); production
          // omits it → the merge stage builds the real `CodeHost`-derived probe (§5h).
          ...(deps.mergeProbe !== undefined && { mergeProbe: deps.mergeProbe }),
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
            githubHttp: deps.githubHttp,
            ...(deps.githubAppMinter !== undefined && { githubAppMinter: deps.githubAppMinter }),
            runStateWriter: deps.runStateWriter,
            eventStore,
            identitySecretRef: deps.identitySecretRef,
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
            githubHttp: deps.githubHttp,
            allocator: deps.allocator,
            ssh: deps.ssh,
            identitySecretRef: deps.identitySecretRef,
            orgId: facts.orgId,
            projectId: facts.projectId,
            specId: facts.specId,
            runId,
            githubCredentialRef: facts.githubCredentialRef,
            ...(deps.githubAppMinter !== undefined && { githubAppMinter: deps.githubAppMinter }),
          }),
          // THE ONE BASE-SHIFT HANDLER (§7): a `behind` PR branch rebases in place over
          // jj through the SAME coordinator the percolation kick-off uses — never a
          // separate server-side update-branch. `held` is a fail-closed recoverable hold.
          baseShiftRebase,
          // A clean-rebase re-gate that FAILS a gate tier on the drive pass routes to WRITER
          // REWORK (#594 extended to this auto-rebase path), never a terminal `merge.failed`
          // that stranded a fixable spec. The router re-opens the spec + enqueues a re-author
          // run; escalation on a genuine dead-end is the convergence detector's (no count).
          reGateGateRework: buildDriveReGateGateRework({
            pool: deps.pool,
            runStateWriter: deps.runStateWriter,
            orgId: facts.orgId,
            eventStore,
            runId,
            projectId: facts.projectId,
            prNumber: facts.prNumber,
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
        // CLASSIFY-THEN-ESCALATE from the drive-path resolver disposition + optional
        // durable recovery receipt. Never fabricate conflict ownership without a receipt.
        if (verdict.disposition === "escalate" || verdict.recovery === undefined) {
          return {
            kind: "needs_attention",
            message: verdict.message ?? merge.message ?? "specs' intents conflict",
            parking: "required",
          };
        }
        return {
          kind: "conflict",
          message: merge.message ?? "merge conflict",
          recovery: verdict.recovery,
        };
      case "blocked":
        // §3.2: a TRANSIENT authority refusal / benign CAS hold the merge stage surfaced
        // as recoverable `blocked`. Map to the coordinator's recoverable `blocked` — a
        // bounded re-drive hold, NEVER a terminal dequeue.
        return { kind: "blocked", message: merge.message ?? "merge blocked" };
      case "re_gate_pending":
        // The post-auto-rebase native re-gate is NOT YET TERMINAL (still running / infra blip):
        // re-drivable, "not done yet" — NOT non-convergence and NOT a conflict. Map to the
        // coordinator's `re_gate_pending` so the entry stays queued + re-drives until the gate
        // finishes, NEVER dequeued (the old `conflict` mapping bricked the live run) and NEVER
        // bounded by a fixed attempt cap.
        return { kind: "re_gate_pending", message: merge.message ?? "native re-gate not yet terminal" };
      case "needs_attention":
        // §3.2: the merge AUTHORITY's genuine-human-decision verdict (HITL pending /
        // changes_requested at land time). PARK the spec via the escalator (frees its
        // slot) — NOT a recoverable hold (no re-drive resolves a human decision) and NOT a
        // terminal conflict dequeue.
        return { kind: "needs_attention", message: merge.message ?? "merge needs human attention", parking: "required" };
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
async function markSpecMerged(_pool: pg.Pool, facts: RunFacts, runStateWriter: RunStateWriter): Promise<void> {
  // Audit D-R3.2: REQUIRED writer — the in-process org-scoped UPDATE fallback was an
  // unreachable half-measure once PR #714's `runStateWriterFromEnv` always returned one.
  await runStateWriter.setSpecStatus({
    specId: facts.specId,
    orgId: facts.orgId,
    status: "merged",
    notFromStatuses: ["merged"],
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

/**
 * ATOMICITY (PR #724 follow-up — `apex` v67/v69 root cause #2): build the on-client
 * native-queue enqueuer the writer-seam's post-PR-open atomic block uses. The seam owns
 * the `runWithOrgScope` BEGIN/COMMIT; this closure JOINS that transaction so the
 * merge_queue INSERT co-commits with the companion `github.pr.created` + `merge.scheduled`
 * appends — all three commit together or all three roll back together. PR #724 fixed the
 * WHEN (enqueue right after `github.pr.created`) but left the writes in 3 separate
 * transactions; the seam's atomic block closes the gap. Wired alongside
 * {@link buildNativeQueueEnqueuer} from the worker boot so both the late-path enqueue
 * (own-scope) and the early-path atomic enqueue (caller-scope) share the SAME underlying
 * `PgMergeQueueModel` — one source of truth for the INSERT semantics.
 */
export function buildAtomicNativeQueueEnqueuer(pool: pg.Pool): NativeQueueOnClientEnqueuer {
  const model = new PgMergeQueueModel(pool);
  return async (client, orgId, input) => {
    // The seam always passes a pg.PoolClient (it opened the runWithOrgScope to obtain
    // it). The `unknown` in the signature exists so the seam abstraction does not leak
    // `pg` into the wider planner-loop type graph; the cast here is the only place that
    // narrowing lives.
    const { created } = await model.enqueueOnClient(client as pg.PoolClient, orgId, input);
    return { created };
  };
}
