import { migrateProjectConfig } from "../../engine/config/index.js";
import { GreenfieldRepoNotEmptyError, RepositoryAlreadyExistsError } from "../../engine/contracts/codeHostTypes.js";
import type { PreparedGreenfieldDeploy } from "../../engine/forge/interview/index.js";
import {
  mutateProjectConfig,
  ProjectDerivationStore,
  projectDerivationFingerprint,
  ProjectStore,
  withProjectDerivationLock,
  type ProjectDerivationRow,
  type ProjectRow,
} from "../../engine/repositories/projects.js";
import {
  provisionAutonomousProject,
  type ProvisionAutonomousProjectResult,
} from "../../engine/workflow/provisionAutonomousProject.js";
import { provisionedGreenfieldProjectConfigProof } from "../../engine/workflow/projectConfigWriteGuards.js";
import { createProject } from "../../engine/workflow/projectSpec.js";
import { createGreenfieldRepository } from "./greenfieldRepoCreate.js";
import { probeGreenfieldRepositoryBareAutoInit } from "./greenfieldRepoProbe.js";
import { preflightGreenfieldDeploy } from "./greenfieldDeployAuthority.js";
import { prepareGreenfieldDeploy } from "./greenfieldDeployPrepare.js";
import type { GreenfieldCreateDeps } from "./greenfield.js";

type Unavailable = Exclude<Awaited<ReturnType<typeof preflightGreenfieldDeploy>>, undefined>;

export type DirectGreenfieldResult =
  | { kind: "unavailable"; outcome: Unavailable }
  | { kind: "conflict"; reason: "request_changed" | "repo_bound_without_derivation" | "project_not_deriving" }
  | { kind: "deploy_failed"; error: unknown }
  | { kind: "bootstrap_failed"; bootstrap: ProvisionAutonomousProjectResult }
  | {
      kind: "complete";
      fresh: boolean;
      project: { projectId: string; name: string; repoUrl: string; defaultBranch: string };
      repository: { fullName: string; repoUrl: string; defaultBranch: string };
      deploy: PreparedGreenfieldDeploy["outcome"];
      bootstrap: ProvisionAutonomousProjectResult;
    };

interface DirectReceipts {
  deploy_intent?: { effect: "deploy"; idempotencyKey: string };
  deploy?: PreparedGreenfieldDeploy;
  bootstrap?: ProvisionAutonomousProjectResult;
}

function receipts(operation: ProjectDerivationRow): DirectReceipts {
  return operation.resultReceipt as DirectReceipts;
}

function projectView(project: ProjectRow | Awaited<ReturnType<typeof createProject>>) {
  return {
    projectId: project.projectId,
    name: project.name,
    repoUrl: project.repoUrl,
    defaultBranch: project.defaultBranch,
  };
}

function canonicalRepoUrl(value: string): string {
  return value.replace(/\.git$/u, "");
}

function matchesDirectShell(project: ProjectRow, deps: GreenfieldCreateDeps, repoUrl: string): boolean {
  if (
    project.orgId !== deps.orgId ||
    project.name !== deps.input.name ||
    canonicalRepoUrl(project.repoUrl) !== canonicalRepoUrl(repoUrl)
  ) {
    return false;
  }
  try {
    return migrateProjectConfig(project.config).greenfield;
  } catch {
    return false;
  }
}

async function ensurePreflight(deps: GreenfieldCreateDeps): Promise<Unavailable | undefined> {
  const deploy = deps.input.deploy!;
  return (deps.preflightDeploy ?? preflightGreenfieldDeploy)({
    client: deps.pool,
    orgId: deps.orgId,
    providerKind: deploy.providerKind,
    actorId: deps.actor.userId,
    ...(deploy.connectionId === undefined ? {} : { connectionId: deploy.connectionId }),
    ...(deploy.grantId === undefined ? {} : { grantId: deploy.grantId }),
  });
}

/**
 * Durable direct-greenfield state machine. A project row is only a deriving
 * shell; deploy/bootstrap receipts plus the final lifecycle CAS are completion.
 */
export async function runDirectGreenfieldDerivation(
  deps: GreenfieldCreateDeps,
  repoUrl: string,
): Promise<DirectGreenfieldResult> {
  return withProjectDerivationLock(deps.pool, deps.orgId, repoUrl, async () => {
    const fingerprint = projectDerivationFingerprint({
      kind: "direct_greenfield",
      orgId: deps.orgId,
      repoUrl,
      request: deps.input,
    });
    let project = await ProjectStore.findByRepoUrl(deps.pool, deps.orgId, repoUrl, { kind: "operator" });
    let operation =
      project === undefined
        ? undefined
        : await ProjectDerivationStore.findForProject(deps.pool, deps.orgId, project.projectId);

    if (project !== undefined && !matchesDirectShell(project, deps, repoUrl)) {
      return { kind: "conflict", reason: "repo_bound_without_derivation" };
    }

    if (project?.lifecycle === "active") {
      if (operation?.status !== "succeeded") return { kind: "conflict", reason: "repo_bound_without_derivation" };
      if (operation.idempotencyFingerprint !== fingerprint) return { kind: "conflict", reason: "request_changed" };
      return completedResult(false, project, operation, deps);
    }
    if (project?.lifecycle === "archived") return { kind: "conflict", reason: "project_not_deriving" };
    if (operation !== undefined && operation.idempotencyFingerprint !== fingerprint) {
      return { kind: "conflict", reason: "request_changed" };
    }

    let fresh = false;
    let repository = {
      fullName: `${deps.input.owner}/${deps.input.name}`,
      repoUrl: project?.repoUrl ?? repoUrl,
      defaultBranch: project?.defaultBranch ?? deps.input.defaultBranch ?? "main",
    };

    if (project === undefined) {
      const unavailable = await ensurePreflight(deps);
      if (unavailable !== undefined) return { kind: "unavailable", outcome: unavailable };
      let created;
      try {
        created = await createGreenfieldRepository({
          pool: deps.pool,
          secrets: deps.secrets,
          githubHttp: deps.githubHttp,
          orgId: deps.orgId,
          ...(deps.githubAppMinter === undefined ? {} : { githubAppMinter: deps.githubAppMinter }),
          input: {
            owner: deps.input.owner,
            name: deps.input.name,
            private: deps.input.private ?? true,
            autoInit: true,
            ...(deps.input.description === undefined ? {} : { description: deps.input.description }),
          },
        });
      } catch (error) {
        if (!(error instanceof RepositoryAlreadyExistsError)) throw error;
        // Crash window: repo creation succeeded but the deriving shell did not.
        // Reattach only to a bare auto-init target. A same-name repository with
        // real content belongs to another attempt/operator and is never reused.
        const bare = await probeGreenfieldRepositoryBareAutoInit({
          pool: deps.pool,
          secrets: deps.secrets,
          githubHttp: deps.githubHttp,
          ...(deps.githubAppMinter === undefined ? {} : { githubAppMinter: deps.githubAppMinter }),
          orgId: deps.orgId,
          target: { owner: deps.input.owner, name: deps.input.name },
        });
        if (!bare) throw new GreenfieldRepoNotEmptyError(deps.input.owner, deps.input.name);
        created = {
          fullName: `${deps.input.owner}/${deps.input.name}`,
          repoUrl,
          defaultBranch: deps.input.defaultBranch ?? "main",
        };
      }
      repository = created;
      const createdProject = await createProject(
        deps.pool,
        {
          name: deps.input.name,
          repoUrl: created.repoUrl,
          defaultBranch: deps.input.defaultBranch ?? created.defaultBranch,
          config: { version: 1, greenfield: true },
          ...(deps.input.runnerImage === undefined ? {} : { runnerImage: deps.input.runnerImage }),
          ...(deps.input.allocator === undefined ? {} : { allocator: deps.input.allocator }),
        },
        { ...deps.actor, orgId: deps.orgId },
        { configWriteProof: provisionedGreenfieldProjectConfigProof, initialLifecycle: "deriving" },
      );
      project = { ...createdProject, orgId: deps.orgId };
      fresh = true;
    }

    operation ??= await ProjectDerivationStore.begin(deps.pool, {
      orgId: deps.orgId,
      projectId: project.projectId,
      idempotencyFingerprint: fingerprint,
      sanitizedInput: { kind: "direct_greenfield", input: deps.input },
      ownershipReceipt: { repository },
    });

    let currentReceipts = receipts(operation);
    if (currentReceipts.deploy === undefined) {
      const unavailable = await ensurePreflight(deps);
      if (unavailable !== undefined) return { kind: "unavailable", outcome: unavailable };
      const intent =
        currentReceipts.deploy_intent ?? ({ effect: "deploy", idempotencyKey: `${fingerprint}:deploy` } as const);
      if (currentReceipts.deploy_intent === undefined) {
        operation = await ProjectDerivationStore.recordReceipt(
          deps.pool,
          operation,
          "deploy_intent",
          intent,
          "template",
        );
      }
      try {
        const prepared = await (deps.prepareDeploy ?? prepareGreenfieldDeploy)({
          pool: deps.pool,
          secrets: deps.secrets,
          orgId: deps.orgId,
          projectId: project.projectId,
          actorId: deps.actor.userId,
          projectKey: `${deps.input.owner}/${deps.input.name}`,
          projectName: deps.input.name,
          idempotencyKey: intent.idempotencyKey,
          deploy: deps.input.deploy!,
        });
        if ("status" in prepared) return { kind: "unavailable", outcome: prepared };
        await mutateProjectConfig(deps.pool, project.projectId, { kind: "operator", id: deps.actor.userId }, (raw) =>
          migrateProjectConfig({ ...migrateProjectConfig(raw), greenfield: true, ...prepared.projectConfig }),
        );
        operation = await ProjectDerivationStore.recordReceipt(deps.pool, operation, "deploy", prepared, "template");
        currentReceipts = receipts(operation);
      } catch (error) {
        await ProjectDerivationStore.recordFailure(deps.pool, operation, error);
        return { kind: "deploy_failed", error };
      }
    }

    if (currentReceipts.bootstrap === undefined) {
      const bootstrap = await (deps.bootstrapProject ?? provisionAutonomousProject)({
        pool: deps.pool,
        orgId: deps.orgId,
        projectId: project.projectId,
        repoUrl: project.repoUrl,
      });
      if (bootstrap.errors.length > 0) {
        await ProjectDerivationStore.recordFailure(
          deps.pool,
          operation,
          new Error(`autonomous bootstrap incomplete: ${bootstrap.errors.map((item) => item.seed).join(", ")}`),
        );
        return { kind: "bootstrap_failed", bootstrap };
      }
      operation = await ProjectDerivationStore.recordReceipt(deps.pool, operation, "bootstrap", bootstrap, "activate");
    }

    operation = await ProjectDerivationStore.activate(deps.pool, operation);
    return completedResult(fresh, project, operation, deps);
  });
}

function completedResult(
  fresh: boolean,
  project: ProjectRow | Awaited<ReturnType<typeof createProject>>,
  operation: ProjectDerivationRow,
  deps: GreenfieldCreateDeps,
): DirectGreenfieldResult {
  const stored = receipts(operation);
  if (stored.deploy === undefined || stored.bootstrap === undefined) {
    return { kind: "conflict", reason: "repo_bound_without_derivation" };
  }
  const ownership = operation.ownershipReceipt?.["repository"] as
    | { fullName?: unknown; repoUrl?: unknown; defaultBranch?: unknown }
    | undefined;
  const repository = {
    fullName: typeof ownership?.fullName === "string" ? ownership.fullName : `${deps.input.owner}/${deps.input.name}`,
    repoUrl: typeof ownership?.repoUrl === "string" ? ownership.repoUrl : project.repoUrl,
    defaultBranch: typeof ownership?.defaultBranch === "string" ? ownership.defaultBranch : project.defaultBranch,
  };
  return {
    kind: "complete",
    fresh,
    project: projectView(project),
    repository,
    deploy: stored.deploy.outcome,
    bootstrap: stored.bootstrap,
  };
}
