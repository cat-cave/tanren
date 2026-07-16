/* eslint-disable import/max-dependencies -- durable derive composes the canonical seams */
import type pg from "pg";
import type { ActorContext } from "../../../auth/schemas.js";
import {
  RepositoryAlreadyExistsError,
  type CreatedRepository,
  type CreateRepositoryInput,
} from "../../contracts/codeHostTypes.js";
import { githubHttpsRemote } from "../../providers/github.js";
import {
  mutateProjectConfig,
  ProjectDerivationConflictError,
  ProjectDerivationStore,
  projectDerivationFingerprint,
  ProjectStore,
  withProjectDerivationLock,
  type ProjectDerivationRow,
} from "../../repositories/projects.js";
import {
  provisionAutonomousProject,
  type ProvisionAutonomousProjectResult,
} from "../../workflow/provisionAutonomousProject.js";
import { provisionedGreenfieldProjectConfigProof } from "../../workflow/projectConfigWriteGuards.js";
import { createProject } from "../../workflow/projectSpec.js";
import {
  FragmentAuthoringFailedError,
  loadFragmentLibrary,
  selectFragmentConfig,
  type FragmentLibrary,
  type FragmentSpec,
  type SeededTemplate,
  type TemplateConfig,
} from "../../templates/index.js";
import {
  assertJitAvailableForToolchain,
  autonomousConfig,
  buildProductContextFromCapture,
  productVisionConfig,
} from "./deriveBehaviorSpec.js";
import { buildEntityGraph } from "./deriveEntityGraph.js";
import { DeriveRollbackError, resolveGreenfieldReattach } from "./deriveCompensation.js";
import {
  DeployNotLinkedError,
  DeploySelectionRequiredError,
  isDeployUnavailable,
  missingDeployProvisionerError,
  resolveGreenfieldDeployDependency,
  type PreparedGreenfieldDeploy,
  type ResolvedGreenfieldDeployDependency,
} from "./deployDependency.js";
import { DeployIneligibleError } from "./deployIneligibleError.js";
import { MissingLifecycleError, scaffoldSpecsFor } from "./deriveScaffoldSpecs.js";
import { MissingDesignContractError } from "./deriveDesignContract.js";
import { InterviewCapture, safeProjectSlug, type CaptureLifecycle } from "./types.js";
import type { DeriveInput, DeriveResult } from "./derive.js";

interface DeriveReceipts {
  template_intent?: EffectIntent;
  deploy_intent?: EffectIntent;
  deploy?: PreparedGreenfieldDeploy;
  graph?: DeriveResult;
  bootstrap?: ProvisionAutonomousProjectResult;
}

interface EffectIntent {
  effect: "template" | "deploy";
  idempotencyKey: string;
}

function effectIntent(fingerprint: string, effect: EffectIntent["effect"]): EffectIntent {
  return { effect, idempotencyKey: `${fingerprint}:${effect}` };
}

export class ProjectBootstrapIncompleteError extends Error {
  override readonly name = "ProjectBootstrapIncompleteError";

  constructor(readonly bootstrap: ProvisionAutonomousProjectResult) {
    super(`autonomous bootstrap incomplete: ${bootstrap.errors.map((item) => item.seed).join(", ")}`);
  }
}

function receipts(operation: ProjectDerivationRow): DeriveReceipts {
  return operation.resultReceipt as DeriveReceipts;
}

async function resolveFragmentConfig(
  orgId: string,
  input: DeriveInput,
  lifecycle: CaptureLifecycle,
  capture: InterviewCapture,
): Promise<{ config: TemplateConfig; library: FragmentLibrary }> {
  let library = input.fragmentLibrary ?? loadFragmentLibrary();
  let decision = selectFragmentConfig(lifecycle, library);
  if (decision.kind === "ready") return { config: decision.config, library };
  if (input.runFragmentAuthoring === undefined) {
    throw new FragmentAuthoringFailedError(
      decision.missing.map((item: FragmentSpec) => item.id),
      { cause: new Error("no runFragmentAuthoring seam wired; cannot author missing fragments") },
    );
  }
  const productContext = buildProductContextFromCapture(capture);
  const authored = await input.runFragmentAuthoring({
    orgId,
    actor: input.actor,
    missing: decision.missing,
    lifecycle,
    ...(productContext === undefined ? {} : { productContext }),
  });
  if (authored.failedIds.length > 0) {
    throw new FragmentAuthoringFailedError(authored.failedIds, { failureReasons: authored.failureReasons });
  }
  library = authored.library;
  decision = selectFragmentConfig(lifecycle, library);
  if (decision.kind === "ready") return { config: decision.config, library };
  throw new FragmentAuthoringFailedError(decision.missing.map((item: FragmentSpec) => item.id));
}

async function materialize(
  input: DeriveInput,
  lifecycle: CaptureLifecycle,
  resolved: { config: TemplateConfig; library: FragmentLibrary },
  repository: CreatedRepository,
  idempotencyKey: string,
): Promise<SeededTemplate> {
  if (input.materializeTemplate === undefined) {
    throw new Error("greenfield derive requires `materializeTemplate`; an absent seam is a wiring bug");
  }
  return input.materializeTemplate({
    idempotencyKey,
    config: resolved.config,
    lifecycle,
    projectRepo: repository,
    library: resolved.library,
  });
}

async function createRepository(
  input: DeriveInput,
  slug: string,
): Promise<{ repository: CreatedRepository; created: boolean }> {
  if (input.owner === undefined || input.createRepository === undefined) {
    throw new Error("greenfield repository owner and creator are required");
  }
  let created: CreatedRepository | undefined;
  try {
    created = await input.createRepository({
      owner: input.owner,
      name: slug,
      private: input.private ?? true,
      autoInit: true,
      ...(input.description === undefined ? {} : { description: input.description }),
    });
  } catch (error) {
    if (!(error instanceof RepositoryAlreadyExistsError)) throw error;
  }
  if (created !== undefined) return { repository: created, created: true };
  const repoUrl = githubHttpsRemote({ owner: input.owner, name: slug });
  return {
    repository: await resolveGreenfieldReattach(input.owner, slug, repoUrl, input.probeRepoBareAutoInit),
    created: false,
  };
}

async function compensateRepoCreate(input: DeriveInput, repository: CreatedRepository, cause: unknown): Promise<never> {
  if (input.owner === undefined || input.deleteRepository === undefined) throw cause;
  try {
    await input.deleteRepository({ owner: input.owner, name: repository.fullName.split("/").at(-1)! });
  } catch (error) {
    throw new DeriveRollbackError(cause, [{ kind: "github.repo", label: repository.fullName, error }]);
  }
  throw cause;
}

async function preflight(input: DeriveInput, deploy: ResolvedGreenfieldDeployDependency): Promise<void> {
  if (input.preflightDeploy === undefined) return;
  const unavailable = await input.preflightDeploy({
    orgId: input.orgId,
    providerKind: deploy.providerKind,
    ...(deploy.connectionId === undefined ? {} : { connectionId: deploy.connectionId }),
    ...(deploy.grantId === undefined ? {} : { grantId: deploy.grantId }),
  });
  if (unavailable?.status === "not_linked") throw new DeployNotLinkedError(unavailable);
  if (unavailable?.status === "selection_required") throw new DeploySelectionRequiredError(unavailable);
  if (unavailable?.status === "ineligible") throw new DeployIneligibleError(unavailable);
}

function repositoryForExisting(
  input: DeriveInput,
  slug: string,
  project: { repoUrl: string; defaultBranch: string },
): CreatedRepository {
  if (input.owner === undefined) throw new Error("greenfield derive requires a repository owner");
  return { fullName: `${input.owner}/${slug}`, repoUrl: project.repoUrl, defaultBranch: project.defaultBranch };
}

function completed(operation: ProjectDerivationRow): DeriveResult {
  const stored = receipts(operation);
  if (stored.graph === undefined || stored.bootstrap === undefined) {
    throw new ProjectDerivationConflictError(operation.projectId, "incomplete_receipts");
  }
  return { ...stored.graph, bootstrap: stored.bootstrap };
}

export async function deriveProductGraph(pool: pg.Pool, input: DeriveInput): Promise<DeriveResult> {
  const capture = InterviewCapture.parse(input.capture);
  if (capture.lifecycle === null) throw new MissingLifecycleError();
  if (capture.designContract === null) throw new MissingDesignContractError();
  const lifecycle = capture.lifecycle;
  assertJitAvailableForToolchain(lifecycle.toolchain);
  const deploy = resolveGreenfieldDeployDependency(input.deploy, { required: true });
  if (deploy === undefined || input.prepareDeploy === undefined) throw missingDeployProvisionerError();
  const slug = safeProjectSlug(capture);
  const repoUrl =
    input.repoUrl ?? (input.owner === undefined ? undefined : githubHttpsRemote({ owner: input.owner, name: slug }));
  if (repoUrl === undefined) throw new Error("greenfield repository owner or explicit repo URL is required");

  return withProjectDerivationLock(pool, input.orgId, repoUrl, async () => {
    const fingerprint = projectDerivationFingerprint({
      kind: "interview",
      orgId: input.orgId,
      repoUrl,
      request: { capture, owner: input.owner, autonomy: input.autonomy, deploy },
    });
    const baseConfig =
      input.autonomy === "auto" || input.autonomy === "simulated"
        ? autonomousConfig(input.autonomy)
        : { version: 1, greenfield: true };
    let project = await ProjectStore.findByRepoUrl(pool, input.orgId, repoUrl, { kind: "operator" });
    let operation =
      project === undefined
        ? undefined
        : await ProjectDerivationStore.findForProject(pool, input.orgId, project.projectId);
    if (project?.lifecycle === "active") {
      if (operation?.status !== "succeeded") {
        throw new ProjectDerivationConflictError(project.projectId, "invalid_lifecycle");
      }
      if (operation.idempotencyFingerprint !== fingerprint) {
        throw new ProjectDerivationConflictError(project.projectId, "fingerprint_mismatch");
      }
      return completed(operation);
    }
    if (project?.lifecycle === "archived") {
      throw new ProjectDerivationConflictError(project.projectId, "invalid_lifecycle");
    }
    if (operation !== undefined && operation.idempotencyFingerprint !== fingerprint) {
      throw new ProjectDerivationConflictError(operation.projectId, "fingerprint_mismatch");
    }

    let resolvedTemplate: { config: TemplateConfig; library: FragmentLibrary } | undefined;
    let repository: CreatedRepository;
    if (project === undefined) {
      await preflight(input, deploy);
      resolvedTemplate = await resolveFragmentConfig(input.orgId, input, lifecycle, capture);
      if (input.repoUrl === undefined) {
        const resolvedRepo = await createRepository(input, slug);
        repository = resolvedRepo.repository;
        try {
          project = await createProject(
            pool,
            {
              name: slug,
              repoUrl: repository.repoUrl,
              defaultBranch: repository.defaultBranch,
              config: { ...baseConfig, ...productVisionConfig(capture), lifecycle },
            },
            { ...input.actor, orgId: input.orgId },
            { configWriteProof: provisionedGreenfieldProjectConfigProof, initialLifecycle: "deriving" },
          );
        } catch (error) {
          if (resolvedRepo.created) return compensateRepoCreate(input, repository, error);
          throw error;
        }
      } else {
        if (input.owner === undefined) throw new Error("greenfield derive requires owner with an explicit repo URL");
        repository = { fullName: `${input.owner}/${slug}`, repoUrl: input.repoUrl, defaultBranch: "main" };
      }
      if (project === undefined) {
        project = await createProject(
          pool,
          {
            name: slug,
            repoUrl: repository.repoUrl,
            defaultBranch: repository.defaultBranch,
            config: { ...baseConfig, ...productVisionConfig(capture), lifecycle },
          },
          { ...input.actor, orgId: input.orgId },
          { configWriteProof: provisionedGreenfieldProjectConfigProof, initialLifecycle: "deriving" },
        );
      }
    } else {
      repository = repositoryForExisting(input, slug, project);
    }

    operation ??= await ProjectDerivationStore.begin(pool, {
      orgId: input.orgId,
      projectId: project.projectId,
      idempotencyFingerprint: fingerprint,
      sanitizedInput: { kind: "interview", slug, deploy },
      ownershipReceipt: { repository },
    });

    try {
      let seed = operation.templateReceipt as SeededTemplate | null;
      if (seed === null) {
        resolvedTemplate ??= await resolveFragmentConfig(input.orgId, input, lifecycle, capture);
        const stored = receipts(operation);
        const intent = stored.template_intent ?? effectIntent(fingerprint, "template");
        if (stored.template_intent === undefined) {
          operation = await ProjectDerivationStore.recordReceipt(
            pool,
            operation,
            "template_intent",
            intent,
            "template",
          );
        }
        seed = await materialize(input, lifecycle, resolvedTemplate, repository, intent.idempotencyKey);
        const { migrateProjectConfig } = await import("../../config/index.js");
        await mutateProjectConfig(pool, project.projectId, { kind: "operator", id: input.actor.userId }, (raw) =>
          migrateProjectConfig({
            ...migrateProjectConfig(raw),
            ...baseConfig,
            ...productVisionConfig(capture),
            lifecycle,
            templateRef: seed!.templateRef,
          }),
        );
        operation = await ProjectDerivationStore.recordTemplate(pool, operation, seed);
      }

      let stored = receipts(operation);
      if (stored.deploy === undefined) {
        await preflight(input, deploy);
        const intent = stored.deploy_intent ?? effectIntent(fingerprint, "deploy");
        if (stored.deploy_intent === undefined) {
          operation = await ProjectDerivationStore.recordReceipt(pool, operation, "deploy_intent", intent, "graph");
        }
        const prepared = await input.prepareDeploy!({
          orgId: input.orgId,
          projectId: project.projectId,
          capability: "deploy",
          providerKind: deploy.providerKind,
          mode: deploy.mode,
          idempotencyKey: intent.idempotencyKey,
          projectKey: slug,
          projectName: slug,
          ...(deploy.connectionId === undefined ? {} : { connectionId: deploy.connectionId }),
          ...(deploy.grantId === undefined ? {} : { grantId: deploy.grantId }),
          ...(deploy.chosenResourceId === undefined ? {} : { chosenResourceId: deploy.chosenResourceId }),
          ...(deploy.stack === undefined ? {} : { stack: deploy.stack }),
          name: deploy.name ?? slug,
        });
        if (isDeployUnavailable(prepared)) {
          if (prepared.status === "not_linked") throw new DeployNotLinkedError(prepared);
          if (prepared.status === "selection_required") throw new DeploySelectionRequiredError(prepared);
          throw new DeployIneligibleError(prepared);
        }
        const { migrateProjectConfig } = await import("../../config/index.js");
        await mutateProjectConfig(pool, project.projectId, { kind: "operator", id: input.actor.userId }, (raw) =>
          migrateProjectConfig({ ...migrateProjectConfig(raw), ...prepared.projectConfig }),
        );
        operation = await ProjectDerivationStore.recordReceipt(pool, operation, "deploy", prepared, "graph");
        stored = receipts(operation);
      }

      if (stored.graph === undefined) {
        const actor: ActorContext = { ...input.actor, orgId: input.orgId, projectId: project.projectId };
        const graph = await buildEntityGraph(
          pool,
          input,
          capture,
          slug,
          seed,
          repository,
          project.projectId,
          actor,
          scaffoldSpecsFor(lifecycle, seed),
        );
        operation = await ProjectDerivationStore.recordReceipt(pool, operation, "graph", graph, "graph");
        stored = receipts(operation);
      }

      if (stored.bootstrap === undefined) {
        const bootstrap = await (input.bootstrapProject ?? provisionAutonomousProject)({
          pool,
          orgId: input.orgId,
          projectId: project.projectId,
          repoUrl: repository.repoUrl,
        });
        if (bootstrap.errors.length > 0) throw new ProjectBootstrapIncompleteError(bootstrap);
        operation = await ProjectDerivationStore.recordReceipt(pool, operation, "bootstrap", bootstrap, "activate");
      }
      operation = await ProjectDerivationStore.activate(pool, operation);
      return completed(operation);
    } catch (error) {
      await ProjectDerivationStore.recordFailure(pool, operation, error);
      throw error;
    }
  });
}

export type { CreateRepositoryInput };
