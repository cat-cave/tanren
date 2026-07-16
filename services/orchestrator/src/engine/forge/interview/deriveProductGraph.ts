/* eslint-disable import/max-dependencies -- durable derive composes the canonical seams */
import type pg from "pg";
import type { ActorContext } from "../../../auth/schemas.js";
import { mutateProjectConfig } from "../../config/projectConfigMutate.js";
import type { CreatedRepository, CreateRepositoryInput } from "../../contracts/codeHostTypes.js";
import { githubHttpsRemote } from "../../providers/github.js";
import {
  ProjectDerivationConflictError,
  ProjectDerivationStore,
  explicitRepositoryMarker,
  projectDerivationFingerprint,
  repositoryOwnershipMarker,
  type ProjectDerivationRow,
  withProjectDerivationLock,
} from "../../repositories/projects.js";
import {
  provisionAutonomousProject,
  type ProvisionAutonomousProjectResult,
} from "../../workflow/provisionAutonomousProject.js";
import { provisionedGreenfieldProjectConfigProof } from "../../workflow/projectConfigWriteGuards.js";
import { createDerivationShell, loadExactDerivationShell } from "../../workflow/projectDerivationShell.js";
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
import { buildEntityGraphWithReceipt } from "./deriveEntityGraph.js";
import {
  DeployNotLinkedError,
  DeploySelectionRequiredError,
  isDeployUnavailable,
  missingDeployProvisionerError,
  resolveGreenfieldDeployDependency,
  type ResolvedGreenfieldDeployDependency,
} from "./deployDependency.js";
import { DeployIneligibleError } from "./deployIneligibleError.js";
import { MissingLifecycleError, scaffoldSpecsFor } from "./deriveScaffoldSpecs.js";
import {
  buildDerivationDesignPlan,
  capturedDesignResult,
  MissingDesignContractError,
  providerDesignResult,
  type DerivationDesignPlan,
} from "./deriveDesignContract.js";
import { InterviewCapture, safeProjectSlug, type CaptureLifecycle } from "./types.js";
import type { DeriveInput, DeriveResult } from "./derive.js";

interface EffectIntent<E extends "template" | "deploy"> {
  effect: E;
  idempotencyKey: string;
}

function effectIntent<E extends "template" | "deploy">(fingerprint: string, effect: E): EffectIntent<E> {
  return { effect, idempotencyKey: `${fingerprint}:${effect}` };
}

export class ProjectBootstrapIncompleteError extends Error {
  override readonly name = "ProjectBootstrapIncompleteError";

  constructor(readonly bootstrap: ProvisionAutonomousProjectResult) {
    super(`autonomous bootstrap incomplete: ${bootstrap.errors.map((item) => item.seed).join(", ")}`);
  }
}

export class ProjectDesignElaborationStateUnknownError extends Error {
  override readonly name = "ProjectDesignElaborationStateUnknownError";

  constructor(
    readonly derivationId: string,
    options?: ErrorOptions,
  ) {
    super(
      `design elaboration for derivation ${derivationId} is state_unknown; replay is forbidden until the ` +
        "durable provider result is reconciled",
      options,
    );
  }
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

async function createRepository(input: DeriveInput, slug: string, ownershipMarker: string): Promise<CreatedRepository> {
  if (input.owner === undefined || input.createRepository === undefined) {
    throw new Error("greenfield repository owner and creator are required");
  }
  return input.createRepository({
    owner: input.owner,
    name: slug,
    private: input.private ?? true,
    autoInit: true,
    ownershipMarker,
    ...(input.description === undefined ? {} : { description: input.description }),
  });
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

function completed(derivation: ReturnType<typeof ProjectDerivationStore.requireComplete>): DeriveResult {
  if (derivation.kind !== "interview") {
    throw new ProjectDerivationConflictError(derivation.ownership.projectId, "binding_mismatch");
  }
  return { ...derivation.results.graph, bootstrap: derivation.results.bootstrap };
}

type DecodedDerivation = ReturnType<typeof ProjectDerivationStore.decode>;
type DurableDesignResult = NonNullable<DecodedDerivation["results"]["design"]>;

async function resolveDurableDesign(input: {
  pool: pg.Pool;
  deriveInput: DeriveInput;
  plan: DerivationDesignPlan;
  capture: InterviewCapture;
  fingerprint: string;
  projectId: string;
  operation: ProjectDerivationRow;
  state: DecodedDerivation;
}): Promise<{ operation: ProjectDerivationRow; design: DurableDesignResult }> {
  let operation = input.operation;
  let design = input.state.results.design;
  if (design !== undefined) return { operation, design };
  if (input.state.designMode === "captured") {
    if (input.capture.designContract === null) throw new MissingDesignContractError();
    design = capturedDesignResult(input.capture.designContract, input.plan);
    operation = await ProjectDerivationStore.recordReceipt(input.pool, operation, "design", design, "graph");
    return { operation, design };
  }
  if (input.state.results.design_intent !== undefined) {
    throw new ProjectDesignElaborationStateUnknownError(operation.id);
  }
  const agent = input.deriveInput.designAgent;
  if (agent === undefined) throw new Error("provider design mode has no design agent");
  operation = await ProjectDerivationStore.recordReceipt(
    input.pool,
    operation,
    "design_intent",
    {
      effect: "design",
      idempotencyKey: `${input.fingerprint}:design`,
      inputDigest: input.plan.inputDigest,
    },
    "graph",
  );
  try {
    const answer = await agent.elaborate(input.plan.agentInput);
    design = providerDesignResult(answer, input.plan);
  } catch (error) {
    throw new ProjectDesignElaborationStateUnknownError(operation.id, { cause: error });
  }
  try {
    operation = await ProjectDerivationStore.recordReceipt(input.pool, operation, "design", design, "graph");
  } catch (error) {
    const persisted =
      (await ProjectDerivationStore.findByFingerprint(input.pool, input.deriveInput.orgId, input.fingerprint).catch(
        () => null,
      )) ?? null;
    let persistedDesign: DecodedDerivation["results"]["design"] | null = null;
    try {
      persistedDesign = persisted === null ? null : (ProjectDerivationStore.decode(persisted).results.design ?? null);
    } catch {
      persistedDesign = null;
    }
    if (
      persisted === null ||
      persisted.id !== operation.id ||
      persisted.projectId !== input.projectId ||
      persistedDesign === null
    ) {
      throw new ProjectDesignElaborationStateUnknownError(operation.id, { cause: error });
    }
    operation = persisted;
    design = persistedDesign;
  }
  return { operation, design };
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
    const designPlan = buildDerivationDesignPlan(capture, fingerprint);
    const designMode = input.designAgent === undefined ? "captured" : "provider";
    const baseConfig =
      input.autonomy === "auto" || input.autonomy === "simulated"
        ? autonomousConfig(input.autonomy)
        : { version: 1, greenfield: true };
    if (input.owner === undefined) throw new Error("greenfield derive requires a repository owner");
    const managed = input.repoUrl === undefined;
    const ownershipMarker = managed ? repositoryOwnershipMarker(fingerprint) : explicitRepositoryMarker(fingerprint);
    const identity = {
      kind: "interview" as const,
      orgId: input.orgId,
      projectName: slug,
      repoUrl,
      idempotencyFingerprint: fingerprint,
    };
    let shell = await loadExactDerivationShell(pool, identity);
    let resolvedTemplate: { config: TemplateConfig; library: FragmentLibrary } | undefined;
    if (shell === undefined) {
      await preflight(input, deploy);
      resolvedTemplate = await resolveFragmentConfig(input.orgId, input, lifecycle, capture);
      shell = await createDerivationShell(pool, {
        identity,
        actor: { ...input.actor, orgId: input.orgId },
        configWriteProof: provisionedGreenfieldProjectConfigProof,
        repository: {
          mode: managed ? "managed" : "explicit",
          fullName: `${input.owner}/${slug}`,
          repoUrl,
          requestedDefaultBranch: "main",
          ownershipMarker,
        },
        sanitizedInput: {
          kind: "interview",
          slug,
          deploy,
          designMode,
          designInputDigest: designPlan.inputDigest,
        },
        project: {
          name: slug,
          repoUrl,
          defaultBranch: "main",
          config: { ...baseConfig, ...productVisionConfig(capture), lifecycle },
        },
      });
    }
    const project = shell.project;
    let operation = shell.operation;
    if (project.lifecycle === "active") {
      if (operation.status !== "succeeded") {
        throw new ProjectDerivationConflictError(project.projectId, "invalid_lifecycle");
      }
      return completed(ProjectDerivationStore.requireComplete(operation));
    }

    try {
      let state = ProjectDerivationStore.decode(operation, {
        kind: "interview",
        orgId: input.orgId,
        projectId: project.projectId,
        repoUrl,
        idempotencyFingerprint: fingerprint,
      });
      if (state.designMode !== designMode || state.designInputDigest !== designPlan.inputDigest) {
        throw new ProjectDerivationConflictError(project.projectId, "binding_mismatch");
      }
      if (state.results.repository === undefined) {
        const repository = managed
          ? await createRepository(input, slug, state.ownership.ownershipMarker)
          : { fullName: `${input.owner}/${slug}`, repoUrl, defaultBranch: project.defaultBranch };
        operation = await ProjectDerivationStore.recordReceipt(pool, operation, "repository", repository, "shell");
        state = ProjectDerivationStore.decode(operation);
      }
      const repository = state.results.repository!;

      let seed = state.template;
      if (seed === undefined) {
        resolvedTemplate ??= await resolveFragmentConfig(input.orgId, input, lifecycle, capture);
        const intent = state.results.template_intent ?? effectIntent(fingerprint, "template");
        if (state.results.template_intent === undefined) {
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
        state = ProjectDerivationStore.decode(operation);
      }

      if (state.results.deploy === undefined) {
        await preflight(input, deploy);
        const intent = state.results.deploy_intent ?? effectIntent(fingerprint, "deploy");
        if (state.results.deploy_intent === undefined) {
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
        state = ProjectDerivationStore.decode(operation);
      }

      if (state.results.graph === undefined) {
        const design = await resolveDurableDesign({
          pool,
          deriveInput: input,
          plan: designPlan,
          capture,
          fingerprint,
          projectId: project.projectId,
          operation,
          state,
        });
        operation = design.operation;
        const actor: ActorContext = { ...input.actor, orgId: input.orgId, projectId: project.projectId };
        const graphWrite = await buildEntityGraphWithReceipt(
          pool,
          input,
          capture,
          slug,
          seed,
          repository,
          project.projectId,
          actor,
          scaffoldSpecsFor(lifecycle, seed),
          operation,
          design.design,
        );
        operation = graphWrite.operation;
        state = ProjectDerivationStore.decode(operation);
      }

      if (state.results.bootstrap === undefined) {
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
      return completed(ProjectDerivationStore.requireComplete(operation));
    } catch (error) {
      await ProjectDerivationStore.recordFailure(pool, operation, error);
      throw error;
    }
  });
}

export type { CreateRepositoryInput };
