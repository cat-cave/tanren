// P3-0022 candidate-inbox HTTP routes.
//
//   GET  /:orgId/inbox                       → { sources, candidates }
//   POST /:orgId/inbox/sources               create a configurable source
//   POST /:orgId/inbox/sources/:sourceId/ingest   pull → triage → upsert candidates
//   POST /:orgId/inbox/candidates/:id/accept fold the candidate into discovery
//   POST /:orgId/inbox/candidates/:id/fold   fold into a live run
//   POST /:orgId/inbox/candidates/:id/dismiss
//   POST /:orgId/inbox/candidates/:id/close-duplicate
//
// The GitHub Issues connector is wired from the injected `secrets` + `githubHttp`
// (the same deps the rest of P3 uses); the triage answerer is injectable
// (`answererFactory`) and defaults to the deterministic grounded one, so the
// endpoint is live without provider infra. Mounted on the shared `/orgs` base.

import { Hono, type Context } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import type { SecretStore } from "../../engine/contracts/secretStore.js";
import type { GitHubHttpClient } from "../../engine/providers/github.js";
import { ProposedSpec, PlacementKind } from "../../engine/forge/discovery/index.js";
import {
  acceptCandidate,
  CandidateNotFoundError,
  CandidateNotPlaceableError,
  closeDuplicateCandidate,
  createGitHubIssuesConnector,
  createSource,
  dismissCandidate,
  foldCandidate,
  getSource,
  ingestSource,
  listCandidates,
  listSources,
  SourceKind,
  type InboxEngineDeps,
  type SourceConnector,
  type TriageAnswerer
} from "../../engine/forge/inbox/index.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/index.js";

export interface InboxRoutesOptions {
  pool: pg.Pool;
  secrets: SecretStore;
  githubHttp: GitHubHttpClient;
  // Injectable triage answerer (provider wrap or a test fake).
  answererFactory?: () => TriageAnswerer;
  // Test seam: override the connector map (defaults to the GitHub connector).
  connectors?: ReadonlyMap<string, SourceConnector>;
}

const CreateSourceBody = z
  .object({
    kind: SourceKind,
    name: z.string().min(1).max(120),
    projectId: z.string().min(1).nullable().default(null),
    detail: z.string().max(200).default(""),
    config: z.record(z.string(), z.unknown()).default({}),
    enabled: z.boolean().default(true),
    autoRoute: z.boolean().default(false)
  })
  .strict();

const AcceptBody = z
  .object({
    proposals: z.array(ProposedSpec).min(1),
    placementKind: PlacementKind,
    placementLabel: z.string().min(1).max(120)
  })
  .strict();

export function createInboxRoutes(options: InboxRoutesOptions) {
  const app = new Hono<ActorContextEnv>();
  const answerer = options.answererFactory?.();
  const connectors =
    options.connectors ??
    new Map<string, SourceConnector>([
      ["issues", createGitHubIssuesConnector({ secrets: options.secrets, githubHttp: options.githubHttp })]
    ]);
  const deps: InboxEngineDeps = { pool: options.pool, connectors, ...(answerer !== undefined ? { answerer } : {}) };

  app.get("/:orgId/inbox", async (c) => {
    const orgId = c.req.param("orgId");
    if (!guard(c, orgId)) return c.json({ error: "org_access_denied" }, 403);
    const [sources, candidates] = await Promise.all([
      listSources(options.pool, orgId),
      listCandidates(options.pool, orgId)
    ]);
    return c.json({ sources, candidates }, 200);
  });

  app.post("/:orgId/inbox/sources", async (c) => {
    const orgId = c.req.param("orgId");
    if (!guard(c, orgId)) return c.json({ error: "org_access_denied" }, 403);
    const parsed = CreateSourceBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "invalid_source", issues: parsed.error.issues }, 400);
    const source = await createSource(options.pool, { orgId, ...parsed.data });
    return c.json({ source }, 201);
  });

  app.post("/:orgId/inbox/sources/:sourceId/ingest", async (c) => {
    const orgId = c.req.param("orgId");
    if (!guard(c, orgId)) return c.json({ error: "org_access_denied" }, 403);
    const source = await getSource(options.pool, c.req.param("sourceId"));
    if (source === undefined || source.orgId !== orgId) {
      return c.json({ error: "source_not_found" }, 404);
    }
    try {
      const { candidates } = await ingestSource(deps, source);
      return c.json({ candidates }, 200);
    } catch (error) {
      return c.json({ error: "inbox_ingest_failed", message: messageOf(error) }, 500);
    }
  });

  app.post("/:orgId/inbox/candidates/:id/accept", async (c) => {
    const orgId = c.req.param("orgId");
    const actor = requireActor(c);
    if (!actorCanAccessOrg(actor, orgId)) return c.json({ error: "org_access_denied" }, 403);
    const parsed = AcceptBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "invalid_accept", issues: parsed.error.issues }, 400);
    try {
      const result = await acceptCandidate(deps, {
        candidateId: c.req.param("id"),
        orgId,
        proposals: parsed.data.proposals,
        placementKind: parsed.data.placementKind,
        placementLabel: parsed.data.placementLabel,
        actor
      });
      return c.json(result, 201);
    } catch (error) {
      return errorResponse(c, error, "inbox_accept_failed");
    }
  });

  registerResolution(app, options.pool, "fold", foldCandidate, deps);
  registerResolution(app, options.pool, "dismiss", dismissCandidate, deps);
  registerResolution(app, options.pool, "close-duplicate", closeDuplicateCandidate, deps);

  return app;
}

function registerResolution(
  app: Hono<ActorContextEnv>,
  _pool: pg.Pool,
  verb: string,
  action: (deps: InboxEngineDeps, candidateId: string) => Promise<unknown>,
  deps: InboxEngineDeps
): void {
  app.post(`/:orgId/inbox/candidates/:id/${verb}`, async (c) => {
    const orgId = c.req.param("orgId");
    if (!guard(c, orgId)) return c.json({ error: "org_access_denied" }, 403);
    try {
      const candidate = await action(deps, c.req.param("id"));
      return c.json({ candidate }, 200);
    } catch (error) {
      return errorResponse(c, error, "inbox_resolve_failed");
    }
  });
}

function guard(c: { var: { actor?: ActorContext } }, orgId: string): boolean {
  return c.var.actor !== undefined && actorCanAccessOrg(c.var.actor, orgId);
}

function requireActor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) throw new Error("actor missing on context");
  return c.var.actor;
}

function errorResponse(c: Context, error: unknown, code: string) {
  if (error instanceof CandidateNotFoundError) return c.json({ error: "candidate_not_found", message: error.message }, 404);
  if (error instanceof CandidateNotPlaceableError) return c.json({ error: "candidate_not_placeable", message: error.message }, 422);
  return c.json({ error: code, message: messageOf(error) }, 500);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
