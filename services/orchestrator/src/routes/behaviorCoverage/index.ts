import { runWithOrgScope } from "@tanren/db";
import { Hono, type Context } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import type { BehaviorRevisionId } from "../../engine/contracts/behaviorRevision.js";
import { parseDigest, type CasByteStore } from "../../engine/contracts/cas.js";
import type { QueryClient } from "../../engine/data/orgScopedDb.js";
import { PgEventStore, type EventStore } from "../../engine/eventStore.js";
import { assertProjectAccess, ToolAccessDeniedError } from "../../engine/forge/tools/authz.js";
import {
  AffectedSelectionFactNotFoundError,
  AffectedSelectionFactsStore,
  type AffectedSelectionFactRepository,
} from "../../engine/repositories/affectedSelectionFacts.js";
import {
  BehaviorCoverageEdgesStore,
  BehaviorCoverageSubjectNotFoundError,
  CoverageIntegrationNodeUnavailableError,
  type BehaviorCoverageEdgesRepository,
} from "../../engine/repositories/behaviorCoverageEdges.js";
import {
  AFFECTED_TARGET_KINDS,
  boundCoverageSnapshotsEqual,
  COVERAGE_EDGE_KINDS,
  selectAffectedBehaviorRevisions,
} from "../../engine/runtimeVerification/affectedSelection.js";
import {
  appendAffectedSelectionEvent,
  buildAffectedSelectionFact,
  persistAffectedSelectionFact,
} from "../../engine/runtimeVerification/affectedSelectionFacts.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg, actorIsOrgAdmin } from "../orgs/access.js";

export interface BehaviorCoverageRoutesOptions {
  readonly pool: pg.Pool;
  readonly cas: CasByteStore;
  readonly repository?: BehaviorCoverageEdgesRepository;
  readonly facts?: AffectedSelectionFactRepository;
  readonly eventsForClient?: (client: QueryClient) => EventStore;
}

const EdgeBodySchema = z
  .object({
    behaviorRevisionId: z.string().min(1).max(200),
    edgeKind: z.enum(COVERAGE_EDGE_KINDS),
    targetRef: z.string().min(1).max(2_000),
  })
  .strict();

const AffectedSelectionBodySchema = z
  .object({
    integrationNodeId: z.string().min(1).max(200),
    targets: z
      .array(z.object({ kind: z.enum(AFFECTED_TARGET_KINDS), targetRef: z.string().min(1).max(2_000) }).strict())
      .max(500),
  })
  .strict();

type RouteContext = Context<ActorContextEnv>;

class AffectedSelectionChangedDuringPublicationError extends Error {
  public override readonly name = "AffectedSelectionChangedDuringPublicationError";
}

async function authorizeProject(
  c: RouteContext,
  pool: pg.Pool,
): Promise<{ actor: ActorContext; orgId: string; projectId: string } | Response> {
  const actor = requireActor(c);
  const orgId = requireParam(c, "orgId");
  const projectId = requireParam(c, "projectId");
  if (!actorCanAccessOrg(actor, orgId)) return c.json({ error: "org_access_denied" }, 403);
  try {
    const project = await runWithOrgScope(pool, orgId, (client) => assertProjectAccess(client, projectId, actor));
    if (project.orgId !== orgId) return c.json({ error: "project_access_denied" }, 403);
  } catch (error) {
    if (error instanceof ToolAccessDeniedError) return c.json({ error: "project_access_denied" }, 403);
    throw error;
  }
  return { actor, orgId, projectId };
}

function isResponse(value: unknown): value is Response {
  return value instanceof Response;
}

export function createBehaviorCoverageRoutes(options: BehaviorCoverageRoutesOptions) {
  const app = new Hono<ActorContextEnv>();
  const repository = options.repository ?? BehaviorCoverageEdgesStore;
  const facts = options.facts ?? AffectedSelectionFactsStore;
  const eventsForClient = options.eventsForClient ?? ((client: QueryClient) => new PgEventStore(client));

  app.get("/:orgId/projects/:projectId/behavior-coverage", async (c) => {
    const authorized = await authorizeProject(c, options.pool);
    if (isResponse(authorized)) return authorized;
    const scope = { orgId: authorized.orgId, projectId: authorized.projectId };

    let graph:
      | { readonly status: "available"; readonly behaviors: unknown; readonly uncoveredBehaviorRevisionIds: string[] }
      | { readonly status: "unavailable" };
    try {
      const snapshot = await runWithOrgScope(options.pool, scope.orgId, (client) =>
        repository.readSnapshot(client, scope),
      );
      graph = {
        status: "available",
        behaviors: snapshot.behaviors,
        uncoveredBehaviorRevisionIds: snapshot.behaviors
          .filter((behavior) => behavior.edges.length === 0)
          .map((behavior) => behavior.behaviorRevisionId),
      };
    } catch {
      graph = { status: "unavailable" };
    }

    let latestSelection:
      | { readonly status: "available"; readonly selection: unknown }
      | { readonly status: "none" }
      | { readonly status: "unavailable" };
    try {
      const latest = await runWithOrgScope(options.pool, scope.orgId, (client) =>
        facts.readLatest(client, options.cas, scope),
      );
      latestSelection =
        latest === undefined ? { status: "none" } : { status: "available", selection: latest.selection };
    } catch {
      latestSelection = { status: "unavailable" };
    }

    return c.json({ version: "v1" as const, ...scope, graph, latestSelection });
  });

  app.post("/:orgId/projects/:projectId/behavior-coverage/edges", async (c) => {
    const authorized = await authorizeProject(c, options.pool);
    if (isResponse(authorized)) return authorized;
    if (!actorIsOrgAdmin(authorized.actor, authorized.orgId)) {
      return c.json({ error: "org_admin_required" }, 403);
    }
    const parsed = EdgeBodySchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_behavior_coverage_edge", issues: parsed.error.issues }, 400);
    }
    const scope = { orgId: authorized.orgId, projectId: authorized.projectId };
    try {
      const edge = await runWithOrgScope(options.pool, scope.orgId, (client) =>
        repository.record(client, scope, {
          behaviorRevisionId: parsed.data.behaviorRevisionId as BehaviorRevisionId,
          kind: parsed.data.edgeKind,
          targetRef: parsed.data.targetRef,
        }),
      );
      return c.json({ edge }, 201);
    } catch (error) {
      if (error instanceof BehaviorCoverageSubjectNotFoundError) {
        return c.json({ error: "behavior_coverage_subject_not_found" }, 404);
      }
      return c.json({ error: "behavior_coverage_write_failed" }, 503);
    }
  });

  app.post("/:orgId/projects/:projectId/behavior-coverage/affected-selection", async (c) => {
    const authorized = await authorizeProject(c, options.pool);
    if (isResponse(authorized)) return authorized;
    const parsed = AffectedSelectionBodySchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) return c.json({ error: "invalid_affected_selection", issues: parsed.error.issues }, 400);
    const scope = { orgId: authorized.orgId, projectId: authorized.projectId };
    try {
      const initial = await runWithOrgScope(options.pool, scope.orgId, (client) =>
        repository.readBoundSnapshot(client, scope, parsed.data.integrationNodeId),
      );
      const result = selectAffectedBehaviorRevisions({
        bound: initial,
        changedTargets: parsed.data.targets,
      });
      const fact = buildAffectedSelectionFact({ bound: initial, selection: result });
      const selection = await persistAffectedSelectionFact(options.cas, fact);

      await runWithOrgScope(options.pool, scope.orgId, async (client) => {
        const locked = await repository.lockAndReadBoundSnapshot(client, scope, parsed.data.integrationNodeId);
        if (!boundCoverageSnapshotsEqual(initial, locked)) {
          throw new AffectedSelectionChangedDuringPublicationError();
        }
        await appendAffectedSelectionEvent(eventsForClient(client), selection);
      });
      return c.json({ selection }, 201);
    } catch (error) {
      if (
        error instanceof AffectedSelectionChangedDuringPublicationError ||
        error instanceof CoverageIntegrationNodeUnavailableError
      ) {
        return c.json({ error: "affected_selection_stale_during_publication" }, 409);
      }
      return c.json({ error: "affected_selection_unavailable" }, 503);
    }
  });

  app.get("/:orgId/projects/:projectId/behavior-coverage/affected-selections/:analysisId", async (c) => {
    const authorized = await authorizeProject(c, options.pool);
    if (isResponse(authorized)) return authorized;
    const scope = { orgId: authorized.orgId, projectId: authorized.projectId };
    let analysisId;
    try {
      analysisId = parseDigest(requireParam(c, "analysisId"));
    } catch {
      return c.json({ error: "invalid_affected_selection_id" }, 400);
    }
    try {
      const persisted = await runWithOrgScope(options.pool, scope.orgId, (client) =>
        facts.read(client, options.cas, scope, analysisId),
      );
      return c.json({ selection: persisted.selection });
    } catch (error) {
      if (error instanceof AffectedSelectionFactNotFoundError)
        return c.json({ error: "affected_selection_not_found" }, 404);
      return c.json({ error: "affected_selection_unavailable" }, 503);
    }
  });

  app.post("/:orgId/projects/:projectId/behavior-coverage/affected-selections/:analysisId/verify", async (c) => {
    const authorized = await authorizeProject(c, options.pool);
    if (isResponse(authorized)) return authorized;
    const scope = { orgId: authorized.orgId, projectId: authorized.projectId };
    let analysisId;
    try {
      analysisId = parseDigest(requireParam(c, "analysisId"));
    } catch {
      return c.json({ error: "invalid_affected_selection_id" }, 400);
    }
    try {
      const persisted = await runWithOrgScope(options.pool, scope.orgId, (client) =>
        facts.read(client, options.cas, scope, analysisId),
      );
      const current = await runWithOrgScope(options.pool, scope.orgId, (client) =>
        repository.lockAndReadBoundSnapshot(client, scope, persisted.fact.binding.integrationNodeId),
      );
      const original = {
        binding: persisted.fact.binding,
        snapshot: persisted.fact.snapshot,
        authorityFingerprint: persisted.fact.authorityFingerprint,
      };
      if (!boundCoverageSnapshotsEqual(original, current)) {
        return c.json({ verification: { status: "stale" as const, analysisId } }, 409);
      }
      return c.json({ verification: { status: "current" as const, analysisId } });
    } catch (error) {
      if (error instanceof AffectedSelectionFactNotFoundError)
        return c.json({ error: "affected_selection_not_found" }, 404);
      if (error instanceof CoverageIntegrationNodeUnavailableError) {
        return c.json({ verification: { status: "stale" as const, analysisId } }, 409);
      }
      return c.json({ error: "affected_selection_unavailable" }, 503);
    }
  });

  return app;
}

function requireActor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) throw new Error("actor missing on context");
  return c.var.actor;
}

function requireParam(c: RouteContext, name: string): string {
  const value = c.req.param(name);
  if (value === undefined || value === "") throw new Error(`route parameter ${name} missing`);
  return value;
}
