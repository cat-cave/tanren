// GREENFIELD: the project-create path that needs NO existing repo. An end user
// posts `{ name, owner, greenfield: true, private?, defaultBranch?, description? }`
// (no repoUrl) and Tanren creates a brand-new GitHub repo via the
// `VcsProvider.createRepository` seam — authenticating with the org's GitHub App
// installation token when the App is installed, ELSE the org-default static
// `github_token` (a PAT with repo-create scope) — then binds a new project to the
// real new repoUrl. Extracted from `index.ts` so that file stays under the per-file
// line cap. Org-scoping is preserved: the token resolves against THIS org's
// App-installation/credentials, and `createProject` persists the row under the org
// actor's RLS scope.

import type { Context } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import {
  buildIntegrationProvisioner,
  resolveSmartDefault,
  type ProvisionedArtifact,
} from "../../engine/contracts/integrationProvisioner.js";
import type { SecretStore } from "../../engine/contracts/secretStore.js";
import {
  type CreatedRepository,
  type CreateRepositoryInput,
  RepositoryAlreadyExistsError,
  RepositoryCreationForbiddenError,
  type VcsProvider,
} from "../../engine/contracts/vcsProvider.js";
import {
  loadOrgDefaultGithubCredentialRef,
  loadOrgGithubAppInstallation,
} from "../../engine/credentials/orgGithubApp.js";
import { OrgIntegrationsStore } from "../../engine/repositories/orgIntegrations.js";
import {
  productionProvisionerDeps,
  type NotLinkedResult,
  type ProvisionedResult,
} from "../../engine/integrations/provisioningEngine.js";
import {
  DeployProviderInvalidError,
  DeployProviderMissingError,
  isDeployNotLinked,
  missingDeployProviderError,
  resolveGreenfieldDeployDependency,
  type PreparedGreenfieldDeploy,
} from "../../engine/forge/interview/index.js";
import type { GithubAppTokenMinter } from "../../engine/providers/githubAppTokenMinter.js";
import { ensureIssuesInboxSource } from "../../engine/forge/inbox/index.js";
import { provisionedGreenfieldProjectConfigProof } from "../../engine/workflow/projectConfigWriteGuards.js";
import { createProject } from "../../engine/workflow/projectSpec.js";
import type { ActorContextEnv } from "../../middleware/auth.js";

export const SUPPORTED_DEPLOY_PROVIDER_KINDS = ["deploy.vercel", "deploy.flyio"] as const;

export const GreenfieldDeploySchema = z
  .object({
    providerKind: z.enum(SUPPORTED_DEPLOY_PROVIDER_KINDS),
    mode: z.enum(["greenfield", "brownfield"]).default("greenfield"),
    chosenResourceId: z.string().min(1).max(200).optional(),
    stack: z.string().min(1).max(64).optional(),
    name: z.string().min(1).max(200).optional(),
  })
  .strict();

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
  })
  .strict();

export type GreenfieldCreateInput = z.infer<typeof GreenfieldCreateSchema>;

export interface GreenfieldCreateDeps {
  pool: pg.Pool;
  secrets: SecretStore;
  vcsProvider: VcsProvider;
  githubAppMinter?: GithubAppTokenMinter;
  orgId: string;
  actor: ActorContext;
  input: GreenfieldCreateInput;
}

export interface GreenfieldRepositoryCreateDeps {
  pool: pg.Pool;
  secrets: SecretStore;
  vcsProvider: VcsProvider;
  githubAppMinter?: GithubAppTokenMinter;
  orgId: string;
  input: CreateRepositoryInput;
}

export class GithubCredentialMissingError extends Error {
  constructor() {
    super("github credential missing");
    this.name = "GithubCredentialMissingError";
  }
}

export async function createGreenfieldRepository(deps: GreenfieldRepositoryCreateDeps): Promise<CreatedRepository> {
  const { pool, secrets, vcsProvider, orgId, input } = deps;
  // Resolve the org's repo-creation credential the SAME way the rest of the system
  // does (resolveGithubToken): an App installation token when the org installed the
  // App, ELSE the org-default static `github_token` (a PAT with repo-create scope).
  // Repo creation is not App-only — requiring an installation here broke greenfield
  // for an org that connected a static PAT (the documented fallback path).
  const installation = await loadOrgGithubAppInstallation(pool, orgId);
  const staticRef = await loadOrgDefaultGithubCredentialRef(pool, orgId);
  // No App installation AND no org-default static credential ⇒ a real config gap,
  // surfaced LOUD (the operator must connect a GitHub credential). Explicit — not a
  // reliance on the resolver throwing — so the requirement is honest at this seam.
  if (installation === undefined && staticRef === undefined) {
    throw new GithubCredentialMissingError();
  }
  let token;
  try {
    token = await vcsProvider.resolveToken({
      secrets,
      ...(installation !== undefined && { installation }),
      ...(staticRef !== undefined && { staticRef }),
      ...(deps.githubAppMinter === undefined ? {} : { minter: deps.githubAppMinter }),
    });
  } catch {
    throw new GithubCredentialMissingError();
  }

  return vcsProvider.createRepository(input, token);
}

export function greenfieldRepositoryErrorResponse(c: Context<ActorContextEnv>, error: unknown): Response | undefined {
  if (error instanceof GithubCredentialMissingError) {
    return c.json({ error: "github_credential_missing" }, 400);
  }
  if (error instanceof RepositoryAlreadyExistsError) {
    return c.json({ error: "repository_already_exists", owner: error.owner, name: error.repoName }, 409);
  }
  if (error instanceof RepositoryCreationForbiddenError) {
    return c.json(
      {
        error: "repository_creation_forbidden",
        owner: error.owner,
        message: error.message,
        requiredPermission: "administration:write",
      },
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
  const { pool, secrets, vcsProvider, orgId, actor, input } = deps;
  let deploy;
  try {
    deploy = resolveGreenfieldDeployDependency(input.deploy, { required: true });
  } catch (error) {
    return greenfieldDeployErrorResponse(c, error);
  }
  if (deploy === undefined) {
    return greenfieldDeployErrorResponse(c, missingDeployProviderError());
  }
  const notLinked = await preflightGreenfieldDeploy(pool, orgId, deploy.providerKind, actor.userId);
  if (notLinked !== undefined) {
    return c.json({ error: "deploy_not_linked", ...notLinked }, 409);
  }
  let preparedDeploy: PreparedGreenfieldDeploy;
  try {
    const prepared = await prepareGreenfieldDeploy({
      pool,
      secrets,
      orgId,
      actorId: actor.userId,
      projectKey: `${input.owner}/${input.name}`,
      projectName: input.name,
      deploy,
    });
    if (isDeployNotLinked(prepared)) {
      return c.json({ error: "deploy_not_linked", ...prepared }, 409);
    }
    preparedDeploy = prepared;
  } catch (error) {
    return c.json({ error: "deploy_provision_failed", message: messageOf(error) }, 502);
  }

  let created;
  try {
    created = await createGreenfieldRepository({
      pool,
      secrets,
      vcsProvider,
      orgId,
      ...(deps.githubAppMinter === undefined ? {} : { githubAppMinter: deps.githubAppMinter }),
      input: {
        owner: input.owner,
        name: input.name,
        private: input.private ?? true,
        autoInit: true,
        ...(input.description === undefined ? {} : { description: input.description }),
      },
    });
  } catch (error) {
    const response = greenfieldRepositoryErrorResponse(c, error);
    if (response !== undefined) return response;
    throw error;
  }

  // Bind a new project to the REAL new repoUrl. createProject persists under the
  // org actor's RLS scope (it self-scopes on the actor's orgId).
  const scopedActor: ActorContext = { ...actor, orgId };
  const project = await createProject(
    pool,
    {
      name: input.name,
      repoUrl: created.repoUrl,
      defaultBranch: input.defaultBranch ?? created.defaultBranch,
      // GREENFIELD MARKER: this project has NO pre-existing repo/lockfile — Tanren
      // authors the toolchain live. Persisted so the run's in-loop deps-ensure uses
      // a NON-FROZEN install (a writer-added devDep without a regenerated lockfile
      // still installs), while brownfield keeps the frozen, lockfile-safe default.
      config: { version: 1, greenfield: true, ...preparedDeploy.projectConfig },
      ...(input.runnerImage === undefined ? {} : { runnerImage: input.runnerImage }),
      ...(input.allocator === undefined ? {} : { allocator: input.allocator }),
    },
    scopedActor,
    { configWriteProof: provisionedGreenfieldProjectConfigProof },
  );

  // L2 (post-merge re-intake): provision the matching `issues` inbox source for the
  // new repo so post-merge auto-issues + user-filed reports are ingested by default.
  // Idempotent.
  const inbox = await ensureIssuesInboxSource({
    pool,
    orgId,
    projectId: project.projectId,
    repoUrl: created.repoUrl,
  });
  return c.json(
    {
      ...project,
      repository: { fullName: created.fullName, repoUrl: created.repoUrl },
      inboxSource: { id: inbox.source.id, created: inbox.created },
      deploy: preparedDeploy.outcome,
    },
    201,
  );
}

export async function preflightGreenfieldDeploy(
  pool: pg.Pool,
  orgId: string,
  providerKind: "deploy.vercel" | "deploy.flyio",
  actorId: string,
): Promise<NotLinkedResult | undefined> {
  const grant = await OrgIntegrationsStore.getGrant(pool, orgId, providerKind, { kind: "operator", id: actorId });
  if (grant !== undefined) return undefined;
  return deployNotLinkedOutcome(orgId, providerKind);
}

export function deployNotLinkedOutcome(orgId: string, providerKind: "deploy.vercel" | "deploy.flyio"): NotLinkedResult {
  return {
    status: "not_linked",
    capability: "deploy",
    providerKind,
    message:
      `link ${providerKind} at the org level first — greenfield/apex creation requires a real ` +
      `deploy target, but org ${orgId} has no ${providerKind} grant in org_integrations.`,
    linkAffordance: { kind: "org_integration_link", providerKind, orgId },
  };
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

export async function prepareGreenfieldDeploy(input: {
  pool: pg.Pool;
  secrets: SecretStore;
  orgId: string;
  actorId: string;
  projectKey: string;
  projectName: string;
  deploy: {
    providerKind: "deploy.vercel" | "deploy.flyio";
    mode: "greenfield" | "brownfield";
    chosenResourceId?: string;
    stack?: string;
    name?: string;
  };
}): Promise<NotLinkedResult | PreparedGreenfieldDeploy> {
  const providerKind = input.deploy.providerKind;
  const grant = await OrgIntegrationsStore.getGrant(input.pool, input.orgId, providerKind, {
    kind: "operator",
    id: input.actorId,
  });
  if (grant === undefined) return deployNotLinkedOutcome(input.orgId, providerKind);

  const provisioner = buildIntegrationProvisioner(providerKind, productionProvisionerDeps(input.secrets));
  const projectCtx = {
    projectId: `pending:${input.projectKey}`,
    orgId: input.orgId,
    ...(input.deploy.stack === undefined ? {} : { stack: input.deploy.stack }),
    name: input.deploy.name ?? input.projectName,
  };
  let action: "provision" | "bind";
  let artifact: ProvisionedArtifact;
  try {
    if (input.deploy.chosenResourceId !== undefined && input.deploy.chosenResourceId !== "") {
      action = "bind";
      artifact = await provisioner.bind(grant, input.deploy.chosenResourceId, projectCtx);
    } else {
      const discovered = await provisioner.discover(grant);
      const smart = resolveSmartDefault(discovered, input.deploy.mode, { name: projectCtx.name });
      if (smart.action === "bind") {
        action = "bind";
        artifact = await provisioner.bind(grant, smart.resourceId, projectCtx);
      } else {
        action = "provision";
        artifact = await provisioner.provision(grant, projectCtx);
      }
    }
  } catch (error) {
    throw new Error(`deploy provision failed: ${messageOf(error)}`, { cause: error });
  }
  const projectConfig = artifact.projectConfig ?? {};
  if (
    artifact.deployRef === undefined ||
    projectConfig["deployProvider"] === undefined ||
    projectConfig["deployAppId"] === undefined
  ) {
    throw new Error(`deploy provision failed: ${providerKind} returned no deploy target config`);
  }
  const outcome: ProvisionedResult = {
    status: "provisioned",
    capability: "deploy",
    providerKind,
    action,
    mode: input.deploy.mode,
    secretRefNames: Object.values(artifact.secretRefs ?? {}),
    surfaces: {
      projectConfigKeys: Object.keys(projectConfig),
      deployRef: `${artifact.deployRef.provider}:${artifact.deployRef.appId}`,
    },
  };
  return { outcome, projectConfig };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
