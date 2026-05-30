// P3-0010 (write-action approval): approve / reject / list Forge action
// proposals.
//
//   GET  /:orgId/forge/threads/:threadId/proposals    pending + decided list
//   POST /:orgId/forge/proposals/:proposalId/approve  approve → execute write
//   POST /:orgId/forge/proposals/:proposalId/reject    reject → record decision
//
// The model proposed the write; these routes are where a HUMAN decides. On
// approve the write executes through `buildWriteToolDispatcher`, which authz's
// the APPROVING operator's ActorContext (the write tools enforce the same gate
// as the P2A-0013 routes). Decisions are idempotent: a proposal already decided
// returns 409 and never re-executes (the store's conditional claim is the
// backstop). Mounted alongside the ask route on the same `/orgs` base.

import { runWithOrgScope } from "@tanren/db";
import { Hono } from "hono";
import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import {
  decideForgeProposal,
  ForgeProposalStore,
  ForgeThreadAccessDeniedError,
  ProposalAlreadyDecidedError,
  ProposalNotFoundError,
  tanrenAcknowledgeInsight,
  tanrenCreateSpec,
  tanrenRerunTask,
  tanrenTriggerRun,
  ToolAccessDeniedError,
  WriteToolAccessDeniedError,
  type ForgeWriteToolDispatcher,
} from "../../engine/forge/index.js";
import type { ForgeWriteToolCall } from "../../engine/answerers/schemas/forge.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/index.js";

export interface ForgeProposalRoutesOptions {
  pool: pg.Pool;
}

export function createForgeProposalRoutes(options: ForgeProposalRoutesOptions) {
  const app = new Hono<ActorContextEnv>();
  const executeWrite = buildWriteToolDispatcher(options);

  app.get("/:orgId/forge/threads/:threadId/proposals", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    try {
      // RLS R2 cohort-4 (forge): forge_action_proposals read on the org-scoped
      // client (org = path org, validated above). Inert in R1.
      const proposals = await runWithOrgScope(options.pool, orgId, (client) =>
        ForgeProposalStore.listForThread(client, c.req.param("threadId"), actor),
      );
      return c.json({ proposals });
    } catch (error) {
      if (error instanceof ForgeThreadAccessDeniedError) {
        return c.json({ error: "forge_thread_access_denied" }, 403);
      }
      return c.json({ error: "forge_proposals_read_failed", message: messageOf(error) }, 500);
    }
  });

  for (const decision of ["approve", "reject"] as const) {
    app.post(`/:orgId/forge/proposals/:proposalId/${decision}`, async (c) => {
      const actor = requireActor(c);
      const orgId = c.req.param("orgId");
      if (!actorCanAccessOrg(actor, orgId)) {
        return c.json({ error: "org_access_denied" }, 403);
      }
      try {
        // RLS R2 cohort-4 (forge): the decide engine claims the proposal,
        // records the outcome, and appends a forge turn across several
        // statements — run them in ONE org-scoped txn so each forge-table write
        // carries org context. RLS R3a: `executeWrite`'s underlying write tools
        // now route their tenant reads/writes through this ambient scope too
        // (`resolveWritableClient`); `createSpec`/`createQueuedRunFromSpec` keep
        // opening their own org-scoped txn from the actor's org.
        const result = await runWithOrgScope(options.pool, orgId, (client) =>
          decideForgeProposal(
            { client, executeWrite },
            {
              proposalId: c.req.param("proposalId"),
              decision: decision === "approve" ? "approved" : "rejected",
              actor,
            },
          ),
        );
        return c.json({ proposal: result.proposal, turn: result.turn }, 201);
      } catch (error) {
        return decisionError(c, error);
      }
    });
  }

  return app;
}

// Dispatches an approved WRITE through the typed tool layer. The write tools
// authz the actor (same gate as the P2A-0013 routes) and throw
// WriteToolAccessDeniedError / ToolAccessDeniedError on denial — surfaced by
// the decide engine as a `failed` outcome.
export function buildWriteToolDispatcher(options: ForgeProposalRoutesOptions): ForgeWriteToolDispatcher {
  const { pool } = options;
  return async (call: ForgeWriteToolCall, actor: ActorContext): Promise<unknown> => {
    switch (call.tool) {
      case "tanren.create_spec":
        return tanrenCreateSpec({ pool }, call.args, actor);
      case "tanren.trigger_run":
        return tanrenTriggerRun({ pool }, call.args, actor);
      case "tanren.rerun_task":
        return tanrenRerunTask({ pool }, call.args, actor);
      case "tanren.acknowledge_insight":
        return tanrenAcknowledgeInsight({ pool }, call.args, actor);
    }
  };
}

// Maps decide-path errors to typed HTTP statuses. ProposalAlreadyDecidedError
// is the idempotency contract: a 409 carrying the current status, never a
// re-execution.
function decisionError(c: { json: HonoJson }, error: unknown) {
  if (error instanceof ProposalNotFoundError) {
    return c.json({ error: "forge_proposal_not_found" }, 404);
  }
  if (error instanceof ProposalAlreadyDecidedError) {
    return c.json({ error: "forge_proposal_already_decided", status: error.currentStatus }, 409);
  }
  if (error instanceof ForgeThreadAccessDeniedError) {
    return c.json({ error: "forge_thread_access_denied" }, 403);
  }
  if (error instanceof ToolAccessDeniedError || error instanceof WriteToolAccessDeniedError) {
    return c.json({ error: "tool_access_denied", message: error.message }, 403);
  }
  return c.json({ error: "forge_proposal_decision_failed", message: messageOf(error) }, 500);
}

type HonoJson = <T>(body: T, status?: number) => Response;

function requireActor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) {
    throw new Error("actor missing on context");
  }
  return c.var.actor;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
