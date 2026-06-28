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
//   3. `composeTemplate(config, library)` assembles the VFS, then materialize it
//      into a fresh seed repo. The seed reference rides on `projects.config` so the
//      run path clones it into the project workspace.
//
// There is NO dual scaffoldOrigin, NO `template_build` mode, NO agent template-build
// DAG, NO template registry to query. Every project derive is the same path.

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
  autonomousConfig,
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
   * composes a fragment-based template from the captured lifecycle and materializes
   * it into a fresh seed repo via this seam. REQUIRED on the production path; tests
   * may inject a stub. Absent in production is a wiring bug.
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
   * against `CodeHost.deleteRepo` so each repo created during the derive
   * (the template seed repo + the project repo) can be undone if a LATER step in
   * the derive throws. REQUIRED whenever `createRepository` and/or
   * `materializeTemplate` are wired (i.e. the production path) — an absent
   * `deleteRepository` while creates are wired is a wiring bug (the derive
   * would create resources it cannot roll back). Tests that don't exercise
   * external resource creation may omit it.
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
  /** The fragment-composed seed the project was materialized from
   * (docs/roadmap/templating-system.md). Always present on a fresh derive. */
  templateSeed?: SeededTemplate;
}

// Project the seed reference onto the `projects.config.templateRef` shape the run
// path reads at workspace-prep.
function templateRefConfig(seed: SeededTemplate): {
  templateRef: { templateRef: string; repoRef: string; validatedAt: string; validatedSha: string };
} {
  return {
    templateRef: {
      templateRef: seed.templateRef,
      repoRef: seed.repoRef,
      validatedAt: seed.validatedAt,
      validatedSha: seed.validatedSha,
    },
  };
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
): Promise<{ config: TemplateConfig; library: FragmentLibrary }> {
  let library = input.fragmentLibrary ?? loadFragmentLibrary();
  let decision = selectFragmentConfig(lifecycle, library);
  if (decision.kind === "ready") return { config: decision.config, library };

  if (input.runFragmentAuthoring === undefined) {
    throw new FragmentAuthoringFailedError(
      decision.missing.map((m: FragmentSpec) => m.id),
      new Error("no runFragmentAuthoring seam wired; cannot author missing fragments"),
    );
  }
  const authoringResult = await input.runFragmentAuthoring({
    orgId,
    actor: input.actor,
    missing: decision.missing,
    lifecycle,
  });
  if (authoringResult.failedIds.length > 0) {
    throw new FragmentAuthoringFailedError(authoringResult.failedIds);
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
  compensation: DeriveCompensation,
): Promise<SeededTemplate> {
  if (input.materializeTemplate === undefined) {
    throw new Error(
      "greenfield derive requires `materializeTemplate` (the compose + materialize seam); production wires it via " +
        "the onboarding route. An absent seam is a wiring bug, not a degrade path.",
    );
  }
  if (input.owner === undefined) {
    throw new Error("greenfield derive requires `owner` to materialize the seed repo");
  }
  const seed = await input.materializeTemplate({ config, lifecycle, owner: input.owner, library });
  // TRANSACTIONAL ROLLBACK (task #78): register a compensation to delete the
  // freshly-materialized seed repo if a later step in this derive throws. The
  // `repoRef` is the GitHub `<owner>/<name>` slug `materializeTemplate` minted.
  // The materializer ALWAYS creates a fresh repo (no resume/re-attach path), so
  // the compensation always fires on a partial-failure rollback. Absent
  // `deleteRepository` callback ⇒ skip registration (test-only path; production
  // wires it via the onboarding route).
  if (input.deleteRepository !== undefined) {
    const [seedOwner, seedName] = seed.repoRef.split("/", 2);
    if (seedOwner !== undefined && seedName !== undefined && seedOwner !== "" && seedName !== "") {
      const deleteRepository = input.deleteRepository;
      compensation.register({
        kind: "github.repo",
        label: seed.repoRef,
        rollback: () => deleteRepository({ owner: seedOwner, name: seedName }),
      });
    }
  }
  return seed;
}

export type {
  FragmentAuthoring,
  FragmentAuthoringInput,
  FragmentAuthoringResult,
} from "../../templates/fragments/fragmentAuthoringRun.js";

export async function deriveProductGraph(pool: pg.Pool, input: DeriveInput): Promise<DeriveResult> {
  const capture = InterviewCapture.parse(input.capture);

  if (capture.lifecycle === null) throw new MissingLifecycleError();
  if (capture.designContract === null) throw new MissingDesignContractError();

  const slug = safeProjectSlug(capture);

  // DEPLOY-REQUIRED guard hoisted BEFORE template resolution. A project missing its
  // deploy config fails FAST — we never spend authoring cost on a project that
  // cannot deploy anyway.
  const deploy = resolveGreenfieldDeployDependency(input.deploy, { required: true });
  if (deploy !== undefined && input.preflightDeploy !== undefined) {
    const notLinked = await input.preflightDeploy({ orgId: input.orgId, providerKind: deploy.providerKind });
    if (notLinked !== undefined) throw new DeployNotLinkedError(notLinked);
  }

  // TASK #78 — TRANSACTIONAL ROLLBACK. Build a compensation stack covering every
  // external resource derive creates (the materialized seed repo, the project
  // repo, the deploy app). If ANY step from here to a durable project row throws,
  // the stack walks in LIFO order + every resource is deleted before the original
  // error re-raises — so the operator's next retry never collides on an orphan.
  // The compensation is INTERNAL to this derive call (a recursive derive would
  // build its own atomic unit). The compensation does NOT cover entity-graph
  // creates after `createProject` succeeds: the project row is then the durable
  // anchor + the existing `resumeDerivedProject` returns it idempotently.
  const compensation = newDeriveCompensation();
  try {
    const { config, library } = await resolveFragmentConfig(input.orgId, input, capture.lifecycle);

    const seed = await composeAndMaterialize(input, capture.lifecycle, config, library, compensation);

    const scaffoldSpecs = scaffoldSpecsFor(capture.lifecycle, seed);

    const autonomousOptIn = input.autonomy === "auto" || input.autonomy === "simulated";
    const baseConfig = autonomousOptIn
      ? autonomousConfig(input.autonomy as "auto" | "simulated")
      : { version: 1, greenfield: true };
    if (deploy === undefined || input.prepareDeploy === undefined) throw missingDeployProvisionerError();

    const repoResolution = await resolveOrCreateGreenfieldRepo(pool, input, slug, compensation);
    if (repoResolution.kind === "resume") return repoResolution.result;
    const { repository, repoUrl } = repoResolution;

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
    // IMMEDIATELY after a successful provision. The `deployAppId` lives on the
    // project-config keyset the prepareDeploy callback populated; the provider
    // kind is the same `deploy` resolved above. Absent `destroyDeployApp` ⇒
    // skip registration (test-only path; production wires it via the route).
    const appId = preparedDeploy.projectConfig["deployAppId"];
    if (input.destroyDeployApp !== undefined && typeof appId === "string" && appId !== "") {
      const destroyDeployApp = input.destroyDeployApp;
      const providerKind = deploy.providerKind;
      compensation.register({
        kind: "deploy.app",
        label: `${providerKind}:${appId}`,
        rollback: () => destroyDeployApp({ providerKind, appId }),
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
