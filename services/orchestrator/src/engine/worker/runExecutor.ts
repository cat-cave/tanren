// P3-0001: the dequeue→execute seam. `executeNextPlanJob` atomically claims one
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
//      outcome, so the run surfaces on the P2B-0008 recovery surface rather
//      than disappearing or looking stuck.
//
// Idempotency: the claim is atomic (`FOR UPDATE SKIP LOCKED` → CAS to
// `running`), so a job is handed to exactly one worker. A crash between claim
// and finalize leaves the job `running`; the recovery surface + a future
// reaper own re-queueing — the worker never double-executes a claimed job.

import { runWithJobOrgId, runWithOrgScope, runWithSystemJobScope, runWithSystemScope } from "@tanren/db";
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
import { systemActor } from "../state/actor.js";
import { resolveAppEnvForScope } from "../workflow/resolveAppEnv.js";
import type { AppEnvScope } from "../repositories/appEnvironment.js";
import { loadRunExecutionContext, type RunExecutionContext } from "./runExecutionContext.js";
import { runPlannerLoopWorkflow, type PlannerRunResult, type RunPlannerLoopInput } from "../workflow/plannerRun.js";

/** Escape-hatch + CI-poll defaults the run worker applies to a dequeued plan job. */
export const DEFAULT_ESCAPE_HATCHES: Pick<
  EscapeHatches,
  "maxPlannerRerunsPerSpec" | "maxWriterIterPerSubtask" | "maxRetriesPerTransientFailure"
> = {
  maxPlannerRerunsPerSpec: 5,
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

// P3-0028 queue lease recovery. While a claimed job executes, the worker
// renews its lease on this interval; the lease window is a multiple of the
// interval so a single missed heartbeat does not trip the reaper. A crashed
// worker stops heartbeating, its lease lapses, and the reaper recovers the job.
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
export const DEFAULT_LEASE_MS = 60_000;

export interface RunExecutorDeps {
  pool: pg.Pool;
  jobQueue: JobQueue;
  // Plane-split P2: how this worker CLAIMS a job. Defaults to a
  // `DirectJobClaimClient` over `jobQueue` (the unchanged DB-CAS) so the
  // in-process / single-process path is behavior-identical. The cross-process
  // `worker` container injects an `HttpJobClaimClient` that claims over the mTLS
  // control-plane endpoint instead of touching `job_queue` directly. The rest of
  // the queue surface (fail/complete/heartbeat) still uses `jobQueue` — P2 moves
  // only the CLAIM; routing the WRITES through the control plane is P3.
  claimClient?: JobClaimClient;
  // Plane-split P3: how this worker WRITES the run's tenant state — event-append,
  // cost-record insert, and run finalize. Omit (the DEFAULT) → the worker does
  // today's in-process org-scoped DB writes directly (the `DirectRunStateWriter`
  // path, lower risk, behavior-identical). Set to an `HttpRunStateWriter` (when
  // TANREN_DATA_PLANE_REMOTE_WRITES=1) → those writes route through the
  // control-plane `/internal/*` write endpoints over mTLS, so the data plane
  // writes no tenant tables directly. Keeping DIRECT the default makes P3
  // REVERSIBLE: nothing changes unless the flag is set. A legacy/unscoped run
  // (org_id NULL) ALWAYS uses the direct path — it has no org to scope a remote
  // write to.
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
  // P2a (Part 2): shared App installation-token minter, threaded into the
  // workflow so the App-first CLONE token reuses the same minted/cached token as
  // the CI-poll / merge stages. Optional — the provider mints per-call when absent.
  githubAppMinter?: GithubAppTokenMinter;
  identitySecretRef: string;
  escapeHatches?: Pick<
    EscapeHatches,
    "maxPlannerRerunsPerSpec" | "maxWriterIterPerSubtask" | "maxRetriesPerTransientFailure"
  >;
  timeoutMs?: number;
  maxCiPolls?: number;
  ciPollDelayMs?: number;
  // P3-0028 lease tuning. `leaseMs` is the lease window stamped on claim and on
  // each heartbeat; `heartbeatIntervalMs` is how often the worker renews it
  // while the workflow runs.
  leaseMs?: number;
  heartbeatIntervalMs?: number;
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
  // Plane-split P2: claim through the claim CLIENT (direct DB-CAS in-process, or
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

  // P3-0028: renew the lease on an interval so a healthy worker holds its claim
  // while the (potentially long) workflow runs. The reaper only recovers a job
  // whose lease has lapsed — i.e. a crashed worker that stopped heartbeating.
  const stopHeartbeat = startHeartbeat(deps, job.id, leaseMs);
  // RLS: the catch-path recoverable finalize must org-scope its UPDATE runs, or
  // the enforced `tanren_app` policy denies the unscoped write and the run sticks
  // `queued` forever. The owning run's org is KNOWN from the claim itself — the
  // queue carries it (job_queue stays OUTSIDE RLS; P1 threaded org_id onto the
  // row, P2 returns it from the claim). So we seed the finalize scope from the
  // CLAIMED org immediately, BEFORE any work that can throw (credential
  // resolution / context hydration). An EARLY failure — e.g. misconfigured
  // credentials throwing in `loadRunContextScoped` before `resolvedOrgId` could
  // be reassigned — then still finalizes org-scoped, so the policy admits the
  // write and the run cleanly reaches `halted` instead of being stuck `queued`.
  // The later context load reassigns this to the run's actual org; the two agree
  // (the scoped hydration cross-checks them), so this is a no-op narrowing in the
  // common case. A legacy/unscoped job (org_id NULL) stays null — the finalize
  // falls back to the pool, behavior-identical to before RLS.
  let resolvedOrgId: string | null = job.orgId ?? null;
  try {
    // RLS R3b: the claimed job carries its owning run's org_id on the queue row
    // (job_queue stays OUTSIDE RLS — the claim above resolved it cross-org). That
    // is the worker's tenant BOOTSTRAP source: instead of an RLS-protected `runs`
    // read to discover the org, we read it from the job envelope and scope the
    // run⋈spec⋈project hydration to it. A job with an org runs `loadRunExecutionContext`
    // under `runWithOrgScope` (so every read carries `app.current_org_id` and the
    // policy admits the run's own rows); a legacy/unscoped job (org_id NULL) keeps
    // the system-scope read (BYPASSRLS pool) — its rows have no policy to satisfy.
    const jobOrgId = job.orgId ?? null;
    const { context, orgId } = await loadRunContextScoped(deps, runId, jobOrgId);
    resolvedOrgId = orgId;

    // RLS wave R1: the claim above ran under the worker's SYSTEM context — the
    // `job_queue` claim spans tenants (job_queue stays OUTSIDE RLS in R2), so it
    // must NOT carry an org. Now that the claimed job's org is resolved, the
    // worker establishes the PER-JOB org session context and confirms the run is
    // reachable under it. Inert in R1 (no policies read the GUC); R2's policy
    // will key off this `SET LOCAL app.current_org_id`. A legacy/unscoped run
    // (org_id NULL) has no org to set — the per-job context is skipped.
    if (orgId !== null) {
      await establishJobOrgContext(deps.pool, orgId, runId);
    }

    // Plane B (P-APP-ENV-0): resolve the PROJECT's dev+test app env — the env vars
    // + secrets the product Tanren is BUILDING needs to run + test the app it
    // writes — from the `project_app_env` store (secret refs read from the secret
    // manager). Materialized over the runner into the building agent's command env
    // (gate steps + bootstrap), NEVER logged and DISTINCT from Tanren's own
    // provider creds. Resolved under the run's org scope so RLS gates visibility; a
    // legacy/unscoped run (org_id NULL) resolves nothing (no app env).
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
    // for one DB op, never across I/O. A legacy/unscoped run (org_id NULL) sets
    // no org-id and the proxy is behavior-identical to the bare pool (inert).
    // Plane-split P3: when a remote run-state writer is wired AND the run has an
    // org (so server-side scoping is possible), route the workflow's tenant
    // run-state writes — events, cost_records, the terminal run finalize —
    // through it (the control-plane endpoints). Otherwise inject nothing: the
    // workflow uses its own in-process org-scoped stores over `orgScopingPool`,
    // BYTE-IDENTICAL to the pre-P3 direct path (and its mutation suite).
    const remoteWriter = orgId === null ? undefined : deps.runStateWriter;
    const remoteWorkflowSeams =
      remoteWriter === undefined || orgId === null
        ? {}
        : {
            eventStore: remoteWriter,
            recorder: new CostRecorder(
              deps.pool,
              remoteWriter,
              (cost) => remoteWriter.recordCost(cost),
              // Plane-split P3c: route the run-end cost reconcile/apportion through
              // the control plane too — the de-privileged data plane can no longer
              // UPDATE cost_records directly (migration 0031).
              (rec) => remoteWriter.reconcileCost({ ...rec, orgId }),
            ),
            finalizeRun: (f: { runId: string; status: string; outcome: string; fromStatuses: string[] }) =>
              remoteWriter.finalizeRun({ ...f, orgId }).then(() => {}),
            // Plane-split P3c: the full lifecycle writer. When present (remote-writes
            // on), the workflow routes its run/spec/task lifecycle writes through the
            // control plane; absent, it does its byte-identical in-process writes.
            runStateWriter: remoteWriter,
          };
    const result = await withJobOrg(orgId, () =>
      runWorkflow({
        // The workflow ALWAYS gets the org-scoping proxy so its tenant ops
        // self-route per-op: under an org → a short `runWithOrgScope`; under a
        // null-org SYSTEM job → a short `runWithSystemScope` (BYPASSRLS). The
        // implicit bare-pool handoff is gone (no silent unscoped tenant op).
        pool: orgScopingPool(deps.pool),
        ...remoteWorkflowSeams,
        allocator: deps.allocator,
        ssh: deps.ssh,
        secrets: deps.secrets,
        // Dimension D: thread the credential-scoping seam so the workflow
        // de-privileges the run's credential reads behind a per-run child token.
        ...(deps.credentialScoping === undefined ? {} : { credentialScoping: deps.credentialScoping }),
        vcsProvider: deps.vcsProvider,
        // P2a (Part 2): the App-first clone reuses the shared minter when present.
        ...(deps.githubAppMinter === undefined ? {} : { githubAppMinter: deps.githubAppMinter }),
        context,
        // Plane B: the project's resolved dev+test app env (over the runner,
        // never logged, distinct from Tanren creds). Empty ⇒ field omitted.
        ...(Object.keys(appEnv).length === 0 ? {} : { appEnv }),
        escapeHatches: deps.escapeHatches ?? DEFAULT_ESCAPE_HATCHES,
        timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxCiPolls: deps.maxCiPolls ?? DEFAULT_MAX_CI_POLLS,
        ciPollDelayMs: deps.ciPollDelayMs ?? DEFAULT_CI_POLL_DELAY_MS,
        // P2d: under `native_queue` the merge stage enters the ready run into the
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
 * RLS R3b: hydrate the claimed job's run⋈spec⋈project context under the right
 * scope. When the job carries an org (the common case post-R3b), run the read
 * under `runWithOrgScope(jobOrgId)` so every SELECT carries `app.current_org_id`
 * and the enforced policy admits the run's own rows. When the job has no org
 * (a legacy/unscoped run), fall back to `runWithSystemScope` — its BYPASSRLS
 * pool resolves the rows cross-org exactly as before R3b.
 *
 * Cross-check: if the job's org and the run's actual `org_id` ever disagree, the
 * scoped read returns no row → `RunExecutionContextNotFoundError`, which fails
 * the job loudly rather than silently executing under the wrong tenant.
 */
async function loadRunContextScoped(
  deps: RunExecutorDeps,
  runId: string,
  jobOrgId: string | null,
): Promise<RunExecutionContext> {
  const load = (client: pg.Pool | pg.PoolClient): Promise<RunExecutionContext> =>
    loadRunExecutionContext(client, { runId, identitySecretRef: deps.identitySecretRef });
  if (jobOrgId === null) {
    return runWithSystemScope(deps.pool, load);
  }
  return runWithOrgScope(deps.pool, jobOrgId, load);
}

// Plane B (P-APP-ENV-0): resolve + MERGE the project's dev and test app-env into
// one env map for the run workspace. Each scope's entries are resolved under the
// run's org scope (so RLS gates which project's entries are visible) with secret
// refs read from the secret manager. dev and test overlap is intentional (both
// feed the building agent's run+test commands); on a key in both, test wins (the
// later spread). A legacy/unscoped run (org_id NULL) has no org GUC to scope the
// read, so it resolves to an empty map — no app env, behavior-identical to before.
const RUN_WORKSPACE_APP_ENV_SCOPES: readonly AppEnvScope[] = ["dev", "test"];

async function resolveRunAppEnv(
  deps: RunExecutorDeps,
  projectId: string,
  orgId: string | null,
): Promise<Record<string, string>> {
  if (orgId === null) {
    return {};
  }
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
 * Start a periodic lease-renewal loop for a claimed job. Returns a stopper that
 * cancels the loop and resolves once it has stopped. The interval defaults to a
 * fraction of the lease window so a single slow/missed beat does not lapse the
 * lease. Heartbeat failures are swallowed — a transient DB blip should not kill
 * the job; if the worker has truly crashed the lease lapses and the reaper acts.
 */
function startHeartbeat(deps: RunExecutorDeps, jobId: string, leaseMs: number): () => Promise<void> {
  const intervalMs = Math.max(1, deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);
  const control = {
    running: true,
    inFlight: Promise.resolve(),
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
  };

  const schedule = (): void => {
    if (!control.running) {
      return;
    }
    control.timer = setTimeout(() => {
      // Swallow heartbeat failures: a transient DB blip should not kill the
      // job; a truly crashed worker stops beating and the reaper recovers it.
      control.inFlight = deps.jobQueue
        .heartbeat(jobId, leaseMs)
        .catch(() => {})
        .then(schedule);
    }, intervalMs);
    if (typeof control.timer.unref === "function") {
      control.timer.unref();
    }
  };

  schedule();

  return async () => {
    control.running = false;
    if (control.timer !== undefined) {
      clearTimeout(control.timer);
    }
    await control.inFlight;
  };
}

/**
 * Run `work` with the run's org as the per-job ambient org-id (R3a-worker) when
 * the org is known, else under the EXPLICIT per-job SYSTEM scope. A legacy/
 * unscoped run (org_id NULL) has no org GUC, so its workflow's tenant ops route
 * through the BYPASSRLS system pool (`runWithSystemScope` per op) rather than the
 * old implicit bare-pool handoff — an unscoped tenant op never silently degrades.
 */
function withJobOrg<T>(orgId: string | null, work: () => Promise<T>): Promise<T> {
  return orgId === null ? runWithSystemJobScope(work) : runWithJobOrgId(orgId, work);
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
