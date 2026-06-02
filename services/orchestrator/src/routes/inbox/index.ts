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
// (the same deps the rest of P3 uses); the triage answerer is resolved per-ingest
// from the source's org/project via `answererFactory(target)` — production wires
// a REAL provider answerer (`buildForgeTriageAnswererFactory`), tests a fake.
// There is no deterministic fallback (§8a). Mounted on the shared `/orgs` base.

import { Hono, type Context } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import type { SecretStore } from "../../engine/contracts/secretStore.js";
import type { GitHubHttpClient } from "../../engine/providers/github.js";
import { ProposedSpec, PlacementKind } from "../../engine/forge/discovery/index.js";
import {
  acceptCandidate,
  buildInboxConnectorMap,
  CandidateNotFoundError,
  CandidateNotPlaceableError,
  closeDuplicateCandidate,
  dismissCandidate,
  foldCandidate,
  InboxStore,
  ingestSource,
  SourceKind,
  type InboxEngineDeps,
  type JiraHttpClient,
  type LinearHttpClient,
  type SentryHttpClient,
  type SourceConnector,
  type TriageAnswerer,
} from "../../engine/forge/inbox/index.js";
import type { ForgeAnswererTarget } from "../../engine/forge/providerFactory.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/index.js";

export interface InboxRoutesOptions {
  pool: pg.Pool;
  secrets: SecretStore;
  githubHttp: GitHubHttpClient;
  // Injectable Sentry transport (defaults to a fetch-based client). The Sentry
  // connector reuses `secrets` for its auth token (config `tokenRef`).
  sentryHttp?: SentryHttpClient;
  // Injectable Linear transport (defaults to a fetch-based client). The Linear
  // connector reuses `secrets` for its auth token (config `tokenRef`).
  linearHttp?: LinearHttpClient;
  // Injectable Jira transport (defaults to a fetch-based client). The Jira
  // connector reuses `secrets` for its API token (config `tokenRef`).
  jiraHttp?: JiraHttpClient;
  // The triage answerer factory, called per-ingest with the source's org/project
  // so the answerer resolves THAT project's `forge` routing. Production passes
  // `buildForgeTriageAnswererFactory` (a real provider answerer); tests pass a
  // fake. REQUIRED — there is no deterministic fallback.
  answererFactory: (target: ForgeAnswererTarget) => TriageAnswerer;
  // Test seam: override the connector map (defaults to GitHub + Sentry).
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
    autoRoute: z.boolean().default(false),
  })
  .strict();

const AcceptBody = z
  .object({
    proposals: z.array(ProposedSpec).min(1),
    placementKind: PlacementKind,
    placementLabel: z.string().min(1).max(120),
  })
  .strict();

export function createInboxRoutes(options: InboxRoutesOptions) {
  const app = new Hono<ActorContextEnv>();
  // The `issues` slot dispatches by `config.provider` (default `github`, or
  // `linear`/`jira`); `errors` is Sentry — the SAME default map the P1d poller
  // builds (shared `buildInboxConnectorMap`). GitHub sources carry no `provider`
  // and keep working. Tests may override via `options.connectors`.
  const connectors =
    options.connectors ??
    buildInboxConnectorMap({
      secrets: options.secrets,
      githubHttp: options.githubHttp,
      ...(options.sentryHttp === undefined ? {} : { sentryHttp: options.sentryHttp }),
      ...(options.linearHttp === undefined ? {} : { linearHttp: options.linearHttp }),
      ...(options.jiraHttp === undefined ? {} : { jiraHttp: options.jiraHttp }),
    });
  // The shared deps for the accept + resolution transitions — none of which
  // consult a triage answerer (they commit / move an already-triaged candidate).
  // Ingestion builds its own deps per-request with the source-scoped answerer.
  const deps: InboxEngineDeps = {
    pool: options.pool,
    connectors,
  };

  app.get("/:orgId/inbox", async (c) => {
    const orgId = c.req.param("orgId");
    if (!guard(c, orgId)) return c.json({ error: "org_access_denied" }, 403);
    const [sources, candidates] = await Promise.all([
      InboxStore.listSources(options.pool, orgId),
      InboxStore.listCandidates(options.pool, orgId),
    ]);
    return c.json({ sources, candidates }, 200);
  });

  app.post("/:orgId/inbox/sources", async (c) => {
    const orgId = c.req.param("orgId");
    if (!guard(c, orgId)) return c.json({ error: "org_access_denied" }, 403);
    const parsed = CreateSourceBody.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) return c.json({ error: "invalid_source", issues: parsed.error.issues }, 400);
    const source = await InboxStore.createSource(options.pool, { orgId, ...parsed.data });
    return c.json({ source }, 201);
  });

  app.post("/:orgId/inbox/sources/:sourceId/ingest", async (c) => {
    const orgId = c.req.param("orgId");
    if (!guard(c, orgId)) return c.json({ error: "org_access_denied" }, 403);
    const source = await InboxStore.getSource(options.pool, c.req.param("sourceId"));
    if (source === undefined || source.orgId !== orgId) {
      return c.json({ error: "source_not_found" }, 404);
    }
    // Resolve the triage answerer against the source's org/project so the model
    // grounds on the right project's specs/routing.
    const ingestDeps: InboxEngineDeps = {
      ...deps,
      answerer: options.answererFactory({
        orgId,
        ...(source.projectId === null ? {} : { projectId: source.projectId }),
      }),
    };
    try {
      const { candidates } = await ingestSource(ingestDeps, source);
      return c.json({ candidates }, 200);
    } catch (error) {
      return c.json({ error: "inbox_ingest_failed", message: messageOf(error) }, 500);
    }
  });

  app.post("/:orgId/inbox/candidates/:id/accept", async (c) => {
    const orgId = c.req.param("orgId");
    const actor = requireActor(c);
    if (!actorCanAccessOrg(actor, orgId)) return c.json({ error: "org_access_denied" }, 403);
    const parsed = AcceptBody.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) return c.json({ error: "invalid_accept", issues: parsed.error.issues }, 400);
    try {
      const result = await acceptCandidate(deps, {
        candidateId: c.req.param("id"),
        orgId,
        proposals: parsed.data.proposals,
        placementKind: parsed.data.placementKind,
        placementLabel: parsed.data.placementLabel,
        actor,
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
  deps: InboxEngineDeps,
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
  if (error instanceof CandidateNotFoundError)
    return c.json({ error: "candidate_not_found", message: error.message }, 404);
  if (error instanceof CandidateNotPlaceableError)
    return c.json({ error: "candidate_not_placeable", message: error.message }, 422);
  return c.json({ error: code, message: messageOf(error) }, 500);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
