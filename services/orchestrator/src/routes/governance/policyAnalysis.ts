import { runWithOrgScope } from "@tanren/db";
import { Hono, type Context } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import { assertProjectAccess, ToolAccessDeniedError } from "../../engine/forge/tools/authz.js";
import { explainPolicyDecision, simulatePolicy, validatePolicy } from "../../engine/governance/policyAnalysis.js";
import { SimulationInputSchema } from "../../engine/governance/policySimulation.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/access.js";

const ValidateBodySchema = z.object({ sourceDocument: z.unknown() }).strict();
const InlineSimulateBodySchema = z.object({ sourceDocument: z.unknown(), input: z.unknown() }).strict();

interface AuthorizedProject {
  readonly orgId: string;
  readonly projectId: string;
}

export interface PolicyAnalysisRoutesOptions {
  readonly pool: pg.Pool;
}

export function createPolicyAnalysisRoutes(options: PolicyAnalysisRoutesOptions) {
  const app = new Hono<ActorContextEnv>();
  const base = "/:orgId/projects/:projectId/governance";

  app.post(`${base}/policy/validate`, async (c) => {
    const authorized = await authorizeProject(c, options.pool);
    if (authorized instanceof Response) return authorized;
    const parsed = ValidateBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return invalidBody(c, "invalid_validate_request", parsed.error);
    const report = validatePolicy(parsed.data.sourceDocument);
    if (report.status === "malformed") return c.json({ report }, 400);
    if (report.status === "contradictory") return c.json({ report }, 422);
    return c.json({ report });
  });

  app.post(`${base}/policy/simulate`, async (c) => {
    const authorized = await authorizeProject(c, options.pool);
    if (authorized instanceof Response) return authorized;
    const parsed = InlineSimulateBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return invalidBody(c, "invalid_simulate_request", parsed.error);
    const input = SimulationInputSchema.safeParse(parsed.data.input);
    if (!input.success) return invalidBody(c, "invalid_simulation_input", input.error);
    return renderSimulation(c, simulatePolicy(parsed.data.sourceDocument, input.data));
  });

  app.post(`${base}/policy/explain`, async (c) => {
    const authorized = await authorizeProject(c, options.pool);
    if (authorized instanceof Response) return authorized;
    const parsed = InlineSimulateBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return invalidBody(c, "invalid_explain_request", parsed.error);
    const input = SimulationInputSchema.safeParse(parsed.data.input);
    if (!input.success) return invalidBody(c, "invalid_simulation_input", input.error);
    return renderExplanation(c, explainPolicyDecision(parsed.data.sourceDocument, input.data));
  });

  return app;
}

function renderSimulation(c: Context<ActorContextEnv>, outcome: ReturnType<typeof simulatePolicy>): Response {
  if (outcome.status === "malformed") return c.json({ error: "policy_malformed", issues: outcome.issues }, 400);
  if (outcome.status === "contradictory") {
    return c.json({ error: "policy_contradictory", contradictionWitnesses: outcome.contradictionWitnesses }, 422);
  }
  return c.json({ simulation: outcome.result });
}

function renderExplanation(c: Context<ActorContextEnv>, outcome: ReturnType<typeof explainPolicyDecision>): Response {
  if (!outcome.explainable) {
    if (outcome.reason === "policy_malformed")
      return c.json({ error: "policy_malformed", issues: outcome.issues }, 400);
    return c.json(
      {
        error: "policy_contradictory",
        contradictionWitnesses: outcome.contradictionWitnesses,
        witnessProofs: outcome.witnessProofs,
      },
      422,
    );
  }
  return c.json({ explanation: outcome });
}

async function authorizeProject(c: Context<ActorContextEnv>, pool: pg.Pool): Promise<AuthorizedProject | Response> {
  const actor: ActorContext | undefined = c.var.actor;
  const orgId = c.req.param("orgId");
  const projectId = c.req.param("projectId");
  if (actor === undefined || orgId === undefined || projectId === undefined) {
    return c.json({ error: "actor_or_scope_missing" }, 500);
  }
  if (!actorCanAccessOrg(actor, orgId)) return c.json({ error: "org_access_denied" }, 403);
  try {
    const access = await runWithOrgScope(pool, orgId, (client) => assertProjectAccess(client, projectId, actor));
    if (access.orgId !== orgId) return c.json({ error: "org_access_denied" }, 403);
  } catch (error) {
    if (error instanceof ToolAccessDeniedError) return c.json({ error: "project_access_denied" }, 403);
    throw error;
  }
  return { orgId, projectId };
}

function invalidBody(c: Context<ActorContextEnv>, error: string, zodError: z.ZodError): Response {
  return c.json({ error, issues: zodError.issues }, 400);
}
