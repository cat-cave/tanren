/**
 * Same-origin forge BFF proxies (palette tools, chat, proposal decisions).
 * Split from main.tsx so the composition root stays under import/max-dependencies.
 */

import type { Hono } from "hono";
import { z } from "zod";
import { clientDepsFor } from "../api/clientDeps.js";
import { OrchestratorClient } from "../api/orchestrator.js";
import type { ShellDeps } from "../app/mountShell.js";

/** Body for the dashboard's forge-tools proxy (operator-button write actions). */
const ForgeToolProxyBody = z.object({
  orgId: z.string().min(1),
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
});

/** Body for the dashboard's thick-Forge chat proxy (⌘K chat morph). */
const ForgeAskProxyBody = z.object({
  orgId: z.string().min(1),
  question: z.string().min(1).max(4000),
  projectId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
});

/** Body for the proposal approve/reject proxy (write-action approval). */
const ForgeProposalDecisionBody = z.object({
  orgId: z.string().min(1),
  proposalId: z.string().min(1),
});

/** Body for on-demand project-view narration (must not run as a GET side effect). */
const ForgeProjectNarrationBody = z.object({
  orgId: z.string().min(1),
  projectId: z.string().min(1),
  budgetUsdPerWeek: z.number().optional(),
});

/** Mount cookie-forwarding forge write proxies on the dashboard app. */
export function mountForgeBff(app: Hono, shellDeps: ShellDeps): void {
  // Operator-button write-action proxy: the palette POSTs here, we forward the
  // cookie to the orchestrator Forge tool surface (keeps the orchestrator URL
  // server-side and reuses the session cookie).
  app.post("/forge/tools", async (c) => {
    const parsed = ForgeToolProxyBody.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_tool_call", issues: parsed.error.issues }, 400);
    }
    const client = new OrchestratorClient(await clientDepsFor(c, shellDeps));
    const result = await client.invokeForgeTool(parsed.data.orgId, parsed.data.tool, parsed.data.args);
    if (result === undefined) {
      return c.json({ error: "tool_invocation_failed" }, 502);
    }
    return c.json(result);
  });

  // thick-Forge chat proxy: the ⌘K chat morph POSTs the operator's
  // question here, we forward the cookie to the orchestrator's LLM-backed
  // conversation endpoint and return the forge turn's ForgeAnswer render.
  app.post("/forge/ask", async (c) => {
    const parsed = ForgeAskProxyBody.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_ask", issues: parsed.error.issues }, 400);
    }
    const client = new OrchestratorClient(await clientDepsFor(c, shellDeps));
    const result = await client.askForge(
      parsed.data.orgId,
      parsed.data.question,
      { projectId: parsed.data.projectId, runId: parsed.data.runId },
      parsed.data.threadId,
    );
    if ("error" in result) {
      return c.json({ error: result.error }, 502);
    }
    return c.json(result);
  });

  // On-demand project-view narration: creates a forge thread + generate-project-view
  // turn. Must never run as a side effect of GET /projects/:id (cross-site GET
  // would otherwise mutate forge state with the session cookie).
  app.post("/forge/project-narration", async (c) => {
    const parsed = ForgeProjectNarrationBody.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_narration", issues: parsed.error.issues }, 400);
    }
    const client = new OrchestratorClient(await clientDepsFor(c, shellDeps));
    const render = await client.generateProjectNarration(
      parsed.data.orgId,
      parsed.data.projectId,
      parsed.data.budgetUsdPerWeek,
    );
    if (render === undefined) {
      return c.json({ error: "narration_failed" }, 502);
    }
    return c.json({ render });
  });

  // write-action approval: approve/reject a proposed write. The palette
  // island POSTs here; we forward the cookie to the orchestrator's decision
  // route (which authz's + executes under the approving operator). Idempotent —
  // an already-decided proposal surfaces as `already_decided`, never a re-run.
  for (const decision of ["approve", "reject"] as const) {
    app.post(`/forge/proposals/${decision}`, async (c) => {
      const parsed = ForgeProposalDecisionBody.safeParse(await c.req.json().catch(() => {}));
      if (!parsed.success) {
        return c.json({ error: "invalid_decision", issues: parsed.error.issues }, 400);
      }
      const client = new OrchestratorClient(await clientDepsFor(c, shellDeps));
      const result = await client.decideForgeProposal(parsed.data.orgId, parsed.data.proposalId, decision);
      const httpStatus =
        result.outcome === "decided"
          ? 200
          : result.outcome === "already_decided"
            ? 409
            : result.outcome === "denied"
              ? 403
              : result.outcome === "not_found"
                ? 404
                : 502;
      return c.json(result, httpStatus);
    });
  }
}
