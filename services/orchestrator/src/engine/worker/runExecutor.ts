// the dequeue→execute seam. `executeNextPlanJob` atomically claims one queued
// `plan` job, re-hydrates its `PlannerRunContext`, and runs the real
// plan→write→check→audit→draft-PR→CI workflow to completion.
//
// The workflow (`runPlannerLoopWorkflow`) owns its own run finalization:
// `done/ok` on pass, `halted/<reason>` on non-pass, `failed/failed` on mid-run
// throw. The worker-level catch does the two extra things the workflow can't:
// (1) fail the claimed job row, and (2) re-finalize a run stuck `failed` or
// `running` (crash) into a recoverable `halted` — so nothing disappears.
//
// Idempotency: the claim is atomic (`FOR UPDATE SKIP LOCKED` → CAS to
// `running`), so a job is handed to exactly one worker. A crash between claim
// and finalize leaves `running`; the recovery surface + reaper re-queue it.

import { runWithJobOrgId, runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import { orgScopingPool } from "../data/orgScopedDb.js";
import type { Allocator } from "../contracts/allocator.js";
import { DirectJobClaimClient, type JobClaimClient } from "../contracts/jobClaim.js";
import type { JobQueue } from "../contracts/jobQueue.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { RunCredentialScoping } from "../workflow/plannerRunScopedCreds.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import { CostRecorder } from "../costs/recorder.js";
import type { GitHubHttpClient } from "../providers/github.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import {
  buildAncestorPhaseReader,
  buildAtomicNativeQueueEnqueuer,
  buildBootstrapStackHeadShaWriteBack,
  buildEagerBaseNodeUpsert,
  buildNativeQueueEnqueuer,
  buildRedriveHistoryReader,
  buildTriageNewSpecsMaterializer,
  DirectRunStateWriter,
  triageMaterializerSystemActor,
} from "./runWorkflowPorts.js";
import { createLogger, finalizeRunRecoverable, rawCauseOf } from "./runFinalize.js";
import { classifyRunFailure } from "./runFailureClassifier.js";
import { JobProgressSignal, instrumentSubstrateProgress, startHeartbeat } from "./runHeartbeat.js";
import type { HeartbeatMiss, JobStall } from "./runHeartbeat.js";
import { systemActor } from "../state/actor.js";
import { resolveAppEnvForScope } from "../workflow/resolveAppEnv.js";
import type { AppEnvScope } from "../repositories/appEnvironment.js";
import {
  loadRunExecutionContext,
  refineRunnerImageForEnv,
  type EnvCreationDeps,
  type RunExecutionContext,
} from "./runExecutionContext.js";
import { runPlannerLoopWorkflow, type PlannerRunResult, type RunPlannerLoopInput } from "../workflow/plannerRun.js";

const log = createLogger("run-executor");

// TIMEOUT-ERADICATION (feedback_no_timeouts_progress_based): no per-stage wall-clock
// kill; ActivityWatchdog governs, unbounded on sign-of-life. The only legit time bound
// is SSH connect-establishment (engine/ssh/ssh2Substrate.ts).
export const DEFAULT_CI_POLL_DELAY_MS = 10_000;

// queue lease recovery. While a claimed job executes, the worker
// renews its lease on this interval; the lease window is a multiple of the
// interval so a single missed heartbeat does not trip the reaper. A crashed
// worker stops heartbeating, its lease lapses, and the reaper recovers the job.
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
export const DEFAULT_LEASE_MS = 60_000;

export interface RunExecutorDeps {
  pool: pg.Pool;
  jobQueue: JobQueue;
  // Job CLAIM seam. Default `DirectJobClaimClient` over `jobQueue`; cross-process
  // worker container injects an `HttpJobClaimClient` (mTLS control-plane endpoint).
  claimClient?: JobClaimClient;
  // REQUIRED (audit D3/H3 sweep): every workflow stage's terminal row + event pair
  // rides this writer. Direct default; HttpRunStateWriter under remote-writes.
  runStateWriter: RunStateWriter;
  allocator: Allocator;
  ssh: CommandSubstrate;
  secrets: SecretStore;
  // Managed-hosting dimension D: the per-run credential-scoping seam (Vault backend
  // only). Wired ⇒ the workflow mints a child token scoped to ONLY this run's cred
  // ref paths and reads the run's credentials through it (the broad VAULT_TOKEN
  // never reaches a runner). Omitted for a non-Vault backend.
  credentialScoping?: RunCredentialScoping;
  /** The shared (timed) GitHub HTTP client the run/merge host seams build over. */
  githubHttp: GitHubHttpClient;
  // Part 2: shared App installation-token minter, threaded into the
  // workflow so the App-first CLONE token reuses the same minted/cached token as
  // the CI-poll / merge stages. Optional — the provider mints per-call when absent.
  githubAppMinter?: GithubAppTokenMinter;
  identitySecretRef: string;
  ciPollDelayMs?: number;
  // lease tuning. `leaseMs` is the lease window stamped on claim and on
  // each heartbeat; `heartbeatIntervalMs` is how often the worker renews it
  // while the workflow runs.
  leaseMs?: number;
  heartbeatIntervalMs?: number;
  // Observability seam for heartbeat health (silent-fallback hardening, finding 9):
  // invoked on EVERY heartbeat miss with the running consecutive-miss count, and
  // once `atRisk` flips true when consecutive misses have consumed the lease window
  // (the reaper may now requeue this still-running job → duplicate execution). The
  // default sink logs loudly; tests inject to assert the loud accounting.
  onHeartbeatMiss?: (miss: HeartbeatMiss) => void;
  // Observability seam for PROGRESS-BASED STALL DETECTION (apex-v45): invoked ONCE if the job
  // heartbeats but makes NO forward progress for the whole lease window (the heartbeat then
  // releases the lease so the reaper requeues the run). Default sink logs loudly; tests inject.
  onJobStall?: (stall: JobStall) => void;
  // Test seam: defaults to the real planner-loop workflow. Tests inject a
  // wrapper that calls the real workflow with fake adapters / usage probe so
  // the dequeue→execute seam is proven without real Codex/SSH.
  runWorkflow?: (input: RunPlannerLoopInput) => Promise<PlannerRunResult>;
  // Environment management (env-management.md §4 + §7 P4): the JIT env-image creation
  // seams (the BuildKit build driver + the validation timeout/now). When WIRED, a run
  // whose toolchain is OFF-baseline AND has no registry match triggers a synchronous
  // build→validate→publish of a real env image (over `allocator`/`ssh` above) before
  // the workspace seeds — replacing P3's golden-base no-match placeholder. Omitted
  // (the default) ⇒ the P3 behavior is byte-identical (a no-match resolves to the
  // golden base), so existing paths/tests are unchanged; the live worker wires it.
  envCreation?: EnvCreationDeps;
}

export type ExecuteJobResult =
  | { kind: "idle" }
  | { kind: "completed"; jobId: string; runId: string; outcome: string }
  | { kind: "failed"; jobId: string; runId?: string; failure: { kind: string; message: string } };

/**
 * Claim one queued `plan` job and execute it to completion. Returns `idle`
 * when the queue is empty, `completed` on a finished workflow (including a
 * recoverable halted outcome the workflow itself finalized), or `failed` when
 * the workflow threw — in which case the job is failed and the run is forced
 * into a recoverable state.
 */
export async function executeNextPlanJob(deps: RunExecutorDeps): Promise<ExecuteJobResult> {
  const leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
  // Claim through the claim CLIENT (direct DB-CAS in-process, or
  // the mTLS control-plane endpoint cross-process). Same exactly-once claim — the
  // endpoint wraps the same `JobQueue.claim`. Default keeps the direct path so an
  // un-wired worker is unchanged.
  const claimClient = deps.claimClient ?? new DirectJobClaimClient(deps.jobQueue);
  const job = await claimClient.claimJob({ taskKind: "plan", leaseMs });
  if (job === undefined) {
    return { kind: "idle" };
  }
  const runId = job.runId;
  if (runId === undefined) {
    const failure = { kind: "invalid_job", message: "plan job is missing a run id" };
    await deps.jobQueue.fail(job.id, failure);
    return { kind: "failed", jobId: job.id, failure };
  }

  // FAIL-CLOSED tenant scope: EVERY plan run is a tenant run. `runs.org_id` is NOT
  // NULL, and a plan job's `job_queue.org_id` is stamped from `(SELECT org_id FROM
  // runs …)` at enqueue (projectSpec.ts / PgJobQueue), so a claimed plan job ALWAYS
  // carries a concrete org. A null `job.orgId` is therefore NEVER a legitimate
  // "platform/system run" — it can only be a wiring bug (a job_queue row that lost
  // its org). Admitting it would load the run's context + run the workflow under the
  // BYPASSRLS system pool, silently executing a tenant's work with RLS disabled —
  // the exact silent-fallback archetype the no-silent-fallbacks doctrine bans. So a
  // missing org is a LOUD, fail-closed error BEFORE any context load / workflow: the
  // job is failed and the run surfaces, never executed cross-RLS under a guessed scope.
  if ((job.orgId ?? null) === null) {
    const failure = {
      kind: "missing_job_org",
      message: `plan job for run ${runId} carries no org_id (a tenant run must carry org scope; refusing BYPASSRLS execution)`,
    };
    await deps.jobQueue.fail(job.id, failure);
    return { kind: "failed", jobId: job.id, runId, failure };
  }

  // PROGRESS-BASED STALL DETECTION (apex-v45): the in-process forward-motion signal, ticked on
  // every `ssh.run` BOUNDARY by the instrumented substrate. The heartbeat watches it so a job
  // that heartbeats but makes NO forward progress for the whole lease window (a wedge on a
  // non-resolving await — the apex-v45 hang) releases its lease for the reaper, instead of the
  // heartbeat keeping a stalled job alive forever. Every workflow SSH op AND every
  // ActivityWatchdog probe `ssh.run` ticks the signal, so a working job always advances it.
  const progressSignal = new JobProgressSignal();
  const ssh = instrumentSubstrateProgress(deps.ssh, progressSignal);

  // renew the lease on an interval so a healthy worker holds its claim
  // while the (potentially long) workflow runs. The reaper only recovers a job
  // whose lease has lapsed — i.e. a crashed worker that stopped heartbeating, OR a wedged
  // worker whose progress signal stopped advancing (the heartbeat then releases the lease).
  const stopHeartbeat = startHeartbeat({
    heartbeat: (jobId, lease) => deps.jobQueue.heartbeat(jobId, lease),
    jobId: job.id,
    leaseMs,
    intervalMs: deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    progressSignal,
    ...(deps.onHeartbeatMiss !== undefined && { onMiss: deps.onHeartbeatMiss }),
    ...(deps.onJobStall !== undefined && { onStall: deps.onJobStall }),
  });
  // RLS: the catch-path recoverable finalize must org-scope its UPDATE runs, or
  // the enforced `tanren_app` policy denies the unscoped write and the run sticks
  // `queued` forever. The owning run's org is KNOWN from the claim itself — the
  // queue carries it (job_queue stays OUTSIDE RLS; org_id is threaded onto the
  // row and returned from the claim) and the fail-closed guard above already
  // proved it non-null. So we seed the finalize scope from the CLAIMED org
  // immediately, BEFORE any work that can throw (credential resolution / context
  // hydration). An EARLY failure — e.g. misconfigured credentials throwing in
  // `loadRunContextScoped` before `resolvedOrgId` could be reassigned — then still
  // finalizes org-scoped, so the policy admits the write and the run cleanly
  // reaches `halted` instead of being stuck `queued`. The later context load
  // reassigns this to the run's actual org; the two agree (the scoped hydration
  // cross-checks them), so this is a no-op narrowing in the common case.
  const claimedOrgId: string = job.orgId as string;
  let resolvedOrgId: string = claimedOrgId;
  try {
    // RLS R3b: the claimed job carries its owning run's org_id on the queue row
    // (job_queue stays OUTSIDE RLS — the claim above resolved it cross-org). That
    // is the worker's tenant BOOTSTRAP source: instead of an RLS-protected `runs`
    // read to discover the org, we read it from the job envelope and scope the
    // run⋈spec⋈project hydration to it. The org is ALWAYS concrete (the guard
    // above fail-closed a null one), so the hydration ALWAYS runs under
    // `runWithOrgScope` — every read carries `app.current_org_id` and the policy
    // admits the run's own rows. There is no null-org BYPASSRLS hydration path.
    const { context, orgId, projectConfig } = await loadRunContextScoped(deps, runId, claimedOrgId);
    resolvedOrgId = orgId;

    // Environment management (env-management.md §4 + §7 P4): JIT env-image creation at
    // the no-match path. `loadRunContextScoped` already ran P3's resolution
    // (context.runnerImage = a registry match OR the golden-base no-match placeholder).
    // When the JIT-creation seams are wired AND this run's toolchain is OFF-baseline
    // with no registry match, build→validate→publish a real env image NOW (over
    // deps.allocator/ssh, OUTSIDE the scoped read txn, so a multi-minute build never
    // holds a connection) and seed from it. A baseline-subset toolchain short-circuits
    // to the golden base (no build); a creation FAILURE propagates LOUD (no silent
    // golden-base degrade). Omitted seams ⇒ P3 behavior, byte-identical.
    await refineRunnerImageForEnv({ pool: deps.pool, creation: deps.envCreation, context, projectConfig, orgId });

    // RLS wave R1: the claim above ran under the worker's SYSTEM context — the
    // `job_queue` claim spans tenants (job_queue stays OUTSIDE RLS in R2), so it
    // must NOT carry an org. Now that the claimed job's org is resolved, the
    // worker establishes the PER-JOB org session context and confirms the run is
    // reachable under it. Inert in R1 (no policies read the GUC); R2's policy
    // keys off this `SET LOCAL app.current_org_id`. Always runs — a tenant run
    // always carries an org.
    await establishJobOrgContext(deps.pool, orgId, runId);

    // Plane B: resolve the PROJECT's dev+test app env — the env vars
    // + secrets the product Tanren is BUILDING needs to run + test the app it
    // writes — from the `project_app_env` store (secret refs read from the secret
    // manager). Materialized over the runner into the building agent's command env
    // (gate steps + bootstrap), NEVER logged and DISTINCT from Tanren's own
    // provider creds. Resolved under the run's org scope so RLS gates visibility.
    const appEnv = await resolveRunAppEnv(deps, context.projectId, orgId);

    // The ONLY thing that ever stops a run is BUDGET — there are no quotas
    // (autonomy-engine.md §1.3/§1.x). Budget enforcement fires DOWNSTREAM, inside
    // the workflow's usage accounting (`subtaskAccounting` → `window_exhausted`
    // halt), so there is nothing to gate here pre-flight: the worker hydrates the
    // run's context and hands it straight to the workflow.
    const runWorkflow = deps.runWorkflow ?? runPlannerLoopWorkflow;
    // RLS R3a-worker: the per-job WORKFLOW execution interleaves DB writes with
    // minutes of external I/O (allocate, clone, bootstrap, CI polling), so it
    // CANNOT be one `runWithOrgScope` (a connection idle across that span is
    // unacceptable). Instead, set the run's org as the lightweight per-job
    // org-id (holds NO connection) and hand the workflow an `orgScopingPool`:
    // every tenant-table op the workflow drives — direct `input.pool.query` AND
    // the self-routing stores (PgEventStore/CostRecorder/task helpers) — opens
    // its OWN short org-scoped txn from that org-id, so a connection is held only
    // for one DB op, never across I/O. The org is ALWAYS concrete (the fail-closed
    // guard), so this is always a real per-job org scope — never a BYPASSRLS handoff.
    // Audit finding D3/H3 sweep: writer is REQUIRED. The workflow's tenant
    // writes (events, cost_records, finalize, lifecycle) route through it.
    // `workflowWriter` rebuilds an in-process writer over `orgScopingPool` so
    // its `INSERT INTO events` carries the per-job org GUC under RLS.
    const writer = workflowWriter(deps.runStateWriter, deps.pool, orgId);
    const workflowWriterSeams = {
      eventStore: writer,
      // run-end cost reconcile/apportion routes through the writer too — the
      // de-privileged data plane can no longer UPDATE cost_records directly
      // (migration 0031). Direct writer runs the SAME `applyReconcile`.
      recorder: new CostRecorder(
        deps.pool,
        writer,
        (c) => writer.recordCost(c),
        (rec) => writer.reconcileCost({ ...rec, orgId }),
      ),
      finalizeRun: (f: { runId: string; status: string; outcome: string; fromStatuses: string[] }) =>
        writer.finalizeRun({ ...f, orgId }).then(() => {}),
      runStateWriter: writer,
    };
    const result = await withJobOrg(orgId, () =>
      runWorkflow({
        // The workflow ALWAYS gets the org-scoping proxy so its tenant ops
        // self-route per-op under the run's org → a short `runWithOrgScope`. The
        // implicit bare-pool handoff is gone (no silent unscoped tenant op), and
        // there is no null-org BYPASSRLS path — the run always carries an org.
        pool: orgScopingPool(deps.pool),
        ...workflowWriterSeams,
        allocator: deps.allocator,
        // The PROGRESS-instrumented substrate (every SSH boundary ticks the job-progress signal).
        ssh,
        secrets: deps.secrets,
        // Dimension D: thread the credential-scoping seam so the workflow
        // de-privileges the run's credential reads behind a per-run child token.
        ...(deps.credentialScoping === undefined ? {} : { credentialScoping: deps.credentialScoping }),
        githubHttp: deps.githubHttp,
        // Part 2: the App-first clone reuses the shared minter when present.
        ...(deps.githubAppMinter === undefined ? {} : { githubAppMinter: deps.githubAppMinter }),
        context,
        // Plane B: the project's resolved dev+test app env (over the runner,
        // never logged, distinct from Tanren creds). Empty ⇒ field omitted.
        ...(Object.keys(appEnv).length === 0 ? {} : { appEnv }),
        ciPollDelayMs: deps.ciPollDelayMs ?? DEFAULT_CI_POLL_DELAY_MS,
        // under `native_queue` the merge stage enters the ready run into the queue (RLS-scoped).
        // The atomic variant is the seam's post-PR-open 3-write block (PR #724 follow-up).
        nativeQueueEnqueuer: buildNativeQueueEnqueuer(deps.pool),
        nativeQueueOnClientEnqueuer: buildAtomicNativeQueueEnqueuer(deps.pool),
        // WS-A PR-8: OBSERVE-ONLY — the jj-local dependent bootstrap records its `eager_base` integration
        // node (the proof-reuse substrate) through this org-scoped UPSERT over the pool. Never gates the run.
        eagerBaseNodeUpsert: buildEagerBaseNodeUpsert(deps.pool),
        // WS-A PR-8c: the jj-local dependent bootstrap folds the assembly-captured
        // per-ancestor head shas BACK into `runs.ancestor_stack[].headSha`, so percolation's divergence
        // key reads the shas from `ancestor_stack`. PLANE-SPLIT: `runs` is de-privileged on the data plane
        // (migration 0035), so a wired remote writer routes the UPDATE through the control plane (else the
        // byte-identical in-process UPDATE on the worker pool). It never gates the run.
        bootstrapStackHeadShaWriteBack: buildBootstrapStackHeadShaWriteBack(deps.pool, writer),
        // §3 NEVER-DISCARD (apex v35): reads the ancestor specs' lifecycle buckets so a dependent whose
        // ancestor is non-terminal but headless BENIGN-WAITS (re-driven) instead of stranding. Org-scoped.
        ancestorPhaseReader: buildAncestorPhaseReader(deps.pool),
        // ROBUSTNESS (apex v35): the run-failure boundary re-drives a random/transient fault (spec → open)
        // instead of stranding, bounded by this consecutive-same-failure reader (SAME failure K times
        // escalates loudly). Org-scoped read over the pool.
        redriveHistoryReader: buildRedriveHistoryReader(deps.pool),
        // apex v79/v80 loop closure: MATERIALIZE the triage-emitted `kind: spec`
        // items as real DAG specs via `acceptProposals` under the run's org scope
        // (the workflow otherwise emits `outcome.newSpecs` and drops them).
        materializeTriageNewSpecs: buildTriageNewSpecsMaterializer({
          pool: deps.pool,
          runStateWriter: writer,
          resolveActor: triageMaterializerSystemActor,
        }),
      }),
    );
    await deps.jobQueue.complete(job.id);
    return { kind: "completed", jobId: job.id, runId, outcome: result.outcome.kind };
  } catch (error) {
    // SINGLE-FINALIZE INVARIANT (apex v35): UNWRAP a `WorkflowFinalizedError` to its raw cause so the
    // job-fail accounting + internal log see the SAME raw error the workflow caught (the public failure
    // vocabulary is unchanged by the wrapper).
    const raw = rawCauseOf(error);
    // PUBLIC-ERROR-LEAK hardening: this catch wraps the WHOLE run, so `raw` can carry URLs / repo refs /
    // command fragments / provider responses / secret-adjacent text. So we split internal-vs-public: the
    // raw message → `job_queue.failure_message` (INTERNAL, outside RLS) + a redacted log (the operator's
    // full-detail triage source); a CLASSIFIED `{ code, stage, summary }` (closed vocabulary, never the
    // raw string) → the PUBLIC `run.failed` / `dag.spec.needs_attention` events.
    const classified = classifyRunFailure(raw);
    const failure = { kind: failureKind(raw), message: messageOf(raw) };
    await deps.jobQueue.fail(job.id, failure);
    // Internal-only redacted log: the raw detail surfaces for operator triage off the
    // public timeline, run through the same event redactor that strips URLs/tokens/paths.
    log.error("run failed", {
      runId,
      code: classified.code,
      stage: classified.stage,
      detail: redactErrorDetail(failure.message),
    });
    // SINGLE-FINALIZE INVARIANT (apex v35): the §2c `no_live_run` orphan strand runs ONLY for a GENUINELY
    // orphaned run (a crash whose finalizer never ran, the error escaping RAW). Passing the original
    // `error` through lets `finalizeRunRecoverable` SKIP the strand for a `WorkflowFinalizedError` (the
    // workflow already finalized the run+spec) — the #580 double-finalize, keyed off the type, not timing.
    await finalizeRunRecoverable(deps.pool, deps.runStateWriter, runId, classified, resolvedOrgId, error);
    return { kind: "failed", jobId: job.id, runId, failure };
  } finally {
    await stopHeartbeat();
  }
}

/**
 * RLS R3b: hydrate the claimed job's run⋈spec⋈project context under the run's org
 * scope. The job ALWAYS carries a concrete org (the fail-closed guard rejected a
 * null one upstream), so the read ALWAYS runs under `runWithOrgScope(jobOrgId)` —
 * every SELECT carries `app.current_org_id` and the enforced policy admits the
 * run's own rows. There is no null-org `runWithSystemScope` BYPASSRLS fallback: a
 * tenant run is never hydrated cross-RLS.
 *
 * Cross-check: if the job's org and the run's actual `org_id` disagree, the scoped read returns no
 * row → `RunExecutionContextNotFoundError`, failing the job loudly rather than silently executing
 * under the wrong tenant. The loaded `orgId` is then asserted non-null (defense in depth: `runs.org_id`
 * is NOT NULL, so a null here is a corruption — fail loud, never run BYPASSRLS).
 */
async function loadRunContextScoped(
  deps: RunExecutorDeps,
  runId: string,
  jobOrgId: string,
): Promise<RunExecutionContext & { orgId: string }> {
  const load = (client: pg.Pool | pg.PoolClient): Promise<RunExecutionContext> =>
    loadRunExecutionContext(client, { runId, identitySecretRef: deps.identitySecretRef });
  const loaded = await runWithOrgScope(deps.pool, jobOrgId, load);
  if (loaded.orgId === null) {
    throw new Error(`run ${runId} loaded with a null org_id under org scope ${jobOrgId} (a tenant run must carry org)`);
  }
  return { ...loaded, orgId: loaded.orgId };
}

// Plane B: resolve + MERGE the project's dev and test app-env into
// one env map for the run workspace. Each scope's entries are resolved under the
// run's org scope (so RLS gates which project's entries are visible) with secret
// refs read from the secret manager. dev and test overlap is intentional (both
// feed the building agent's run+test commands); on a key in both, test wins (the
// later spread). The org is always concrete (the fail-closed guard), so the read
// always runs org-scoped — there is no null-org empty-map path.
const RUN_WORKSPACE_APP_ENV_SCOPES: readonly AppEnvScope[] = ["dev", "test"];

async function resolveRunAppEnv(
  deps: RunExecutorDeps,
  projectId: string,
  orgId: string,
): Promise<Record<string, string>> {
  return runWithOrgScope(deps.pool, orgId, async (client) => {
    const merged: Record<string, string> = {};
    for (const scope of RUN_WORKSPACE_APP_ENV_SCOPES) {
      const env = await resolveAppEnvForScope({
        client,
        secrets: deps.secrets,
        projectId,
        scope,
        actor: systemActor,
      });
      Object.assign(merged, env);
    }
    return merged;
  });
}

/**
 * RLS wave R1: establish the claimed job's PER-JOB org session context. Opens
 * an org-scoped transaction (`SET LOCAL app.current_org_id = <orgId>`) and
 * confirms the run row is reachable under it — the inert proof that the worker,
 * having claimed cross-org under the system context, then narrows to the job's
 * org before doing tenant work. Throws `JobOrgContextLostError` if the run is
 * not visible under the org GUC (in R1 that can only mean the org/run pairing is
 * wrong; in R2 it would mean a policy filtered it out).
 */
export async function establishJobOrgContext(pool: pg.Pool, orgId: string, runId: string): Promise<void> {
  const visible = await runWithOrgScope(pool, orgId, async (client) => {
    const result = await client.query("SELECT 1 FROM runs WHERE run_id = $1 AND org_id = $2", [runId, orgId]);
    return (result.rowCount ?? 0) > 0;
  });
  if (!visible) {
    throw new JobOrgContextLostError(runId, orgId);
  }
}

/** Thrown when a claimed job's run is not reachable under its own org context. */
export class JobOrgContextLostError extends Error {
  constructor(runId: string, orgId: string) {
    super(`run ${runId} not reachable under org context ${orgId}`);
    this.name = "JobOrgContextLostError";
  }
}

/**
 * Run `work` with the run's org as the per-job ambient org-id (R3a-worker). A plan
 * run ALWAYS carries an org (the fail-closed guard rejected a null one), so the
 * workflow's tenant ops always self-route through `runWithJobOrgId` under that org
 * — there is no null-org per-job SYSTEM (BYPASSRLS) scope for a tenant run.
 */
function withJobOrg<T>(orgId: string, work: () => Promise<T>): Promise<T> {
  return runWithJobOrgId(orgId, work);
}

function failureKind(error: unknown): string {
  if (error instanceof Error && error.name !== "" && error.name !== "Error") {
    return error.name;
  }
  return "run_execution_failed";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Best-effort redaction for the INTERNAL (console-only, never RLS-public) failure
// log: strip the obvious secret-adjacent shapes (URLs — which may embed creds/refs,
// `key=value` token assignments, and bearer/authorization tokens) before the raw
// detail is logged. This is defense-in-depth on an already-internal log line; the
// public events never carry this string at all (the classified summary does).
function redactErrorDetail(detail: string): string {
  return detail
    .replaceAll(/\bhttps?:\/\/\S+/giu, "[url]")
    .replaceAll(/\b(bearer|authorization|token|password|secret|api[_-]?key)(\s*[:=]\s*)\S+/giu, "$1$2[redacted]");
}

/** Audit finding D3/H3 sweep: rebuild an in-process writer over the workflow's
 *  `orgScopingPool` so in-process writes carry the per-job org GUC under RLS.
 *  HTTP writers (which scope server-side) pass through unchanged. */
function workflowWriter(boot: RunStateWriter, pool: pg.Pool, _orgId: string): RunStateWriter {
  if (boot instanceof DirectRunStateWriter) return new DirectRunStateWriter(orgScopingPool(pool));
  return boot;
}
