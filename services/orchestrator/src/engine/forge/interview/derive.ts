/* eslint-disable import/max-dependencies -- derive wires deploy/authority/graph seams */
// Completed vision capture → fragment-composed project repo → durable project and
// product graph. All entities use the canonical creation paths. Missing fragments
// are authored and composition is pushed directly to the project repo; there is no
// alternate scaffold/template-build path or intermediate template repository.

import type pg from "pg";
import type { ActorContext } from "../../../auth/schemas.js";
import { mutateProjectConfig } from "../../config/projectConfig.js";
import type { DesignAgent } from "../../design/designAgent.js";
import {
  RepositoryAlreadyExistsError,
  type CreatedRepository,
  type CreateRepositoryInput,
} from "../../contracts/codeHostTypes.js";
import { githubHttpsRemote } from "../../providers/github.js";
import { ProjectStore } from "../../repositories/projects.js";
import { provisionedGreenfieldProjectConfigProof } from "../../workflow/projectConfigWriteGuards.js";
import { createProject } from "../../workflow/projectSpec.js";
import {
  assertJitAvailableForToolchain,
  autonomousConfig,
  buildProductContextFromCapture,
  MissingDesignContractError,
  productVisionConfig,
  resumeDerivedProject,
} from "./deriveBehaviorSpec.js";
import { buildEntityGraph } from "./deriveEntityGraph.js";
import {
  DeployNotLinkedError,
  DeploySelectionRequiredError,
  isDeployUnavailable,
  missingDeployProvisionerError,
  resolveGreenfieldDeployDependency,
  type DeployPreflightCallback,
  type GreenfieldDeployDependency,
  type PrepareDeployCallback,
  type PersistDeploySelectionCallback,
} from "./deployDependency.js";
import { DeployIneligibleError } from "./deployIneligibleError.js";
import {
  DeriveRollbackError,
  newDeriveCompensation,
  resolveGreenfieldReattach,
  type DeleteRepositoryCallback,
  type DestroyDeployAppCallback,
  type DeriveCompensation,
} from "./deriveCompensation.js";
import { MissingLifecycleError, scaffoldSpecsFor } from "./deriveScaffoldSpecs.js";
import {
  FragmentAuthoringFailedError,
  type FragmentAuthoring,
  type FragmentLibrary,
  type FragmentSpec,
  type MaterializeTemplate,
  type ProductContext,
  type SeededTemplate,
  selectFragmentConfig,
  type TemplateConfig,
  loadFragmentLibrary,
} from "../../templates/index.js";
import { InterviewCapture, safeProjectSlug, type CaptureLifecycle } from "./types.js";

// Re-export so callers keep importing them from `derive.js` (the public derive
// surface) without reaching into the inner modules.
export { FragmentAuthoringFailedError, UnresolvableLifecycleError } from "../../templates/index.js";

export interface DeriveInput {
  orgId: string;
  capture: InterviewCapture;
  actor: ActorContext;
  // Explicit repo url override for engine-level graph tests. Production
  // greenfield onboarding must pass createRepository + owner instead.
  repoUrl?: string;
  owner?: string;
  private?: boolean;
  description?: string;
  createRepository?: (input: CreateRepositoryInput) => Promise<CreatedRepository>;
  // GREENFIELD AUTONOMY (FINDING #1 + task #79): how the derived project is governed
  // at creation. `createProject`'s schema DEFAULTS (`reviewPolicy: "human"` +
  // `mergeIntegration: "not_configured"`) are the SAFE brownfield/managed default,
  // but they leave a greenfield project unable to advance itself (PRs await a human
  // + never enter a merge engine). When the caller asks for `auto`/`simulated`, we
  // create the project ALREADY autonomous — atomically, with EVERY knob autonomous
  // operation requires (review/merge axes + `auditPosture: AUTONOMOUS_AUDIT_POSTURE`
  // + `insightThresholds.ciInsightFlakyMinShas: 1`) — so the DagWalker drives it
  // off an empty repo with NO follow-up PATCH. The DagWalker auto-claims within
  // seconds of project insert; a partially-configured project would halt the first
  // run on `audit.posture_strands_findings`. Absent or `human` ⇒ no overrides ⇒
  // the safe defaults.
  autonomy?: "auto" | "simulated" | "human";
  deploy?: GreenfieldDeployDependency;
  preflightDeploy?: DeployPreflightCallback;
  prepareDeploy?: PrepareDeployCallback;
  /** Production persists the exact pre-project account choice once the project exists. */
  persistDeploySelection?: PersistDeploySelectionCallback;
  /**
   * THE COMPOSE+MATERIALIZE SEAM (docs/roadmap/templating-system.md). The derive
   * composes a fragment-based template from the captured lifecycle and pushes the
   * composed VFS DIRECTLY into the just-created project repo via this seam (PR-G —
   * task #77; no intermediate `tanren-tmpl-<slug>` template seed repo). REQUIRED on
   * the production path; tests may inject a stub. Absent in production is a wiring bug.
   */
  materializeTemplate?: MaterializeTemplate;
  /**
   * Override the fragment library (e.g. inject a unified bundled+org-scoped library
   * per F2's `loadFragmentLibrary(orgId)`). When omitted, the bundled library is
   * used — useful for tests that don't exercise org-scoped fragments.
   */
  fragmentLibrary?: FragmentLibrary;
  /**
   * Run per-fragment authoring for the given missing fragment specs (F2). Returns
   * the augmented library that includes the freshly-authored fragments. Wired
   * by the route layer; tests inject a deterministic fake. Absent ⇒ a
   * missing-fragments decision halts loud (`FragmentAuthoringFailedError`).
   */
  runFragmentAuthoring?: FragmentAuthoring;
  // WS-D3 (native-design-subsystem.md) — the DESIGN AGENT.
  designAgent?: DesignAgent;
  /**
   * COMPENSATION (task #78 — derive atomic rollback). The route layer wires this
   * against `CodeHost.deleteRepo` so the project repo created during the derive
   * can be undone if a LATER step in the derive throws. REQUIRED whenever
   * `createRepository` is wired (i.e. the production path) — an absent
   * `deleteRepository` while a create is wired is a wiring bug (the derive
   * would create a resource it cannot roll back). Per PR-G (task #77) there is
   * no longer a separate template seed repo to roll back; this covers the project
   * repo only. Tests that don't exercise external resource creation may omit it.
   */
  deleteRepository?: DeleteRepositoryCallback;
  /**
   * GREENFIELD RE-ATTACH GUARD (apex v84). Probes whether an already-existing repo is a
   * bare `auto_init` seed (safe to re-attach) vs carrying a PRIOR run's compose history
   * (fail loud). Wired against `CodeHost.isRepoBareAutoInit`; consulted ONLY on the
   * re-attach branch. See `resolveGreenfieldReattach`. REQUIRED with `createRepository`.
   */
  probeRepoBareAutoInit?: (target: { owner: string; name: string }) => Promise<boolean>;
  /**
   * COMPENSATION (task #78 — derive atomic rollback). The route layer wires this
   * against `DeployProvisioner.destroyApp` so the provisioned deploy app can be
   * undone if a LATER step in the derive throws. REQUIRED whenever
   * `prepareDeploy` is wired (i.e. the production path) — an absent
   * `destroyDeployApp` while `prepareDeploy` is wired is a wiring bug.
   */
  destroyDeployApp?: DestroyDeployAppCallback;
}

// `autonomousConfig` (task #79) is re-exported from `./deriveBehaviorSpec.js` —
// the autonomous greenfield project-config builder that atomically applies every
// knob a fully-autonomous run requires (review/merge + governance + audit posture
// + CI-intelligence threshold). Imported via the existing deriveBehaviorSpec
// import line so derive.ts stays under the max-imports cap.

export interface DeriveResult {
  projectId: string;
  projectName: string;
  repository?: CreatedRepository;
  specIds: string[];
  personaIds: string[];
  behaviorIds: string[];
  milestoneIds: string[];
  designContractId?: string;
  /** The fragment-composed seed the project's initial content was materialized
   * from (docs/roadmap/templating-system.md). Always present on a fresh derive;
   * absent on a `resumeDerivedProject` return. Per PR-G the seed is opaque —
   * no per-stack `tanren-tmpl-<slug>` GitHub repo exists. */
  templateSeed?: SeededTemplate;
}

// Project the seed reference onto the `projects.config.templateRef` field. The
// persisted value is the OPAQUE composed-template identifier (no GitHub repo
// exists at this ref — PR-G / task #77). Observability only; the run path no
// longer reads it for a seed-repo clone.
function templateRefConfig(seed: SeededTemplate): { templateRef: string } {
  return { templateRef: seed.templateRef };
}

type RepoResolution =
  | { kind: "resume"; result: DeriveResult }
  | { kind: "created"; repository?: CreatedRepository; repoUrl: string };
async function resolveOrCreateGreenfieldRepo(
  pool: pg.Pool,
  input: DeriveInput,
  slug: string,
  compensation: DeriveCompensation,
): Promise<RepoResolution> {
  if (input.repoUrl !== undefined) return { kind: "created", repoUrl: input.repoUrl };
  if (input.owner === undefined || input.createRepository === undefined) {
    throw new Error("greenfield repository owner and creator are required");
  }
  const owner = input.owner;
  const deterministicRepoUrl = githubHttpsRemote({ owner, name: slug });
  const existingProject = await ProjectStore.findByRepoUrl(pool, deterministicRepoUrl, { kind: "operator" });
  if (existingProject !== undefined) return { kind: "resume", result: resumeDerivedProject(existingProject) };
  let created: CreatedRepository | undefined;
  try {
    created = await input.createRepository({
      owner,
      name: slug,
      private: input.private ?? true,
      autoInit: true,
      ...(input.description === undefined ? {} : { description: input.description }),
    });
  } catch (error) {
    // Non-already-exists propagates. Already-exists ⇒ the RE-ATTACH branch, GATED on an
    // emptiness probe (apex v84) — see `resolveGreenfieldReattach`.
    if (!(error instanceof RepositoryAlreadyExistsError)) throw error;
  }
  const repository =
    created ?? (await resolveGreenfieldReattach(owner, slug, deterministicRepoUrl, input.probeRepoBareAutoInit));
  // TRANSACTIONAL ROLLBACK (task #78): register the delete compensation ONLY after a
  // SUCCESSFUL create (`created !== undefined`) — NEVER on the re-attach path, so a
  // downstream failure cannot delete a repo we did not create on THIS run.
  if (created !== undefined && input.deleteRepository !== undefined) {
    compensation.register({
      kind: "github.repo",
      label: created.fullName,
      rollback: () => input.deleteRepository!({ owner, name: slug }),
    });
  }
  return { kind: "created", repository, repoUrl: repository.repoUrl };
}

// Resolve a `TemplateConfig` ready to compose. Calls `selectFragmentConfig`; on a
// missing-fragments decision spawns per-fragment authoring runs via the wired seam,
// re-loads the library (now augmented with the freshly-authored org fragments), and
// re-selects.
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
      decision.missing.map((m: FragmentSpec) => m.id),
      {
        cause: new Error("no runFragmentAuthoring seam wired; cannot author missing fragments"),
      },
    );
  }
  // fix/f2-prompt-hardening: thread SEMI-STRUCTURED PRODUCT CONTEXT into the F2
  // writer prompt. The writer uses acceptance criteria + personas + behaviors to
  // make DOMAIN-INFORMED defaults (a db fragment for a "link shortener" models
  // `links(id, url, clicks)` roughly, not a generic Item table). A capture with
  // no personas/behaviors/design-intent still authors, just without the context
  // section. `capture.designContract` may be null on a partial derive — we key
  // acceptance criteria off the design contract's principles + constraints
  // (the durable design "rulesets" that describe what the product must satisfy).
  const productContext = buildProductContextFromCapture(capture);
  const authoringResult = await input.runFragmentAuthoring({
    orgId,
    actor: input.actor,
    missing: decision.missing,
    lifecycle,
    ...(productContext === undefined ? {} : { productContext }),
  });
  if (authoringResult.failedIds.length > 0) {
    throw new FragmentAuthoringFailedError(authoringResult.failedIds, {
      failureReasons: authoringResult.failureReasons,
    });
  }
  library = authoringResult.library;
  decision = selectFragmentConfig(lifecycle, library);
  if (decision.kind === "ready") return { config: decision.config, library };
  // Authoring reported success but the retry still has missing fragments — wiring bug.
  throw new FragmentAuthoringFailedError(decision.missing.map((m: FragmentSpec) => m.id));
}

async function composeAndMaterialize(
  input: DeriveInput,
  lifecycle: CaptureLifecycle,
  config: TemplateConfig,
  library: FragmentLibrary,
  projectRepoOwner: string,
  projectRepoSlug: string,
  repoUrl: string,
  defaultBranch: string,
): Promise<SeededTemplate> {
  if (input.materializeTemplate === undefined) {
    throw new Error(
      "greenfield derive requires `materializeTemplate` (the compose + materialize seam); production wires it via " +
        "the onboarding route. An absent seam is a wiring bug, not a degrade path.",
    );
  }
  // PR-G (task #77): the composed VFS lands DIRECTLY in the just-created project
  // repo. No intermediate `tanren-tmpl-<slug>` seed repo — the project repo IS
  // the artifact. No separate compensation: a failure here is covered by the
  // project-repo compensation already registered by `resolveOrCreateGreenfieldRepo`
  // (deleting the project repo wipes the partial push set).
  return input.materializeTemplate({
    config,
    lifecycle,
    projectRepo: {
      fullName: `${projectRepoOwner}/${projectRepoSlug}`,
      repoUrl,
      defaultBranch,
    },
    library,
  });
}

export type {
  FragmentAuthoring,
  FragmentAuthoringInput,
  FragmentAuthoringResult,
} from "../../templates/fragments/fragmentAuthoringRun.js";
export type { ProductContext };
export { buildProductContextFromCapture } from "./deriveBehaviorSpec.js";

export async function deriveProductGraph(pool: pg.Pool, input: DeriveInput): Promise<DeriveResult> {
  const capture = InterviewCapture.parse(input.capture);

  if (capture.lifecycle === null) throw new MissingLifecycleError();
  if (capture.designContract === null) throw new MissingDesignContractError();

  const slug = safeProjectSlug(capture);

  // H1 #4 — EARLY-FEEDBACK JIT env-image guard (env-management.md §2.2 halt-loud).
  // A greenfield project whose captured toolchain is OFF the golden baseline AND
  // whose deployment has no `TANREN_ENV_REGISTRY` configured has no way to run:
  // the executor's env-refinement seam will fail-loud on every run. Hoisted BEFORE any
  // expensive derive work (no template resolution, no repo create, no deploy
  // provision) so the operator learns the config gap AT project-create time rather
  // than at the first run's mysterious runtime failure. A no-toolchain / baseline-
  // subset capture (apex-style node+pnpm) passes cleanly — the golden base already
  // serves it. The run-time check in `refineRunnerImageForEnv` remains the safety.
  assertJitAvailableForToolchain(capture.lifecycle.toolchain);

  // DEPLOY-REQUIRED guard hoisted BEFORE template resolution. A project missing its
  // deploy config fails FAST — we never spend authoring cost on a project that
  // cannot deploy anyway.
  const deploy = resolveGreenfieldDeployDependency(input.deploy, { required: true });
  if (deploy !== undefined && input.preflightDeploy !== undefined) {
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

  // TASK #78 — TRANSACTIONAL ROLLBACK. Build a compensation stack covering every
  // external resource derive creates (the project repo, the deploy app). If ANY
  // step from here to a durable project row throws, the stack walks in LIFO order
  // + every resource is deleted before the original error re-raises — so the
  // operator's next retry never collides on an orphan. PR-G (task #77) reduced
  // the scope by one: the per-stack `tanren-tmpl-<slug>` template seed repo is
  // gone (the composed VFS pushes directly to the project repo). The compensation
  // is INTERNAL to this derive call (a recursive derive would build its own
  // atomic unit) and does NOT cover entity-graph creates after `createProject`
  // succeeds: the project row is then the durable anchor + the existing
  // `resumeDerivedProject` returns it idempotently.
  const compensation = newDeriveCompensation();
  try {
    const { config, library } = await resolveFragmentConfig(input.orgId, input, capture.lifecycle, capture);

    const autonomousOptIn = input.autonomy === "auto" || input.autonomy === "simulated";
    const baseConfig = autonomousOptIn
      ? autonomousConfig(input.autonomy as "auto" | "simulated")
      : { version: 1, greenfield: true };
    if (deploy === undefined || input.prepareDeploy === undefined) throw missingDeployProvisionerError();

    // PR-G (task #77): create the project repo FIRST so the composed VFS can be
    // pushed DIRECTLY into it (no intermediate `tanren-tmpl-<slug>` seed repo).
    const repoResolution = await resolveOrCreateGreenfieldRepo(pool, input, slug, compensation);
    if (repoResolution.kind === "resume") return repoResolution.result;
    const { repository, repoUrl } = repoResolution;

    // PR-G — compose+push the VFS directly to the just-created project repo as
    // its initial content. No separate compensation: a failure here is covered
    // by the project-repo compensation registered above (deleting the project
    // repo wipes the partial push set).
    if (input.owner === undefined) {
      throw new Error("greenfield derive requires `owner` to materialize the composed template into the project repo");
    }
    const seed = await composeAndMaterialize(
      input,
      capture.lifecycle,
      config,
      library,
      input.owner,
      slug,
      repoUrl,
      repository?.defaultBranch ?? "main",
    );

    const scaffoldSpecs = scaffoldSpecsFor(capture.lifecycle, seed);

    // Project shell first — authorizeOperation requires a real project selection.
    // Deploy config is merged after provision; selection must land before provider I/O.
    const project = await createProject(
      pool,
      {
        name: slug,
        repoUrl,
        config: {
          ...baseConfig,
          ...productVisionConfig(capture),
          lifecycle: capture.lifecycle,
          ...templateRefConfig(seed),
        },
        ...(repository === undefined ? {} : { defaultBranch: repository.defaultBranch }),
      },
      { ...input.actor, orgId: input.orgId },
      { configWriteProof: provisionedGreenfieldProjectConfigProof },
    );
    const projectId = project.projectId;

    // prepareDeploy persists exact selection then authorizeOperation + provision.
    const preparedDeploy = await input.prepareDeploy({
      orgId: input.orgId,
      projectId,
      capability: "deploy",
      providerKind: deploy.providerKind,
      mode: deploy.mode,
      projectKey: slug,
      projectName: slug,
      ...(deploy.connectionId === undefined ? {} : { connectionId: deploy.connectionId }),
      ...(deploy.grantId === undefined ? {} : { grantId: deploy.grantId }),
      ...(deploy.chosenResourceId === undefined ? {} : { chosenResourceId: deploy.chosenResourceId }),
      ...(deploy.stack === undefined ? {} : { stack: deploy.stack }),
      name: deploy.name ?? slug,
    });
    if (isDeployUnavailable(preparedDeploy)) {
      if (preparedDeploy.status === "not_linked") throw new DeployNotLinkedError(preparedDeploy);
      if (preparedDeploy.status === "selection_required") throw new DeploySelectionRequiredError(preparedDeploy);
      throw new DeployIneligibleError(preparedDeploy);
    }
    // TRANSACTIONAL ROLLBACK (task #78): register the deploy app compensation
    // IMMEDIATELY after a successful provision.
    const appId = preparedDeploy.projectConfig["deployAppId"];
    const appName = preparedDeploy.projectConfig["deployAppName"];
    if (
      input.destroyDeployApp !== undefined &&
      typeof appId === "string" &&
      appId !== "" &&
      typeof appName === "string" &&
      appName !== ""
    ) {
      const destroyDeployApp = input.destroyDeployApp;
      const providerKind = deploy.providerKind;
      compensation.register({
        kind: "deploy.app",
        label: `${providerKind}:${appName}`,
        rollback: () =>
          destroyDeployApp({
            providerKind,
            appId,
            appName,
            connectionId: preparedDeploy.outcome.authority.connectionId,
            grantId: preparedDeploy.outcome.authority.grantId,
            projectId,
          }),
      });
    }
    // Merge deploy target into project config after authorized provision.
    // Run through migrateProjectConfig so zod defaults (reviewPolicy, mergeIntegration,
    // …) remain on the stored blob — same as createProject's assert path.
    const { migrateProjectConfig } = await import("../../config/index.js");
    await mutateProjectConfig(pool, projectId, { kind: "operator", id: input.actor.userId }, (raw) =>
      migrateProjectConfig({
        ...migrateProjectConfig(raw),
        ...baseConfig,
        ...productVisionConfig(capture),
        lifecycle: capture.lifecycle,
        ...templateRefConfig(seed),
        ...preparedDeploy.projectConfig,
      }),
    );
    const actor: ActorContext = { ...input.actor, orgId: input.orgId, projectId };
    return await buildEntityGraph(pool, input, capture, slug, seed, repository, projectId, actor, scaffoldSpecs);
  } catch (error) {
    // TRANSACTIONAL ROLLBACK (task #78): a failure ANYWHERE in the external-resource
    // window walks every registered compensation in LIFO order. If a compensation
    // ALSO fails, the rollback gap rides on a `DeriveRollbackError` so the operator
    // sees both the original failure + which resources may be orphaned. The original
    // error is preserved verbatim when every compensation succeeded.
    if (compensation.pendingCount() === 0) throw error;
    const failures = await compensation.rollback();
    if (failures.length === 0) throw error;
    throw new DeriveRollbackError(error, failures);
  }
}
