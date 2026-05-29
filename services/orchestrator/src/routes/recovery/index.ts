// P2B-0008 (additive): typed Zod recovery routes for halted runs. Mounted
// under `/orgs` like the run-detail + notifications surfaces. Implements the
// four operator-initiated recovery actions:
//   POST .../runs/:runId/recovery/revise               → revise_spec
//   POST .../runs/:runId/recovery/replan               → replan_with_steering
//   POST .../runs/:runId/recovery/rollback             → rollback_to_commit
//   POST .../runs/:runId/recovery/inspection-thread    → open_inspection_thread
//   GET  .../runs/:runId/recovery                      → recovery context
//
// Authz mirrors the existing route pattern exactly: `requireActor` +
// `actorCanAccessOrg` + project/run access via `assertRunAccess` (P2A-0019).
// Every action persists a typed `recovery.*` lineage event (the events table is
// the lineage home). The heavy lifting lives in `engine/recovery`.

import type { Context } from "hono";
import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import { assertRunAccess, ToolAccessDeniedError } from "../../engine/forge/tools/authz.js";
import {
  loadHaltedRunContext,
  NoPriorCommitError,
  openInspectionThread,
  replanWithSteering,
  reviseSpec,
  rollbackToCommit,
  RollbackNotConfirmedError,
  RunNotRecoverableError,
  UnknownCommitError,
  type HaltedRunContext,
} from "../../engine/recovery/index.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/index.js";

interface RecoveryRoutesOptions {
  pool: pg.Pool;
}

const ReplanSchema = z.object({
  steeringNote: z.string().min(1),
});

const RollbackSchema = z.object({
  commitSha: z.string().min(1),
  confirmed: z.boolean(),
});

export function createRecoveryRoutes(options: RecoveryRoutesOptions) {
  const app = new Hono<ActorContextEnv>();

  // GET the recovery context for a run (spec, outcome, last-good commit). Used
  // by the dashboard halted-run page to decide which cards are enabled.
  app.get("/:orgId/projects/:projectId/runs/:runId/recovery", async (c) => {
    const gate = await gateRun(options.pool, c);
    if (gate.denial !== undefined) return gate.denial;
    return c.json({
      runId: gate.ctx.runId,
      specId: gate.ctx.specId,
      projectId: gate.ctx.projectId,
      status: gate.ctx.status,
      outcome: gate.ctx.outcome,
      lastGoodCommit: gate.ctx.lastGoodCommit,
    });
  });

  app.post("/:orgId/projects/:projectId/runs/:runId/recovery/revise", async (c) => {
    const gate = await gateRun(options.pool, c);
    if (gate.denial !== undefined) return gate.denial;
    return runAction(c, () => reviseSpec(options.pool, gate.ctx));
  });

  app.post("/:orgId/projects/:projectId/runs/:runId/recovery/replan", async (c) => {
    const gate = await gateRun(options.pool, c);
    if (gate.denial !== undefined) return gate.denial;
    const parsed = ReplanSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_replan", issues: parsed.error.issues }, 400);
    }
    return runAction(c, () =>
      replanWithSteering(options.pool, gate.ctx, gate.orgId, parsed.data.steeringNote, gate.actor),
    );
  });

  app.post("/:orgId/projects/:projectId/runs/:runId/recovery/rollback", async (c) => {
    const gate = await gateRun(options.pool, c);
    if (gate.denial !== undefined) return gate.denial;
    const parsed = RollbackSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_rollback", issues: parsed.error.issues }, 400);
    }
    return runAction(c, () =>
      rollbackToCommit(
        options.pool,
        gate.ctx,
        gate.orgId,
        { commitSha: parsed.data.commitSha, confirmed: parsed.data.confirmed },
        gate.actor,
      ),
    );
  });

  app.post("/:orgId/projects/:projectId/runs/:runId/recovery/inspection-thread", async (c) => {
    const gate = await gateRun(options.pool, c);
    if (gate.denial !== undefined) return gate.denial;
    return runAction(c, () => openInspectionThread(options.pool, gate.ctx, gate.orgId, gate.actor));
  });

  return app;
}

interface RunGate {
  actor: ActorContext;
  orgId: string;
  ctx: HaltedRunContext;
  denial?: Response;
}

/**
 * Shared authz + load gate: actor present, can access the org, can access the
 * run (project membership via P2A-0019 `assertRunAccess`), and the run+project
 * line up. Returns a `denial` Response when any check fails.
 */
async function gateRun(pool: pg.Pool, c: Context<ActorContextEnv>): Promise<RunGate> {
  const actor = requireActor(c);
  const orgId = c.req.param("orgId") ?? "";
  const projectId = c.req.param("projectId") ?? "";
  const runId = c.req.param("runId") ?? "";
  const empty: HaltedRunContext = {
    runId,
    specId: "",
    projectId,
    status: "",
    outcome: null,
    lastGoodCommit: null,
  };
  if (!actorCanAccessOrg(actor, orgId)) {
    return { actor, orgId, ctx: empty, denial: c.json({ error: "org_access_denied" }, 403) };
  }
  try {
    const access = await assertRunAccess(pool, runId, actor);
    if (access.projectId !== projectId) {
      return { actor, orgId, ctx: empty, denial: c.json({ error: "run_not_found" }, 404) };
    }
  } catch (error) {
    if (error instanceof ToolAccessDeniedError) {
      return { actor, orgId, ctx: empty, denial: c.json({ error: "run_not_found" }, 404) };
    }
    throw error;
  }
  const ctx = await loadHaltedRunContext(pool, runId);
  if (ctx === undefined || ctx.projectId !== projectId) {
    return { actor, orgId, ctx: empty, denial: c.json({ error: "run_not_found" }, 404) };
  }
  return { actor, orgId, ctx };
}

/** Run a recovery action, mapping its typed errors to HTTP statuses. */
async function runAction<T>(c: Context<ActorContextEnv>, action: () => Promise<T>): Promise<Response> {
  try {
    return c.json({ ok: true, result: await action() } as Record<string, unknown>, 200);
  } catch (error) {
    if (error instanceof RunNotRecoverableError) {
      return c.json({ error: "run_not_recoverable", message: error.message }, 409);
    }
    if (error instanceof RollbackNotConfirmedError) {
      return c.json({ error: "rollback_not_confirmed", message: error.message }, 400);
    }
    if (error instanceof NoPriorCommitError) {
      return c.json({ error: "no_prior_commit", message: error.message }, 409);
    }
    if (error instanceof UnknownCommitError) {
      return c.json({ error: "unknown_commit", message: error.message }, 400);
    }
    throw error;
  }
}

function requireActor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) {
    throw new Error("actor missing on context");
  }
  return c.var.actor;
}
