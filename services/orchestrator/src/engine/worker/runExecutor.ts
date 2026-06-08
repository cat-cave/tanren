// the dequeue→execute seam. `executeNextPlanJob` atomically claims one
// queued `plan` job, re-hydrates its `PlannerRunContext`, and runs the real
// plan→write→check→audit→draft-PR→CI workflow to completion.
//
// The workflow (`runPlannerLoopWorkflow`) owns its own run finalization: it
// lands `done/ok` on a pass, `halted/<reason>` on a non-pass loop outcome, and
// (for a generic mid-run throw) `failed/failed`. The worker-level catch here
// does only two extra things the workflow can't:
//   1. fail the claimed job row (so the queue reflects the failure), and
//   2. re-finalize a run the workflow left in a NON-recoverable terminal state
//      (`failed`) or still `running` (a crash) into a recoverable `halted`
//      outcome, so the run surfaces on the recovery surface rather
//      than disappearing or looking stuck.
//
// Idempotency: the claim is atomic (`FOR UPDATE SKIP LOCKED` → CAS to
// `running`), so a job is handed to exactly one worker. A crash between claim
// and finalize leaves the job `running`; the recovery surface + a future
// reaper own re-queueing — the worker never double-executes a claimed job.

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
import type { EscapeHatches } from "../config/index.js";
import { CostRecorder } from "../costs/recorder.js";
import type { VcsProvider } from "../contracts/vcsProvider.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import { buildNativeQueueEnqueuer } from "../merge/coordinatorBuild.js";
import { finalizeRunRecoverable } from "./runFinalize.js";
import { startHeartbeat, type HeartbeatMiss } from "./runHeartbeat.js";
import { systemActor } from "../state/actor.js";
import { resolveAppEnvForScope } from "../workflow/resolveAppEnv.js";
import type { AppEnvScope } from "../repositories/appEnvironment.js";
import { loadRunExecutionContext, type RunExecutionContext } from "./runExecutionContext.js";
import { runPlannerLoopWorkflow, type PlannerRunResult, type RunPlannerLoopInput } from "../workflow/plannerRun.js";

/** Escape-hatch + CI-poll defaults the run worker applies to a dequeued plan job. */
export const DEFAULT_ESCAPE_HATCHES: Pick<EscapeHatches, "maxWriterIterPerSubtask" | "maxRetriesPerTransientFailure"> =
  {
    maxWriterIterPerSubtask: 5,
    maxRetriesPerTransientFailure: 3,
  };

// Per-stage agent/SSH timeout CAP (a ceiling, not a fixed wait). Bumped 5min→10min
// for the #273 scaffold-convergence fix: the hardest first spec (a greenfield
// monorepo scaffold) had 4/5 of its writer reruns TIME OUT at the old 5-min cap —
// the spec was simply too large to author in one pass. This is a uniform cap
// threaded into every stage (planner/writer/checker/auditor) and the gate/SSH
// commands; raising the ceiling only affects a stage that ACTUALLY needs the extra
// time (the slow writer pass) — the fast answerers/gate finish well inside it and
// are unaffected. Kept a code constant (NOT an env var): it's an internal timeout,
// not a budget/config knob.
export const DEFAULT_TIMEOUT_MS = 600_000;
export const DEFAULT_MAX_CI_POLLS = 18;
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
  // How this worker CLAIMS a job. Defaults to a
  // `DirectJobClaimClient` over `jobQueue` (the unchanged DB-CAS) so the
  // in-process / single-process path is behavior-identical. The cross-process
  // `worker` container injects an `HttpJobClaimClient` that claims over the mTLS
  // control-plane endpoint instead of touching `job_queue` directly. The rest of
  // the queue surface (fail/complete/heartbeat) still uses `jobQueue`; the
  // control-plane routing moves the CLAIM and the run-state WRITES separately.
  claimClient?: JobClaimClient;
  // How this worker WRITES the run's tenant state — event-append,
  // cost-record insert, and run finalize. Omit (the DEFAULT) → the worker does
  // today's in-process org-scoped DB writes directly (the `DirectRunStateWriter`
  // path, lower risk, behavior-identical). Set to an `HttpRunStateWriter` (when
  // TANREN_DATA_PLANE_REMOTE_WRITES=1) → those writes route through the
  // control-plane `/internal/*` write endpoints over mTLS, so the data plane
  // writes no tenant tables directly. Keeping DIRECT the default makes the cutover
  // REVERSIBLE: nothing changes unless the flag is set. A plan run always carries
  // an org (the fail-closed guard), so a remote write always has a scope.
  runStateWriter?: RunStateWriter;
  allocator: Allocator;
  ssh: CommandSubstrate;
  secrets: SecretStore;
  // Managed-hosting dimension D: the per-run credential-scoping seam (Vault backend
  // only). Wired ⇒ the workflow mints a child token scoped to ONLY this run's cred
  // ref paths and reads the run's credentials through it (the broad VAULT_TOKEN
  // never reaches a runner). Omitted for a non-Vault backend.
  credentialScoping?: RunCredentialScoping;
  vcsProvider: VcsProvider;
  // Part 2: shared App installation-token minter, threaded into the
  // workflow so the App-first CLONE token reuses the same minted/cached token as
  // the CI-poll / merge stages. Optional — the provider mints per-call when absent.
  githubAppMinter?: GithubAppTokenMinter;
  identitySecretRef: string;
  escapeHatches?: Pick<EscapeHatches, "maxWriterIterPerSubtask" | "maxRetriesPerTransientFailure">;
  timeoutMs?: number;
  maxCiPolls?: number;
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
  // Test seam: defaults to the real planner-loop workflow. Tests inject a
  // wrapper that calls the real workflow with fake adapters / usage probe so
  // the dequeue→execute seam is proven without real Codex/SSH.
  runWorkflow?: (input: RunPlannerLoopInput) => Promise<PlannerRunResult>;
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

  // renew the lease on an interval so a healthy worker holds its claim
  // while the (potentially long) workflow runs. The reaper only recovers a job
  // whose lease has lapsed — i.e. a crashed worker that stopped heartbeating.
  const stopHeartbeat = startHeartbeat({
    heartbeat: (jobId, lease) => deps.jobQueue.heartbeat(jobId, lease),
    jobId: job.id,
    leaseMs,
    intervalMs: deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    ...(deps.onHeartbeatMiss !== undefined && { onMiss: deps.onHeartbeatMiss }),
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
    const { context, orgId } = await loadRunContextScoped(deps, runId, claimedOrgId);
    resolvedOrgId = orgId;

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
    // When a remote run-state writer is wired, route the workflow's tenant
    // run-state writes — events, cost_records, the terminal run finalize —
    // through it (the control-plane endpoints). Otherwise inject nothing: the
    // workflow uses its own in-process org-scoped stores over `orgScopingPool`,
    // BYTE-IDENTICAL to the direct in-process path (and its mutation suite).
    const remoteWriter = deps.runStateWriter;
    const remoteWorkflowSeams =
      remoteWriter === undefined
        ? {}
        : {
            eventStore: remoteWriter,
            recorder: new CostRecorder(
              deps.pool,
              remoteWriter,
              (cost) => remoteWriter.recordCost(cost),
              // route the run-end cost reconcile/apportion through
              // the control plane too — the de-privileged data plane can no longer
              // UPDATE cost_records directly (migration 0031).
              (rec) => remoteWriter.reconcileCost({ ...rec, orgId }),
            ),
            finalizeRun: (f: { runId: string; status: string; outcome: string; fromStatuses: string[] }) =>
              remoteWriter.finalizeRun({ ...f, orgId }).then(() => {}),
            // the full lifecycle writer. When present (remote-writes
            // on), the workflow routes its run/spec/task lifecycle writes through the
            // control plane; absent, it does its byte-identical in-process writes.
            runStateWriter: remoteWriter,
          };
    const result = await withJobOrg(orgId, () =>
      runWorkflow({
        // The workflow ALWAYS gets the org-scoping proxy so its tenant ops
        // self-route per-op under the run's org → a short `runWithOrgScope`. The
        // implicit bare-pool handoff is gone (no silent unscoped tenant op), and
        // there is no null-org BYPASSRLS path — the run always carries an org.
        pool: orgScopingPool(deps.pool),
        ...remoteWorkflowSeams,
        allocator: deps.allocator,
        ssh: deps.ssh,
        secrets: deps.secrets,
        // Dimension D: thread the credential-scoping seam so the workflow
        // de-privileges the run's credential reads behind a per-run child token.
        ...(deps.credentialScoping === undefined ? {} : { credentialScoping: deps.credentialScoping }),
        vcsProvider: deps.vcsProvider,
        // Part 2: the App-first clone reuses the shared minter when present.
        ...(deps.githubAppMinter === undefined ? {} : { githubAppMinter: deps.githubAppMinter }),
        context,
        // Plane B: the project's resolved dev+test app env (over the runner,
        // never logged, distinct from Tanren creds). Empty ⇒ field omitted.
        ...(Object.keys(appEnv).length === 0 ? {} : { appEnv }),
        escapeHatches: deps.escapeHatches ?? DEFAULT_ESCAPE_HATCHES,
        timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxCiPolls: deps.maxCiPolls ?? DEFAULT_MAX_CI_POLLS,
        ciPollDelayMs: deps.ciPollDelayMs ?? DEFAULT_CI_POLL_DELAY_MS,
        // under `native_queue` the merge stage enters the ready run into the
        // native merge queue (the coordinator drives the actual merge). Built from
        // the worker's real pool so the queue write is RLS-scoped.
        nativeQueueEnqueuer: buildNativeQueueEnqueuer(deps.pool),
      }),
    );
    await deps.jobQueue.complete(job.id);
    return { kind: "completed", jobId: job.id, runId, outcome: result.outcome.kind };
  } catch (error) {
    const failure = { kind: failureKind(error), message: messageOf(error) };
    await deps.jobQueue.fail(job.id, failure);
    await finalizeRunRecoverable(deps.pool, deps.runStateWriter, runId, failure.message, resolvedOrgId);
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
 * Cross-check: if the job's org and the run's actual `org_id` ever disagree, the
 * scoped read returns no row → `RunExecutionContextNotFoundError`, which fails
 * the job loudly rather than silently executing under the wrong tenant. The
 * loaded `orgId` is then asserted non-null (defense in depth: `runs.org_id` is
 * NOT NULL, so a null here is a corruption — fail loud, never run BYPASSRLS).
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
