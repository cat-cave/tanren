// Greenfield anchors an org-authorized repo and exact deploy account in one project.

import type { Context } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import type { SecretStore } from "../../engine/contracts/secretStore.js";
import {
  GreenfieldRepoNotEmptyError,
  RepositoryAlreadyExistsError,
  RepositoryCreationForbiddenError,
} from "../../engine/contracts/codeHostTypes.js";
import {
  createGreenfieldRepository,
  GithubCredentialMissingError,
  type GreenfieldRepositoryCreateDeps,
} from "./greenfieldRepoCreate.js";
import type { GitHubHttpClient } from "../../engine/providers/github.js";
import {
  DeployProviderInvalidError,
  DeployProviderMissingError,
  missingDeployProviderError,
  resolveGreenfieldDeployDependency,
} from "../../engine/forge/interview/index.js";
import type { GithubAppTokenMinter } from "../../engine/providers/githubAppTokenMinter.js";
import { githubHttpsRemote } from "../../engine/providers/github.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import type {
  ProvisionAutonomousProjectInput,
  ProvisionAutonomousProjectResult,
} from "../../engine/workflow/provisionAutonomousProject.js";
import type { preflightGreenfieldDeploy } from "./greenfieldDeployAuthority.js";
import type { prepareGreenfieldDeploy, prepareGreenfieldNotify } from "./greenfieldDeployPrepare.js";
import { runDirectGreenfieldDerivation } from "./greenfieldCreateStateMachine.js";

export { preflightGreenfieldDeploy } from "./greenfieldDeployAuthority.js";
export { prepareGreenfieldDeploy, prepareGreenfieldNotify } from "./greenfieldDeployPrepare.js";

export const SUPPORTED_DEPLOY_PROVIDER_KINDS = ["deploy.vercel", "deploy.flyio"] as const;

export const GreenfieldDeploySchema = z
  .object({
    providerKind: z.enum(SUPPORTED_DEPLOY_PROVIDER_KINDS),
    mode: z.enum(["greenfield", "brownfield"]).default("greenfield"),
    chosenResourceId: z.string().min(1).max(200).optional(),
    connectionId: z.string().min(1).max(200).optional(),
    grantId: z.string().min(1).max(200).optional(),
    stack: z.string().min(1).max(64).optional(),
    name: z.string().min(1).max(200).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.connectionId === undefined) !== (value.grantId === undefined)) {
      context.addIssue({
        code: "custom",
        message: "connectionId and grantId must be supplied together",
        path: value.connectionId === undefined ? ["connectionId"] : ["grantId"],
      });
    }
  });

export const GreenfieldNotifySchema = z
  .object({
    providerKind: z.literal("slack"),
    mode: z.enum(["greenfield", "brownfield"]).default("greenfield"),
    chosenResourceId: z.string().min(1).max(200).optional(),
    connectionId: z.string().min(1).max(200).optional(),
    grantId: z.string().min(1).max(200).optional(),
    name: z.string().min(1).max(200).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.connectionId === undefined) !== (value.grantId === undefined)) {
      context.addIssue({
        code: "custom",
        message: "connectionId and grantId must be supplied together",
        path: value.connectionId === undefined ? ["connectionId"] : ["grantId"],
      });
    }
  });

/**
 * The greenfield create body: NO repoUrl. `owner` is the GitHub org/user login
 * that will OWN the new repo (the account the org's App is installed on).
 * `greenfield: true` is the explicit opt-in marker. `private` defaults to true
 * (greenfield products start private). `defaultBranch` (when given) is recorded
 * on the project row; the repo's own default branch is whatever `auto_init`
 * seeds. `runnerImage`/`allocator` are the usual optional project overrides.
 */
export const GreenfieldCreateSchema = z
  .object({
    name: z.string().min(1),
    owner: z.string().min(1),
    greenfield: z.literal(true),
    private: z.boolean().optional(),
    description: z.string().min(1).optional(),
    defaultBranch: z.string().min(1).optional(),
    runnerImage: z.string().min(1).optional(),
    allocator: z.string().min(1).optional(),
    deploy: GreenfieldDeploySchema.optional(),
    notify: GreenfieldNotifySchema.optional(),
  })
  .strict();

export type GreenfieldCreateInput = z.infer<typeof GreenfieldCreateSchema>;

export interface GreenfieldCreateDeps {
  pool: pg.Pool;
  secrets: SecretStore;
  githubHttp: GitHubHttpClient;
  githubAppMinter?: GithubAppTokenMinter;
  orgId: string;
  actor: ActorContext;
  input: GreenfieldCreateInput;
  bootstrapProject?: (input: ProvisionAutonomousProjectInput) => Promise<ProvisionAutonomousProjectResult>;
  preflightDeploy?: typeof preflightGreenfieldDeploy;
  preflightNotify?: typeof preflightGreenfieldDeploy;
  prepareDeploy?: typeof prepareGreenfieldDeploy;
  prepareNotify?: typeof prepareGreenfieldNotify;
}

// Public repo-create seam used by onboarding and template creation.
export { createGreenfieldRepository, GithubCredentialMissingError };
export type { GreenfieldRepositoryCreateDeps };

export interface OrphanedResource {
  kind: string;
  resource: string;
  reason: string;
}

export function greenfieldRepositoryErrorResponse(
  c: Context<ActorContextEnv>,
  error: unknown,
  // TASK #78 — derive transactional rollback gap. When the original failure was
  // wrapped in a `DeriveRollbackError`, the route's normalize step lifts the
  // cause + the compensation-failures list, and threads the list through here so
  // every mapped error body carries the `orphanedResources` rider — the operator
  // sees exactly which resources the rollback could not undo. Absent ⇒ no
  // rollback walked (the original error re-raised verbatim); body unchanged.
  orphans?: OrphanedResource[],
): Response | undefined {
  const withOrphans = <T extends Record<string, unknown>>(body: T): T & { orphanedResources?: OrphanedResource[] } =>
    orphans === undefined ? body : { ...body, orphanedResources: orphans };
  if (error instanceof GithubCredentialMissingError) {
    return c.json(withOrphans({ error: "github_credential_missing" }), 400);
  }
  if (error instanceof RepositoryAlreadyExistsError) {
    return c.json(withOrphans({ error: "repository_already_exists", owner: error.owner, name: error.repoName }), 409);
  }
  // GREENFIELD RE-ATTACH GUARD (apex v84): the target repo already exists AND carries a
  // prior run's compose history — a re-attach would cause a cross-run base divergence.
  // Fail loud with guidance to use a unique name / delete the repo (409, not a 500).
  if (error instanceof GreenfieldRepoNotEmptyError) {
    return c.json(
      withOrphans({
        error: "greenfield_repo_not_empty",
        owner: error.owner,
        name: error.repoName,
        message: error.message,
      }),
      409,
    );
  }
  if (error instanceof RepositoryCreationForbiddenError) {
    return c.json(
      withOrphans({
        error: "repository_creation_forbidden",
        owner: error.owner,
        message: error.message,
        requiredPermission: "administration:write",
      }),
      403,
    );
  }
  return undefined;
}

/**
 * Resolve the org's GitHub App token, create the repo, then create the project
 * bound to the real new repoUrl. The typed repo-create errors map to clean
 * 409/403 responses; the token never appears in a response or a log.
 */
export async function handleGreenfieldCreate(
  c: Context<ActorContextEnv>,
  deps: GreenfieldCreateDeps,
): Promise<Response> {
  const { input } = deps;
  let deploy;
  try {
    deploy = resolveGreenfieldDeployDependency(input.deploy, { required: true });
  } catch (error) {
    return greenfieldDeployErrorResponse(c, error);
  }
  if (deploy === undefined) {
    return greenfieldDeployErrorResponse(c, missingDeployProviderError());
  }
  const repoUrl = githubHttpsRemote({ owner: input.owner, name: input.name });
  try {
    const result = await runDirectGreenfieldDerivation(deps, repoUrl);
    if (result.kind === "unavailable") {
      return c.json(
        {
          error:
            result.outcome.status === "not_linked"
              ? `${result.outcome.capability}_not_linked`
              : result.outcome.status === "ineligible"
                ? `${result.outcome.capability}_capability_ineligible`
                : `${result.outcome.capability}_selection_required`,
          ...result.outcome,
        },
        409,
      );
    }
    if (result.kind === "conflict") {
      return c.json({ error: "greenfield_derivation_conflict", reason: result.reason }, 409);
    }
    if (result.kind === "deploy_failed") {
      return c.json(
        {
          error: "deploy_provision_failed",
          message: result.error instanceof Error ? result.error.message : String(result.error),
        },
        502,
      );
    }
    if (result.kind === "notify_failed") {
      return c.json(
        {
          error: "notify_provision_failed",
          message: result.error instanceof Error ? result.error.message : String(result.error),
        },
        502,
      );
    }
    if (result.kind === "bootstrap_failed") {
      return c.json({ error: "project_bootstrap_incomplete", bootstrap: result.bootstrap }, 503);
    }
    return c.json(
      {
        ...result.project,
        lifecycle: "active",
        repository: result.repository,
        inboxSource: result.bootstrap.inboxSource,
        bootstrap: result.bootstrap,
        deploy: result.deploy,
        ...(!result.fresh && { idempotentReplay: true }),
      },
      result.fresh ? 201 : 200,
    );
  } catch (error) {
    const response = greenfieldRepositoryErrorResponse(c, error);
    if (response !== undefined) return response;
    throw error;
  }
}

function greenfieldDeployErrorResponse(c: Context<ActorContextEnv>, error: unknown): Response {
  if (error instanceof DeployProviderMissingError) {
    return c.json(
      {
        error: "deploy_provider_missing",
        capability: "deploy",
        supportedProviderKinds: SUPPORTED_DEPLOY_PROVIDER_KINDS,
        message: error.message,
      },
      400,
    );
  }
  if (error instanceof DeployProviderInvalidError) {
    return c.json(
      {
        error: "deploy_provider_invalid",
        capability: "deploy",
        supportedProviderKinds: SUPPORTED_DEPLOY_PROVIDER_KINDS,
        message: error.message,
      },
      400,
    );
  }
  throw error;
}
