import { runWithOrgScope } from "@tanren/db";
import type { Hono } from "hono";
import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import type { SecretStore } from "../../engine/contracts/secretStore.js";
import {
  GithubReviewerAppIdentity,
  ReviewerAppNotConfiguredError,
} from "../../engine/governance/githubReviewerAppIdentity.js";
import {
  RepositoryVisibilityDeclarationRequiredError,
  RepositoryVisibilityEnforcer,
  RepositoryVisibilityProjectNotFoundError,
  type RepositoryVisibilityDecision,
  type ReviewerAppIdentity,
} from "../../engine/governance/repoVisibility.js";
import { RepositoryVisibilityObservationsStore } from "../../engine/repositories/repositoryVisibilityObservations.js";
import type { GitHubHttpClient } from "../../engine/providers/github.js";
import type { GithubAppTokenMinter } from "../../engine/providers/githubAppTokenMinter.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg, actorIsOrgAdmin } from "../orgs/access.js";

export interface RepositoryVisibilityService {
  observe(input: { orgId: string; projectId: string }): Promise<RepositoryVisibilityDecision>;
  read(input: { orgId: string; projectId: string }): Promise<{
    declaredVisibility: "public" | "private";
    observations: Awaited<ReturnType<typeof RepositoryVisibilityObservationsStore.list>>;
  }>;
}

export interface RepositoryVisibilityServiceOptions {
  readonly pool: pg.Pool;
  readonly secrets: SecretStore;
  readonly githubHttp: GitHubHttpClient;
  readonly githubAppMinter?: GithubAppTokenMinter;
  readonly reviewerAppIdentity?: ReviewerAppIdentity;
}

export function createRepositoryVisibilityService(
  options: RepositoryVisibilityServiceOptions,
): RepositoryVisibilityService {
  const reviewerApp =
    options.reviewerAppIdentity ??
    new GithubReviewerAppIdentity({
      pool: options.pool,
      secrets: options.secrets,
      http: options.githubHttp,
      ...(options.githubAppMinter === undefined ? {} : { minter: options.githubAppMinter }),
    });
  const enforcer = new RepositoryVisibilityEnforcer(options.pool, reviewerApp);
  return {
    observe: (input) => enforcer.observe(input),
    async read(input) {
      return runWithOrgScope(options.pool, input.orgId, async (client) => {
        const project = await RepositoryVisibilityObservationsStore.getProject(client, input.orgId, input.projectId);
        if (project === undefined) {
          throw new RepositoryVisibilityProjectNotFoundError(input.orgId, input.projectId);
        }
        if (project.declaredVisibility === null) {
          throw new RepositoryVisibilityDeclarationRequiredError(input.orgId, input.projectId);
        }
        return {
          declaredVisibility: project.declaredVisibility,
          observations: await RepositoryVisibilityObservationsStore.list(client, input.orgId, input.projectId),
        };
      });
    },
  };
}

interface JsonContext {
  json(body: unknown, status?: number): Response;
}

export async function handleRepositoryVisibilityRead(
  context: JsonContext,
  service: RepositoryVisibilityService,
  input: { orgId: string; projectId: string },
): Promise<Response> {
  try {
    return context.json(await service.read(input));
  } catch (error) {
    return repositoryVisibilityError(context, error);
  }
}

export async function handleRepositoryVisibilityObserve(
  context: JsonContext,
  service: RepositoryVisibilityService,
  input: { orgId: string; projectId: string },
): Promise<Response> {
  try {
    const decision = await service.observe(input);
    return context.json(decision, decision.status === "allowed" ? 201 : 409);
  } catch (error) {
    return repositoryVisibilityError(context, error);
  }
}

/** Mount the org-admin observation mutation plus the member-visible readback. */
export function mountRepositoryVisibilityRoutes(
  app: Hono<ActorContextEnv>,
  service: RepositoryVisibilityService,
): void {
  app.get("/:orgId/projects/:projectId/repository-visibility", async (context) => {
    const actor = requireActor(context);
    const orgId = context.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return context.json({ error: "org_access_denied" }, 403);
    }
    return handleRepositoryVisibilityRead(context, service, {
      orgId,
      projectId: context.req.param("projectId"),
    });
  });

  app.post("/:orgId/projects/:projectId/repository-visibility/observe", async (context) => {
    const actor = requireActor(context);
    const orgId = context.req.param("orgId");
    if (!actorIsOrgAdmin(actor, orgId)) {
      return context.json({ error: "org_admin_required" }, 403);
    }
    return handleRepositoryVisibilityObserve(context, service, {
      orgId,
      projectId: context.req.param("projectId"),
    });
  });
}

function repositoryVisibilityError(context: JsonContext, error: unknown): Response {
  if (error instanceof RepositoryVisibilityProjectNotFoundError) {
    return context.json({ error: "project_not_found", message: error.message }, 404);
  }
  if (error instanceof RepositoryVisibilityDeclarationRequiredError) {
    return context.json({ error: "repository_visibility_not_declared", message: error.message }, 409);
  }
  if (error instanceof ReviewerAppNotConfiguredError) {
    return context.json({ error: "reviewer_app_not_configured", message: error.message }, 503);
  }
  throw error;
}

function requireActor(context: { var: { actor?: ActorContext } }): ActorContext {
  if (context.var.actor === undefined) {
    throw new Error("actor missing on context");
  }
  return context.var.actor;
}
