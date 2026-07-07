// greenfield onboarding: derive the product graph from a completed
// vision-interview capture.
//
// This is the heart of "interview → DAG". On completion the accumulated
// capture is turned into a live project's product graph, created through the
// SAME foundations rather than a forked write path:
//
//   project    → createProject              (workflow)
//   personas   → PersonaStore.create
//   behaviors  → BehaviorStore.create + linkToSpec
//   milestones → MilestoneStore.create + setSpecMilestone
//   specs      → createSpec                 (incl. dependency wiring)
//
// The derived DAG is exactly what `getProjectDag` then reads back:
//   - A foundation milestone (M1 · scaffold) of scaffold specs every later
//     spec depends on (the critical path root).
//   - One milestone per inferred INTERFACE (the hi-fi "handheld" / "ops
//     dashboard" columns), each carrying a spec per BEHAVIOR tied to a persona
//     whose surface matches that interface, plus a per-interface schema spec.
//   - Each behavior spec `dependsOn` the scaffold + its interface's schema spec,
//     so the dependency math the DAG renders is real, not cosmetic.
//
// THE ONE-PATH TEMPLATING DOCTRINE (docs/roadmap/templating-system.md). Every
// project DAG seeds from a FRAGMENT-COMPOSED template. The flow:
//
//   1. `selectFragmentConfig(lifecycle, library)` resolves a `TemplateConfig` +
//      reports which fragment ids are missing from the library (unified bundled +
//      org-scoped per F2).
//   2. If missing-fragments: spawn per-fragment authoring runs (F2 — one run per
//      missing fragment, each producing a validated `Fragment` persisted into the
//      org's `fragments` table). Wait, retry step 1. If authoring fails, halt loud
//      with `FragmentAuthoringFailedError` (no silent skip).
//   3. CREATE the project repo (`createRepository` — `CodeHost.createRepo`).
//   4. `composeTemplate(config, library)` assembles the VFS, then `materializeTemplate`
//      PUSHES every composed file directly to the just-created project repo's
//      default branch — the project repo IS the artifact (PR-G — task #77).
//      An opaque `templateRef` (`tanren://composed/<slug>@<contentHash>`) rides on
//      `projects.config` for observability; there is NO `tanren-tmpl-<slug>` seed
//      repo to clone at run time.
//
// There is NO dual scaffoldOrigin, NO `template_build` mode, NO agent template-build
// DAG, NO template registry to query, NO intermediate per-stack template seed repo.
// Every project derive is the same path.

import type pg from "pg";
import type { ActorContext } from "../../../auth/schemas.js";
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
  isDeployNotLinked,
  missingDeployProvisionerError,
  resolveGreenfieldDeployDependency,
  type DeployPreflightCallback,
  type GreenfieldDeployDependency,
  type PrepareDeployCallback,
} from "./deployDependency.js";
import {
  DeriveRollbackError,
  newDeriveCompensation,
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
  let repository: CreatedRepository;
  let weCreatedIt = false;
  try {
    repository = await input.createRepository({
      owner,
      name: slug,
      private: input.private ?? true,
      autoInit: true,
      ...(input.description === undefined ? {} : { description: input.description }),
    });
    weCreatedIt = true;
  } catch (error) {
    if (error instanceof RepositoryAlreadyExistsError) {
      // RE-ATTACH (existing idempotency, audit §3.10): the repo exists from a prior
      // stranded attempt + no project is bound. We do NOT register a compensation —
      // a downstream failure must not delete a repo we did not create on THIS run
      // (Tanren would silently delete a repo the operator just re-ran into).
      repository = { fullName: `${owner}/${slug}`, repoUrl: deterministicRepoUrl, defaultBranch: "main" };
    } else {
      throw error;
    }
  }
  // TRANSACTIONAL ROLLBACK (task #78): register the compensation IMMEDIATELY after a
  // SUCCESSFUL create (never on the re-attach path). The compensation idempotently
  // deletes the repo if a later step in this derive throws.
  if (weCreatedIt && input.deleteRepository !== undefined) {
    const repoForCompensation = repository;
    compensation.register({
      kind: "github.repo",
      label: repoForCompensation.fullName,
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
    const notLinked = await input.preflightDeploy({ orgId: input.orgId, providerKind: deploy.providerKind });
    if (notLinked !== undefined) throw new DeployNotLinkedError(notLinked);
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

    const preparedDeploy = await input.prepareDeploy({
      orgId: input.orgId,
      capability: "deploy",
      providerKind: deploy.providerKind,
      mode: deploy.mode,
      projectKey: slug,
      projectName: slug,
      ...(deploy.chosenResourceId === undefined ? {} : { chosenResourceId: deploy.chosenResourceId }),
      ...(deploy.stack === undefined ? {} : { stack: deploy.stack }),
      name: deploy.name ?? slug,
    });
    if (isDeployNotLinked(preparedDeploy)) {
      throw new DeployNotLinkedError(preparedDeploy);
    }
    // TRANSACTIONAL ROLLBACK (task #78): register the deploy app compensation
    // IMMEDIATELY after a successful provision. The `deployAppId` + `deployAppName`
    // BOTH live on the project-config keyset the prepareDeploy callback populated
    // (see `DeployProvisioner.artifactFor`); the provider kind is the same `deploy`
    // resolved above. Absent `destroyDeployApp` ⇒ skip registration (test-only path;
    // production wires it via the route).
    //
    // AUDIT FINDING D4: BOTH `appId` AND `appName` are required by the compensation
    // — Fly's destroy keys on `app.name`, Vercel's on `app.appId`. Fly's `listApps`
    // returns `appId: app.id ?? app.name` which is typically the distinct internal
    // id (e.g. `fly_app_1`), so a synthesis that filled `name` from `appId` would
    // route the DELETE at the wrong path and Fly would 404 — the per-provider arm
    // would swallow that as "already-gone success" (the silent-compensation pattern
    // audit #8 was meant to kill, reintroduced by PR #711). Threading the real
    // `deployAppName` closes the regression.
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
        rollback: () => destroyDeployApp({ providerKind, appId, appName }),
      });
    }
    const persistedConfig = {
      ...baseConfig,
      ...productVisionConfig(capture),
      lifecycle: capture.lifecycle,
      ...templateRefConfig(seed),
      ...preparedDeploy.projectConfig,
    };
    const project = await createProject(
      pool,
      {
        name: slug,
        repoUrl,
        config: persistedConfig,
        ...(repository === undefined ? {} : { defaultBranch: repository.defaultBranch }),
      },
      { ...input.actor, orgId: input.orgId },
      { configWriteProof: provisionedGreenfieldProjectConfigProof },
    );
    const projectId = project.projectId;
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
