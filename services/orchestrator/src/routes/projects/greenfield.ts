// GREENFIELD: the project-create path that needs NO existing repo. An end user
// posts `{ name, owner, greenfield: true, private?, defaultBranch?, description? }`
// (no repoUrl) and Tanren creates a brand-new GitHub repo via the minimal
// `CodeHost.createRepo` seam (decomposition PR-3) — the route constructs the
// `CodeHost` from the shared GitHub HTTP client + the standalone `resolveVcsToken`
// credential supplier (decomposition §5a/PR-2), authenticating with the org's
// GitHub App installation token when the App is installed, ELSE the org-default
// static `github_token` (a PAT with repo-create scope) — then binds a new project to
// the real new repoUrl. Extracted from `index.ts` so that file stays under the
// per-file line cap. Org-scoping is preserved: the token resolves against THIS org's
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
import { OrganizationsStore, OrgIntegrationsStore } from "../../engine/repositories/index.js";
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
import { githubHttpsRemote } from "../../engine/providers/github.js";
import { ProjectStore } from "../../engine/repositories/projects.js";
import { provisionAutonomousProject } from "../../engine/workflow/provisionAutonomousProject.js";
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
  githubHttp: GitHubHttpClient;
  githubAppMinter?: GithubAppTokenMinter;
  orgId: string;
  actor: ActorContext;
  input: GreenfieldCreateInput;
}

// The repo-create step (credential-resolve + `CodeHost.createRepo`) lives in
// `greenfieldRepoCreate.ts`; re-exported here so existing consumers (onboarding
// derive + template create) keep importing it from the greenfield surface.
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
  const { pool, secrets, githubHttp, orgId, actor, input } = deps;
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

  // IDEMPOTENT GREENFIELD CREATE (audit §3.10). The deterministic repo URL
  // (`https://github.com/<owner>/<name>.git`) is the idempotency KEY — there is one
  // greenfield project per repo. The order is REPO-FIRST so a stranded retry RESUMES
  // off the durable `projects` row instead of double-provisioning + 409-ing:
  //
  //   1. Create the repo. If it ALREADY EXISTS (a prior attempt created it), don't
  //      409 — look up the project bound to that repo and RESUME from there.
  //   2. The project row is the COMPLETION ANCHOR. A retry that finds it returns it
  //      idempotently; a retry that finds the repo but NO project re-attaches to the
  //      repo (the strand-after-repo-create window) and continues.
  //   3. Deploy is provisioned ONLY when the (existing-or-new) project has no deploy
  //      target yet — so a resume never provisions a SECOND deploy app.
  const repoUrl = githubHttpsRemote({ owner: input.owner, name: input.name });
  const scopedActor: ActorContext = { ...actor, orgId };

  // A pre-existing project for this repo ⇒ a full REPLAY of a completed create. Return
  // it idempotently (no repo-create, no deploy-provision, no 409). The store takes an
  // `ActorRef`; the org-scoping pool already bounds the row to the request's org (RLS).
  const existingByRepo = await ProjectStore.findByRepoUrl(pool, repoUrl, { kind: "operator" });
  if (existingByRepo !== undefined) {
    return greenfieldCreateReplayResponse(c, deps, existingByRepo);
  }

  // Create the repo (auto-init). On `RepositoryAlreadyExistsError` the repo was made
  // by a prior stranded attempt; re-attach to it (the project lookup above already
  // proved no project is bound) rather than failing — the create completes this time.
  let created: { fullName: string; repoUrl: string; defaultBranch: string } | undefined;
  try {
    created = await createGreenfieldRepository({
      pool,
      secrets,
      githubHttp,
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
    if (error instanceof RepositoryAlreadyExistsError) {
      // RE-ATTACH: the repo exists from a prior attempt + no project is bound (checked
      // above). Continue with the deterministic repoUrl + the repo's default branch.
      created = { fullName: `${input.owner}/${input.name}`, repoUrl, defaultBranch: input.defaultBranch ?? "main" };
    } else {
      const response = greenfieldRepositoryErrorResponse(c, error);
      if (response !== undefined) return response;
      throw error;
    }
  }

  // Provision deploy ONLY now (after the repo exists) so the deploy app is the LAST
  // external resource before the durable project row — minimizing the window where a
  // crash could strand a deploy app without an anchor. (A resume past this point is
  // handled by the project-replay branch above.)
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

  // Bind a new project to the REAL new repoUrl. createProject persists under the
  // org actor's RLS scope (it self-scopes on the actor's orgId).
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

  // SHARED bootstrap (Codex round-4): seed the COMPLETE autonomous-project set —
  // the issues inbox (post-merge re-intake + user reports), the per-org default
  // notification route (apex-critical milestone delivery), AND the scheduled-audit
  // catalog (so the audit loop has work). Idempotent + org-scoped + failure-isolated.
  // The project + repo + deploy are already COMMITTED here, so a seed failure must NOT
  // 500-after-side-effects: the seam isolates each seed + records failures in
  // `bootstrap.errors` (LOUD, never silent) — the env-default route + the operator
  // surfaces still cover delivery, and a re-create re-runs the seeds.
  const bootstrap = await provisionAutonomousProject({
    pool,
    orgId,
    projectId: project.projectId,
    repoUrl: created.repoUrl,
  });
  return c.json(
    {
      ...project,
      repository: { fullName: created.fullName, repoUrl: created.repoUrl },
      inboxSource: bootstrap.inboxSource,
      bootstrap,
      deploy: preparedDeploy.outcome,
    },
    201,
  );
}

// IDEMPOTENT REPLAY (audit §3.10): a greenfield create whose project ALREADY exists
// for this repo is a retry of a completed (or near-completed) provision. Re-run the
// shared bootstrap (idempotent — it COMPLETES any provisioning the first attempt
// stranded: the inbox, the default notification route, the audit catalog) + return the
// existing project with a 200 — never a 409 + a second deploy app. The deploy is NOT
// re-provisioned (the project already carries its deploy config from the first attempt).
async function greenfieldCreateReplayResponse(
  c: Context<ActorContextEnv>,
  deps: GreenfieldCreateDeps,
  existing: { projectId: string; name: string; defaultBranch: string; repoUrl: string },
): Promise<Response> {
  // Use the project's STORED repo URL (the forge `html_url` form) so the response
  // matches the original create exactly.
  const repoUrl = existing.repoUrl;
  const bootstrap = await provisionAutonomousProject({
    pool: deps.pool,
    orgId: deps.orgId,
    projectId: existing.projectId,
    repoUrl,
  });
  return c.json(
    {
      projectId: existing.projectId,
      name: existing.name,
      repoUrl,
      defaultBranch: existing.defaultBranch,
      repository: { fullName: `${deps.input.owner}/${deps.input.name}`, repoUrl },
      inboxSource: bootstrap.inboxSource,
      bootstrap,
      idempotentReplay: true,
    },
    200,
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
  // task #27: every Tanren-created deploy app is namespaced `<orgSlug>-<projectName>`
  // so a bare `linkly` cannot collide on Fly's GLOBAL app-name namespace. Resolve
  // the Tanren org slug (`organizations.login`) up front and thread it through the
  // project context — the provisioner's `deployAppName` reads it.
  const orgSlug = await OrganizationsStore.getLogin(input.pool, input.orgId, { kind: "operator", id: input.actorId });
  const projectCtx = {
    projectId: `pending:${input.projectKey}`,
    orgId: input.orgId,
    orgSlug,
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
