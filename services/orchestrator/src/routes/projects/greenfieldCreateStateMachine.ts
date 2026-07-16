import { migrateProjectConfig } from "../../engine/config/index.js";
import type { PreparedGreenfieldDeploy } from "../../engine/forge/interview/index.js";
import {
  mutateProjectConfig,
  ProjectDerivationConflictError,
  ProjectDerivationStore,
  projectDerivationFingerprint,
  repositoryOwnershipMarker,
  withProjectDerivationLock,
  type ProjectRow,
} from "../../engine/repositories/projects.js";
import {
  provisionAutonomousProject,
  type ProvisionAutonomousProjectResult,
} from "../../engine/workflow/provisionAutonomousProject.js";
import { provisionedGreenfieldProjectConfigProof } from "../../engine/workflow/projectConfigWriteGuards.js";
import { createDerivationShell, loadExactDerivationShell } from "../../engine/workflow/projectDerivationShell.js";
import type { ProjectContract } from "../../engine/workflow/projectSpec.js";
import { createGreenfieldRepository } from "./greenfieldRepoCreate.js";
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

function projectView(project: ProjectRow | ProjectContract) {
  return {
    projectId: project.projectId,
    name: project.name,
    repoUrl: project.repoUrl,
    defaultBranch: project.defaultBranch,
  };
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
    const identity = {
      kind: "direct_greenfield" as const,
      orgId: deps.orgId,
      projectName: deps.input.name,
      repoUrl,
      idempotencyFingerprint: fingerprint,
    };
    let shell;
    try {
      shell = await loadExactDerivationShell(deps.pool, identity);
    } catch (error) {
      if (error instanceof ProjectDerivationConflictError) {
        return { kind: "conflict", reason: "repo_bound_without_derivation" };
      }
      throw error;
    }
    let fresh = false;
    if (shell === undefined) {
      const unavailable = await ensurePreflight(deps);
      if (unavailable !== undefined) return { kind: "unavailable", outcome: unavailable };
      shell = await createDerivationShell(deps.pool, {
        identity,
        actor: { ...deps.actor, orgId: deps.orgId },
        configWriteProof: provisionedGreenfieldProjectConfigProof,
        repository: {
          mode: "managed",
          fullName: `${deps.input.owner}/${deps.input.name}`,
          repoUrl,
          requestedDefaultBranch: deps.input.defaultBranch ?? "main",
          ownershipMarker: repositoryOwnershipMarker(fingerprint),
        },
        sanitizedInput: { kind: "direct_greenfield", input: deps.input },
        project: {
          name: deps.input.name,
          repoUrl,
          defaultBranch: deps.input.defaultBranch ?? "main",
          config: { version: 1, greenfield: true },
          ...(deps.input.runnerImage === undefined ? {} : { runnerImage: deps.input.runnerImage }),
          ...(deps.input.allocator === undefined ? {} : { allocator: deps.input.allocator }),
        },
      });
      fresh = true;
    }
    const { project } = shell;
    let { operation } = shell;
    if (project.lifecycle === "active") {
      if (operation.status !== "succeeded") return { kind: "conflict", reason: "repo_bound_without_derivation" };
      try {
        return completedResult(false, project, ProjectDerivationStore.requireComplete(operation));
      } catch (error) {
        if (error instanceof ProjectDerivationConflictError) {
          return { kind: "conflict", reason: "repo_bound_without_derivation" };
        }
        throw error;
      }
    }
    if (project.lifecycle !== "deriving") return { kind: "conflict", reason: "project_not_deriving" };

    try {
      let state = ProjectDerivationStore.decode(operation, {
        kind: "direct_greenfield",
        orgId: deps.orgId,
        projectId: project.projectId,
        repoUrl,
        idempotencyFingerprint: fingerprint,
      });
      if (state.results.repository === undefined) {
        const repository = await createGreenfieldRepository({
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
            ownershipMarker: state.ownership.ownershipMarker,
            ...(deps.input.description === undefined ? {} : { description: deps.input.description }),
          },
        });
        operation = await ProjectDerivationStore.recordReceipt(deps.pool, operation, "repository", repository, "shell");
        state = ProjectDerivationStore.decode(operation);
      }

      if (state.results.deploy === undefined) {
        const unavailable = await ensurePreflight(deps);
        if (unavailable !== undefined) return { kind: "unavailable", outcome: unavailable };
        const intent =
          state.results.deploy_intent ?? ({ effect: "deploy", idempotencyKey: `${fingerprint}:deploy` } as const);
        if (state.results.deploy_intent === undefined) {
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
          state = ProjectDerivationStore.decode(operation);
        } catch (error) {
          await ProjectDerivationStore.recordFailure(deps.pool, operation, error);
          return { kind: "deploy_failed", error };
        }
      }

      if (state.results.bootstrap === undefined) {
        const bootstrap = await (deps.bootstrapProject ?? provisionAutonomousProject)({
          pool: deps.pool,
          orgId: deps.orgId,
          projectId: project.projectId,
          repoUrl: state.results.repository!.repoUrl,
        });
        if (bootstrap.errors.length > 0) {
          await ProjectDerivationStore.recordFailure(
            deps.pool,
            operation,
            new Error(`autonomous bootstrap incomplete: ${bootstrap.errors.map((item) => item.seed).join(", ")}`),
          );
          return { kind: "bootstrap_failed", bootstrap };
        }
        operation = await ProjectDerivationStore.recordReceipt(
          deps.pool,
          operation,
          "bootstrap",
          bootstrap,
          "activate",
        );
      }

      operation = await ProjectDerivationStore.activate(deps.pool, operation);
      return completedResult(fresh, project, ProjectDerivationStore.requireComplete(operation));
    } catch (error) {
      if (error instanceof ProjectDerivationConflictError) {
        return { kind: "conflict", reason: "repo_bound_without_derivation" };
      }
      await ProjectDerivationStore.recordFailure(deps.pool, operation, error);
      throw error;
    }
  });
}

function completedResult(
  fresh: boolean,
  project: ProjectRow | ProjectContract,
  derivation: ReturnType<typeof ProjectDerivationStore.requireComplete>,
): DirectGreenfieldResult {
  if (derivation.kind !== "direct_greenfield") {
    throw new ProjectDerivationConflictError(derivation.ownership.projectId, "binding_mismatch");
  }
  return {
    kind: "complete",
    fresh,
    project: projectView(project),
    repository: derivation.results.repository,
    deploy: derivation.results.deploy.outcome,
    bootstrap: derivation.results.bootstrap,
  };
}
