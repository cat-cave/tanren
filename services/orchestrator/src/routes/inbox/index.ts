// candidate-inbox HTTP routes.
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
// (the same deps the rest of the inbox uses); the triage answerer is resolved per-ingest
// from the source's org/project via `answererFactory(target)` — production wires
// a REAL provider answerer (`buildForgeTriageAnswererFactory`), tests a fake.
// There is no deterministic fallback (§8a). Mounted on the shared `/orgs` base.

import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import type { SecretStore } from "../../engine/contracts/secretStore.js";
import type { GitHubHttpClient } from "../../engine/providers/github.js";
import { ProposedSpec, PlacementKind } from "../../engine/forge/discovery/index.js";
import {
  acceptCandidate,
  buildPgSentryIntakeAuthority,
  buildInboxConnectorMap,
  CandidateNotFoundError,
  CandidateNotPlaceableError,
  closeDuplicateCandidate,
  dismissCandidate,
  foldCandidate,
  ingestSource,
  SourceKind,
  type InboxEngineDeps,
  type SentryHttpClient,
  type SourceConnector,
  type TriageAnswerer,
} from "../../engine/forge/inbox/index.js";
import { intakeAutoRouteDeps, intakeItem } from "../../engine/forge/intake/index.js";
import { pgRepositories } from "../../engine/contracts/repositories.js";
import type { GithubAppTokenMinter } from "../../engine/providers/githubAppTokenMinter.js";
import type { ForgeAnswererTarget } from "../../engine/forge/providerFactory.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/access.js";
import { handleProvisionWebhook } from "./webhookProvision.js";

export interface InboxRoutesOptions {
  pool: pg.Pool;
  secrets: SecretStore;
  githubHttp: GitHubHttpClient;
  // Injectable Sentry transport (defaults to a fetch-based client). Its
  // credential is resolved through exact integration authority per fetch.
  sentryHttp?: SentryHttpClient;
  // The triage answerer factory, called per-ingest with the source's org/project
  // so the answerer resolves THAT project's `forge` routing. Production passes
  // `buildForgeTriageAnswererFactory` (a real provider answerer); tests pass a
  // fake. REQUIRED — there is no deterministic fallback.
  answererFactory: (target: ForgeAnswererTarget) => TriageAnswerer;
  // Test seam: override the connector map (defaults to GitHub + Sentry).
  connectors?: ReadonlyMap<string, SourceConnector>;
  // B1 (webhook provisioning): the shared App-token minter + the public base URL
  // the GitHub `issues` webhook callback resolves against. Present in production;
  // when absent the webhook-provision endpoint is not mounted (its prerequisites
  // — App-token minting + a reachable callback URL — are not wired).
  githubAppMinter?: GithubAppTokenMinter;
  publicBaseUrl?: string;
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
  .strict()
  // Loop 6 (fail-loud, not silent-stall): an AUTO-ROUTING source MUST name a
  // project. Its candidates skip manual triage and commit straight into the DAG —
  // but the DAG insert is project-scoped, so a project-less auto-route source would
  // produce routable candidates that can never become specs (they stall in the
  // inbox). Reject the misconfiguration at creation rather than discover it per item.
  .superRefine((input, ctx) => {
    if (input.autoRoute && input.projectId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["projectId"],
        message: "an auto-routing source must name a projectId (its candidates commit directly into a project's DAG)",
      });
    }
  });

const AcceptBody = z
  .object({
    proposals: z.array(ProposedSpec).min(1),
    placementKind: PlacementKind,
    placementLabel: z.string().min(1).max(120),
  })
  .strict();

// B2 — the Tanren-native "file a bug/feature INTO Tanren" body. A non-expert posts
// a title + body (+ optional severity) and the SAME intake pipeline the webhook runs
// triages → auto-routes it. No connector/network: the report IS the item.
const ReportItemBody = z
  .object({
    title: z.string().min(1).max(300),
    body: z.string().max(8000).default(""),
    severity: z.enum(["info", "warn", "fail"]).default("info"),
    // Optional caller-supplied idempotency key (e.g. a client form id); absent ⇒ a
    // fresh id per submission, so a re-submit files a new candidate.
    externalId: z.string().min(1).max(200).optional(),
  })
  .strict();

export function createInboxRoutes(options: InboxRoutesOptions) {
  const app = new Hono<ActorContextEnv>();
  // `issues` is GitHub and `errors` is Sentry — the same authority-aware map
  // the intake poller builds. Unsupported provider configs fail strict parsing;
  // there is no bare-secret-ref provider fallback.
  const connectors =
    options.connectors ??
    buildInboxConnectorMap({
      secrets: options.secrets,
      githubHttp: options.githubHttp,
      sentryAuthority: buildPgSentryIntakeAuthority(options.pool),
      ...(options.sentryHttp === undefined ? {} : { sentryHttp: options.sentryHttp }),
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
      pgRepositories.inbox.listSources(options.pool, orgId),
      pgRepositories.inbox.listCandidates(options.pool, orgId),
    ]);
    return c.json({ sources, candidates }, 200);
  });

  app.post("/:orgId/inbox/sources", async (c) => {
    const orgId = c.req.param("orgId");
    if (!guard(c, orgId)) return c.json({ error: "org_access_denied" }, 403);
    const parsed = CreateSourceBody.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) return c.json({ error: "invalid_source", issues: parsed.error.issues }, 400);
    const source = await pgRepositories.inbox.createSource(options.pool, { orgId, ...parsed.data });
    return c.json({ source }, 201);
  });

  app.post("/:orgId/inbox/sources/:sourceId/ingest", async (c) => {
    const orgId = c.req.param("orgId");
    if (!guard(c, orgId)) return c.json({ error: "org_access_denied" }, 403);
    const source = await pgRepositories.inbox.getSource(options.pool, c.req.param("sourceId"));
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
      // B3 (autonomous-by-default): pass the auto-route deps so an `auto_routable`
      // candidate is COMMITTED into the DAG immediately (exactly like the webhook +
      // poller paths) instead of dead-ending in the inbox awaiting a click. The API
      // server runs as `tanren_app`, which retains `specs` INSERT under RLS, so the
      // direct-pool write needs no `runStateWriter` (the worker/data-plane does).
      const { candidates } = await ingestSource(ingestDeps, source, intakeAutoRouteDeps());
      return c.json({ candidates }, 200);
    } catch (error) {
      return c.json({ error: "inbox_ingest_failed", message: messageOf(error) }, 500);
    }
  });

  // B2: file a bug/feature directly INTO Tanren (no GitHub round-trip). The report
  // becomes one ingest item that flows through the SAME `intakeItem` pipeline the
  // webhook receiver uses — real triage → an `auto_routable` report is COMMITTED into
  // the DAG (autonomous by default), everything else lands in the inbox. This is the
  // end-user "filed an issue, watched it become a fixed PR" surface.
  app.post("/:orgId/inbox/sources/:sourceId/items", async (c) => {
    const orgId = c.req.param("orgId");
    if (!guard(c, orgId)) return c.json({ error: "org_access_denied" }, 403);
    const source = await pgRepositories.inbox.getSource(options.pool, c.req.param("sourceId"));
    if (source === undefined || source.orgId !== orgId) {
      return c.json({ error: "source_not_found" }, 404);
    }
    const parsed = ReportItemBody.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) return c.json({ error: "invalid_report", issues: parsed.error.issues }, 400);
    const item = {
      externalId: parsed.data.externalId ?? `report-${randomUUID()}`,
      title: parsed.data.title,
      body: parsed.data.body,
      severity: parsed.data.severity,
      projectId: source.projectId,
    };
    try {
      const outcome = await intakeItem(
        {
          pool: options.pool,
          answerer: options.answererFactory({
            orgId,
            ...(source.projectId === null ? {} : { projectId: source.projectId }),
          }),
          // The API server is `tanren_app` (retains `specs` INSERT) — direct writes.
          autoRoute: intakeAutoRouteDeps(),
        },
        source,
        item,
      );
      // Loop 6: a routable report with no unambiguous project surfaces LOUD as
      // needs_attention (a human must pick the project) — never a silent inbox-stall.
      if (outcome.kind === "needs_attention") {
        return c.json({ outcome: "needs_attention", candidate: outcome.candidate, reason: outcome.reason }, 200);
      }
      return c.json(
        outcome.kind === "auto_routed"
          ? { outcome: "auto_routed", candidate: outcome.candidate, specId: outcome.specId }
          : { outcome: "inboxed", candidate: outcome.candidate },
        201,
      );
    } catch (error) {
      return c.json({ error: "inbox_report_failed", message: messageOf(error) }, 500);
    }
  });

  // B1: provision the GitHub `issues` webhook for a project's repo over the API —
  // mints+stores the HMAC secret, creates the GitHub hook via the org's App token,
  // and wires the inbox source (config jsonb, no migration). Only mounted when the
  // minter + public base URL are wired.
  if (options.githubAppMinter !== undefined && options.publicBaseUrl !== undefined) {
    const minter = options.githubAppMinter;
    const publicBaseUrl = options.publicBaseUrl;
    app.post("/:orgId/inbox/webhooks/provision", async (c) => {
      const orgId = c.req.param("orgId");
      const actor = requireActor(c);
      if (!actorCanAccessOrg(actor, orgId)) return c.json({ error: "org_access_denied" }, 403);
      return handleProvisionWebhook(
        c,
        {
          pool: options.pool,
          secrets: options.secrets,
          githubHttp: options.githubHttp,
          githubAppMinter: minter,
          publicBaseUrl,
        },
        orgId,
        actor,
      );
    });
  }

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
