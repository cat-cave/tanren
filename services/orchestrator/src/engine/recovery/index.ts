// failure-recovery engine. The four operator-initiated recovery
// actions for a halted run, each enforcing project access (via the route's
// authz gate before calling here), persisting a typed lineage event, and —
// where it re-runs work — re-invoking the existing planner loop by
// queuing a fresh run from the (possibly revised) spec.
//
// Lineage home: the events table. Each action appends a `recovery.*` event so
// the run-detail history shows the halt → recover chain. No new table is
// needed — the run/spec/project-scoped events row IS the lineage record.
//
// This module is pure orchestration over `projectSpec` + `PgEventStore` +
// `ForgeThreadStore`; the HTTP shape, Zod validation, and authz live in the
// route (routes/recovery/index.ts), mirroring the notifications route split.

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import { PgEventStore } from "../eventStore.js";
import { ForgeThreadStore } from "../forge/index.js";
import { RecoveryStore } from "../repositories/recovery.js";
import { systemActor } from "../state/actor.js";
import { createQueuedRunFromSpec } from "../workflow/projectSpec.js";

/** A halted run's recovery context: the spec, last-good commit, and outcome. */
export interface HaltedRunContext {
  runId: string;
  specId: string;
  projectId: string;
  status: string;
  outcome: string | null;
  /** Last good commit SHA captured for this run, or null when none exists. */
  lastGoodCommit: string | null;
}

/** Outcomes that route a run to the recovery surface. */
export const RECOVERABLE_OUTCOMES = new Set([
  "halted",
  "escape_hatch_hit",
  "retry_budget_exhausted",
  // SPEC-LOOP REDESIGN: a convergence-stall halt is recoverable (rework the spec /
  // stronger model / fix the env, then re-run) — surfaced like the other halts.
  "convergence_stalled",
  "window_exhausted",
]);

export class RunNotRecoverableError extends Error {
  constructor(runId: string, outcome: string | null) {
    super(`run ${runId} is not in a recoverable state (outcome=${outcome ?? "null"})`);
  }
}

export class RollbackNotConfirmedError extends Error {
  constructor() {
    super("rollback requires explicit confirmation (confirmed: true)");
  }
}

export class NoPriorCommitError extends Error {
  constructor(runId: string) {
    super(`run ${runId} has no prior good commit to roll back to`);
  }
}

export class UnknownCommitError extends Error {
  constructor(commitSha: string) {
    super(`commit ${commitSha} is not a captured commit for this run`);
  }
}

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

/**
 * Load the recovery context for a run. Returns undefined when the run does not
 * exist; the route turns that into a 404. The last-good commit is read from the
 * most recent `workspace.git_captured` event for the run.
 */
export async function loadHaltedRunContext(pool: QueryClient, runId: string): Promise<HaltedRunContext | undefined> {
  const row = await RecoveryStore.getRun(pool, runId, systemActor);
  if (row === undefined) return undefined;
  return {
    runId,
    specId: row.specId,
    projectId: row.projectId,
    status: row.status,
    outcome: row.outcome,
    lastGoodCommit: await loadLastGoodCommit(pool, runId),
  };
}

/** The most recent captured commit SHA for the run, or null when none exists. */
export async function loadLastGoodCommit(pool: QueryClient, runId: string): Promise<string | null> {
  const payload = (await RecoveryStore.getLastCapturedEventPayload(pool, runId, systemActor)) as
    | { commits?: Array<{ sha?: unknown }> }
    | undefined;
  const sha = payload?.commits?.[0]?.sha;
  return typeof sha === "string" && sha.length > 0 ? sha : null;
}

/** All captured commit SHAs for the run (rollback target validation). */
export async function loadCapturedCommits(pool: QueryClient, runId: string): Promise<string[]> {
  const payloads = await RecoveryStore.listCapturedEventPayloads(pool, runId, systemActor);
  const shas: string[] = [];
  for (const payload of payloads) {
    const commits = (payload as { commits?: Array<{ sha?: unknown }> } | undefined)?.commits ?? [];
    for (const c of commits) {
      if (typeof c.sha === "string" && c.sha.length > 0) shas.push(c.sha);
    }
  }
  return [...new Set(shas)];
}

function assertRecoverable(ctx: HaltedRunContext): void {
  if (!RECOVERABLE_OUTCOMES.has(ctx.outcome ?? "") && ctx.status !== "halted") {
    throw new RunNotRecoverableError(ctx.runId, ctx.outcome);
  }
}

export interface ReviseSpecResult {
  action: "revise_spec";
  runId: string;
  specId: string;
  editHref: string;
}

/**
 * revise_spec — record the intent + return the spec-edit href (surface).
 * The action itself never mutates the spec; the edit form does, then the
 * operator triggers a replan. This keeps the gesture observable without forking
 * the spec-edit write path.
 */
export async function reviseSpec(pool: pg.Pool, ctx: HaltedRunContext, orgId: string): Promise<ReviseSpecResult> {
  assertRecoverable(ctx);
  const editHref = `/projects/${ctx.projectId}/specs/${ctx.specId}/edit?recoverRunId=${ctx.runId}`;
  // RLS R3a: the only write is the lineage event — run it in one org-scoped txn
  // so the `events` INSERT carries org context (PgEventStore.append routes
  // through the ambient scope). Inert in R1.
  await runWithOrgScope(pool, orgId, async (client) => {
    await new PgEventStore(client).append({
      runId: ctx.runId,
      specId: ctx.specId,
      projectId: ctx.projectId,
      orgId,
      eventType: "recovery.revise_routed",
      payload: { runId: ctx.runId, specId: ctx.specId, action: "revise_spec", editHref },
    });
  });
  return { action: "revise_spec", runId: ctx.runId, specId: ctx.specId, editHref };
}

export interface ReplanResult {
  action: "replan_with_steering";
  runId: string;
  specId: string;
  replanRunId: string;
  plannerTaskId: string;
}

/**
 * replan_with_steering — append the operator's steering note to the spec
 * description, then re-invoke the planner by queuing a fresh run from the spec
 * (the loop picks it up from the job queue). The steering note is
 * carried into the next planner invocation via the spec text it plans against.
 */
export async function replanWithSteering(
  pool: pg.Pool,
  ctx: HaltedRunContext,
  orgId: string,
  steeringNote: string,
  actor: ActorContext,
): Promise<ReplanResult> {
  assertRecoverable(ctx);
  // RLS R3a: the spec-prep UPDATEs run in their OWN short org-scoped txn so they
  // COMMIT before `createQueuedRunFromSpec` (which opens its own org-scoped txn
  // on a separate connection and claims the now-`pending` spec) reads them. This
  // mirrors the prior autocommit-per-statement ordering — wrapping the whole
  // action in one outer txn would hide the UPDATE from the nested claim and
  // break replan. Inert in R1.
  // v55 #59 plane-split note: this `appendSteeringToSpec` / `reopenSpecForReplan` pair
  // runs raw `UPDATE specs` on `pool` — which here is the orchestrator's PRIVILEGED
  // `tanren_app` pool (the dashboard route hands `scopedPool` from `mountFeatureRoutes`,
  // a scoping proxy over the same role; baseline migration 0000:870 grants
  // INSERT/UPDATE/DELETE on `specs` to `tanren_app`). Unlike the gate-fail rework router
  // (which runs from a data-plane worker on the de-privileged `tanren_dataplane` pool —
  // baseline 0000:919 REVOKEs `specs` writes on that role and is the v55 #59 fix site),
  // this dashboard-triggered path lands on the right role and needs no writer routing.
  await runWithOrgScope(pool, orgId, async (client) => {
    await appendSteeringToSpec(client, ctx.specId, steeringNote);
    await reopenSpecForReplan(client, ctx.specId);
  });
  const run = await createQueuedRunFromSpec(pool, { specId: ctx.specId, trigger: "dashboard" }, { ...actor, orgId });
  await runWithOrgScope(pool, orgId, async (client) => {
    await new PgEventStore(client).append({
      runId: ctx.runId,
      specId: ctx.specId,
      projectId: ctx.projectId,
      orgId,
      eventType: "recovery.replan_queued",
      payload: {
        runId: ctx.runId,
        specId: ctx.specId,
        action: "replan_with_steering",
        steeringNote,
        replanRunId: run.runId,
        plannerTaskId: run.plannerTaskId,
      },
    });
  });
  return {
    action: "replan_with_steering",
    runId: ctx.runId,
    specId: ctx.specId,
    replanRunId: run.runId,
    plannerTaskId: run.plannerTaskId,
  };
}

export interface RollbackResult {
  action: "rollback_to_commit";
  runId: string;
  specId: string;
  commitSha: string;
  replanRunId: string;
}

/**
 * rollback_to_commit — reset the workspace to a named known-good commit and
 * re-queue from there. Destructive (discards partial work), so it requires
 * `confirmed: true` and refuses when no prior commit exists. The commit must be
 * one the run actually captured. Re-queuing runs the planner loop against the
 * spec at the rolled-back baseline.
 */
export async function rollbackToCommit(
  pool: pg.Pool,
  ctx: HaltedRunContext,
  orgId: string,
  args: { commitSha: string; confirmed: boolean },
  actor: ActorContext,
): Promise<RollbackResult> {
  assertRecoverable(ctx);
  if (!args.confirmed) {
    throw new RollbackNotConfirmedError();
  }
  if (ctx.lastGoodCommit === null) {
    throw new NoPriorCommitError(ctx.runId);
  }
  // RLS R3a: the captured-commit read + the spec-reopen UPDATE run in one short
  // org-scoped txn (commits before the nested `createQueuedRunFromSpec` claims
  // the spec — see replanWithSteering for the ordering rationale). Inert in R1.
  await runWithOrgScope(pool, orgId, async (client) => {
    const captured = await loadCapturedCommits(client, ctx.runId);
    if (!captured.includes(args.commitSha)) {
      throw new UnknownCommitError(args.commitSha);
    }
    await reopenSpecForReplan(client, ctx.specId);
  });
  const run = await createQueuedRunFromSpec(pool, { specId: ctx.specId, trigger: "dashboard" }, { ...actor, orgId });
  await runWithOrgScope(pool, orgId, async (client) => {
    await new PgEventStore(client).append({
      runId: ctx.runId,
      specId: ctx.specId,
      projectId: ctx.projectId,
      orgId,
      eventType: "recovery.rollback_queued",
      payload: {
        runId: ctx.runId,
        specId: ctx.specId,
        action: "rollback_to_commit",
        commitSha: args.commitSha,
        confirmed: true,
        replanRunId: run.runId,
      },
    });
  });
  return {
    action: "rollback_to_commit",
    runId: ctx.runId,
    specId: ctx.specId,
    commitSha: args.commitSha,
    replanRunId: run.runId,
  };
}

export interface InspectionThreadResult {
  action: "open_inspection_thread";
  runId: string;
  specId: string;
  threadId: string;
}

/**
 * open_inspection_thread — create a Forge thread bound to the run with read
 * access to the disagreement history. Read-only: opening it triggers no state
 * change. The thread's run scope gives it access to the auditor/writer verdict
 * events the operator reads before deciding.
 */
export async function openInspectionThread(
  pool: pg.Pool,
  ctx: HaltedRunContext,
  orgId: string,
  actor: ActorContext,
): Promise<InspectionThreadResult> {
  assertRecoverable(ctx);
  // RLS R3a: this was the flagged residual — `ForgeThreadStore.create` wrote a
  // `forge_threads` row with NO org context. Run the thread create + the lineage
  // event append in ONE org-scoped txn so both carry org context. No nested
  // run-create here, so a single outer scope is safe. Inert in R1.
  const thread = await runWithOrgScope(pool, orgId, async (client) => {
    const created = await ForgeThreadStore.create(
      client,
      {
        orgId,
        projectId: ctx.projectId,
        runId: ctx.runId,
        scope: "run",
        title: `recovery · run ${ctx.runId}`,
      },
      actor,
    );
    await new PgEventStore(client).append({
      runId: ctx.runId,
      specId: ctx.specId,
      projectId: ctx.projectId,
      orgId,
      eventType: "recovery.inspection_opened",
      payload: {
        runId: ctx.runId,
        specId: ctx.specId,
        action: "open_inspection_thread",
        threadId: created.id,
      },
    });
    return created;
  });
  return {
    action: "open_inspection_thread",
    runId: ctx.runId,
    specId: ctx.specId,
    threadId: thread.id,
  };
}

/** Append the operator's steering note to the spec description (idempotent-ish). */
async function appendSteeringToSpec(pool: QueryClient, specId: string, steeringNote: string): Promise<void> {
  await RecoveryStore.appendSteeringToSpec(pool, specId, steeringNote, systemActor);
}

/**
 * Re-open the spec so `createQueuedRunFromSpec` (which claims a `pending` spec)
 * can queue a fresh run. A halted run leaves the spec in `active`; resetting it
 * to `pending` lets the recovery replan re-claim it.
 */
async function reopenSpecForReplan(pool: QueryClient, specId: string): Promise<void> {
  await RecoveryStore.reopenSpecForReplan(pool, specId, systemActor);
}
