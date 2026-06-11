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
// No migration: every row lands in an existing table. The capture itself is
// transient (carried on the request), so there is no interview-session table.

import type pg from "pg";
import type { ActorContext } from "../../../auth/schemas.js";
import type { CreatedRepository, CreateRepositoryInput } from "../../contracts/codeHostTypes.js";
import { RepositoryAlreadyExistsError } from "../../contracts/codeHostTypes.js";
import { githubHttpsRemote } from "../../providers/github.js";
import { ProjectStore } from "../../repositories/projects.js";
import { MilestoneCreateInput, MilestoneStore } from "../../entities/milestones.js";
import { PersonaCreateInput, PersonaStore } from "../../entities/personas.js";
import { provisionedGreenfieldProjectConfigProof } from "../../workflow/projectConfigWriteGuards.js";
import { createProject, createSpec } from "../../workflow/projectSpec.js";
import { deriveBehaviorSpec, resumeDerivedProject } from "./deriveBehaviorSpec.js";
import {
  DeployNotLinkedError,
  isDeployNotLinked,
  missingDeployProvisionerError,
  resolveGreenfieldDeployDependency,
  type DeployPreflightCallback,
  type GreenfieldDeployDependency,
  type PrepareDeployCallback,
} from "./deployDependency.js";
import { MissingLifecycleError, scaffoldSpecsFor } from "./deriveScaffoldSpecs.js";
import { assertSeeded, selectSeedTemplate, type ScaffoldOrigin } from "./interviewTemplateGate.js";
import type { SelectedTemplate, TemplateRegistryQuery, TemplateSelectionDecision } from "./templateSelection.js";
import {
  InterviewCapture,
  safeProjectSlug,
  type CaptureBehavior,
  type CaptureInterface,
  type CaptureLifecycle,
} from "./types.js";

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
  // GREENFIELD AUTONOMY (FINDING #1): how the derived project is governed at
  // creation. `createProject`'s schema DEFAULTS (`reviewPolicy: "human"` +
  // `mergeIntegration: "not_configured"`) are the SAFE brownfield/managed default,
  // but they leave a greenfield project unable to advance itself (PRs await a human
  // + never enter a merge engine). When the caller asks for `auto`/`simulated`, we
  // create the project ALREADY autonomous so the DagWalker drives it off an empty
  // repo with no follow-up PATCH. Absent or `human` ⇒ no config ⇒ the safe defaults.
  autonomy?: "auto" | "simulated" | "human";
  deploy?: GreenfieldDeployDependency;
  preflightDeploy?: DeployPreflightCallback;
  prepareDeploy?: PrepareDeployCallback;
  // The SCAFFOLD ORIGIN — the DOCTRINE discriminator (templating-system.md §3). It
  // is the single invariant that enforces "every PROJECT DAG executes against a
  // validated template, never a from-scratch scaffold":
  //   - "project" (DEFAULT — greenfield onboarding + greenfield create): template
  //     selection ALWAYS runs (`templateRegistryQuery` is REQUIRED). A match SEEDS;
  //     a no-match CREATES a validated template JUST-IN-TIME and seeds from it; an
  //     un-creatable no-match HALTS LOUD (`TemplateRequiredError`). The from-scratch
  //     authoring is UNREACHABLE on this path (the invariant guard asserts it).
  //   - "template_build": this derive IS the BUILD step of template-creation — it
  //     authors the TEMPLATE itself FROM SCRATCH (the only place the from-scratch
  //     authoring lives). No selection runs; the from-scratch authoring is the job.
  //     The result is VALIDATED (negative controls) before any project seeds from it.
  scaffoldOrigin?: "project" | "template_build";
  // TEMPLATING WAVE 3 (templating-system.md §3): the ORG-SCOPED template-registry
  // query, injected so the derive SELECTS a validated template to SEED from BEFORE
  // authoring the scaffold spec. Org-scoped in prod (RLS bounds candidates to the
  // org's own + the cross-org `official` catalogue); a fixture in tests. REQUIRED on
  // the "project" origin (a project ALWAYS runs selection); MUST be absent on
  // "template_build" (the template authors itself from scratch — there is nothing to
  // select). The `scaffoldOrigin` invariant guard enforces this pairing.
  templateRegistryQuery?: TemplateRegistryQuery;
  // Optional seed channel preference (defaults to "lts" — conservative greenfield).
  templateChannelPreference?: "lts" | "nightly";
  // Injectable clock for deterministic selection-freshness tests.
  selectionNow?: number;
  // The no-match → JUST-IN-TIME CREATION seam (templating-system.md §3). On a no-match,
  // selection runs this to CREATE a template (research → author → build → validate →
  // publish) + SEEDS from the published result — the project scaffold GATES on it. Wired
  // by `buildCreateForNoMatch` (so the derive/selection layers keep NO creation
  // dependency). Absent on a no-match ⇒ a LOUD `TemplateRequiredError` halt — never a
  // project-direct from-scratch scaffold (the deleted bypass).
  createTemplateForNoMatch?: (lifecycle: CaptureLifecycle) => Promise<SelectedTemplate | undefined>;
}

// Re-exported from the gate module so callers can keep importing it from `derive.js`
// (the public derive surface) without reaching into the gate internals.
export { TemplateRegistryQueryRequiredError } from "./interviewTemplateGate.js";

// FINDING #1: the autonomous greenfield config. When the operator opts into
// `auto`/`simulated`, the project is created with the matching review policy + the
// `native_queue` merge engine (so derived PRs enter a merge engine instead of
// stalling on `not_configured`), AND the `lenient` governance posture. Lenient
// makes the in-loop gate's `lint`/`typecheck` ADVISORY (warn, non-blocking) while
// `build`/`test` stay blocking — the functional-but-weak apex doctrine
// docs/operator-guide/apex.md: a functional-but-weak first pass lands imperfect
// code and improves it via the issue loop instead of stalling the gate on
// first-pass lint/type issues. This config is the ONLY deviation from the schema
// defaults — and only on explicit opt-in. A `human`/absent autonomy keeps the safe
// strict default. `createProject` threads this through `migrateProjectConfig` (no
// new plumbing).
function autonomousConfig(autonomy: "auto" | "simulated"): Record<string, unknown> {
  return {
    version: 1,
    reviewPolicy: autonomy,
    mergeIntegration: "native_queue",
    governancePosture: "lenient",
    // The interview path always builds off an EMPTY repo — Tanren authors the
    // toolchain live — so it is greenfield regardless of the autonomy tier (this
    // drives the non-frozen in-loop deps-ensure; see ProjectConfigV1.greenfield).
    greenfield: true,
  };
}

// The product-vision slice of the project config (the identity `pitch` + the
// `designDna`), persisted onto `projects.config` so the conflict resolver can
// frame a resolution against the product vision. Only the captured fields are
// written — an interview that surfaced neither yields `{}` (no `productVision`
// key at all = a real empty state, parsed away by the optional schema field).
function productVisionConfig(capture: InterviewCapture): { productVision?: Record<string, string> } {
  const vision: Record<string, string> = {};
  const pitch = capture.identity?.pitch.trim();
  if (pitch !== undefined && pitch !== "") vision["pitch"] = pitch;
  const designDna = capture.designDna.trim();
  if (designDna !== "") vision["designDna"] = designDna;
  return Object.keys(vision).length > 0 ? { productVision: vision } : {};
}

export interface DeriveResult {
  projectId: string;
  projectName: string;
  repository?: CreatedRepository;
  specIds: string[];
  personaIds: string[];
  behaviorIds: string[];
  milestoneIds: string[];
  // TEMPLATING WAVE 3 — the selection OUTCOME (templating-system.md §3), surfaced so
  // the decision is observable on the derive result (strong/partial = seeded;
  // none/blocked = from-scratch). Absent when selection was skipped (no registry
  // query injected — the current live default).
  templateSelection?: TemplateSelectionDecision;
}

// The seed reference persisted onto the project config when a template was selected
// (strong/partial). `null` when none/blocked/skipped — the from-scratch path.
function templateRefConfig(decision: TemplateSelectionDecision | undefined): {
  templateRef?: Record<string, string>;
} {
  if (decision?.selected === undefined) return {};
  if (decision.kind !== "strong" && decision.kind !== "partial") return {};
  const sel = decision.selected;
  return {
    templateRef: {
      templateRef: sel.templateRef,
      repoRef: sel.repoRef,
      validatedAt: sel.validationProof.validatedAt,
      validatedSha: sel.validationProof.validatedSha,
    },
  };
}

// A behavior belongs to an interface when its persona's surface matches the
// interface name (best-effort, lowercase substring). Unmatched behaviors fall
// to the first interface so nothing is dropped from the DAG.
function interfaceForBehavior(
  behavior: CaptureBehavior,
  capture: InterviewCapture,
  interfaces: CaptureInterface[],
): CaptureInterface | undefined {
  const persona = capture.personas.find((p) => p.name.toLowerCase() === behavior.persona.toLowerCase());
  const surface = (persona?.surface ?? "").toLowerCase();
  if (surface !== "") {
    const match = interfaces.find(
      (i) => i.name.toLowerCase().includes(surface) || surface.includes(i.name.toLowerCase().split(" ")[0] ?? ""),
    );
    if (match !== undefined) return match;
  }
  return interfaces[0];
}

// The repo-resolution step (extracted for file-size discipline). REPO-FIRST + IDEMPOTENT
// (audit §3.10): an explicit `repoUrl` skips it; else the deterministic URL is the
// idempotency key (a bound project ⇒ resume; a `RepositoryAlreadyExistsError` re-attaches).
type RepoResolution =
  | { kind: "resume"; result: DeriveResult }
  | { kind: "created"; repository?: CreatedRepository; repoUrl: string };
async function resolveOrCreateGreenfieldRepo(pool: pg.Pool, input: DeriveInput, slug: string): Promise<RepoResolution> {
  if (input.repoUrl !== undefined) return { kind: "created", repoUrl: input.repoUrl };
  if (input.owner === undefined || input.createRepository === undefined) {
    throw new Error("greenfield repository owner and creator are required");
  }
  const owner = input.owner;
  const deterministicRepoUrl = githubHttpsRemote({ owner, name: slug });
  const existingProject = await ProjectStore.findByRepoUrl(pool, deterministicRepoUrl, { kind: "operator" });
  if (existingProject !== undefined) return { kind: "resume", result: resumeDerivedProject(existingProject) };
  let repository: CreatedRepository;
  try {
    repository = await input.createRepository({
      owner,
      name: slug,
      private: input.private ?? true,
      autoInit: true,
      ...(input.description === undefined ? {} : { description: input.description }),
    });
  } catch (error) {
    // RE-ATTACH on a repo created by a prior stranded attempt (no project bound — the
    // probe above proved that): continue with the deterministic URL + default branch.
    if (error instanceof RepositoryAlreadyExistsError) {
      repository = { fullName: `${owner}/${slug}`, repoUrl: deterministicRepoUrl, defaultBranch: "main" };
    } else {
      throw error;
    }
  }
  return { kind: "created", repository, repoUrl: repository.repoUrl };
}

export async function deriveProductGraph(pool: pg.Pool, input: DeriveInput): Promise<DeriveResult> {
  // Validate the capture at the derive boundary (defence in depth; the round
  // engine also validates) so a malformed capture never reaches the create path.
  const capture = InterviewCapture.parse(input.capture);

  // The architecture step's lifecycle is LOAD-BEARING + REQUIRED — it is persisted
  // onto the project config and the run MATERIALIZES the justfile + ci.yml from it.
  // FAIL LOUD if it is missing (the stack-flexible contract's core invariant: never
  // silently default to Node). Checked FIRST (before slug resolution, which may use
  // the lifecycle's stack as a fallback signal) so a no-lifecycle capture surfaces the
  // lifecycle error, not a slug error.
  if (capture.lifecycle === null) throw new MissingLifecycleError();

  // Resolve a HOSTNAME-SAFE slug (the repo + deploy-app name). A captured identity
  // slug is used verbatim; an absent identity falls back to a REAL normalized signal
  // (pitch/design-DNA/stack), never a silent shared "greenfield-project" constant —
  // `safeProjectSlug` throws `MissingProjectSlugError` when nothing safe survives.
  const slug = safeProjectSlug(capture);

  // THE DOCTRINE INVARIANT (templating-system.md §3): every PROJECT DAG executes
  // against a VALIDATED TEMPLATE — never a from-scratch scaffold. `scaffoldOrigin` is
  // the single enforcement point (the gate machinery lives in interviewTemplateGate.ts).
  const scaffoldOrigin: ScaffoldOrigin = input.scaffoldOrigin ?? "project";

  // DEPLOY-REQUIRED guard, hoisted BEFORE template selection. The deploy dependency is
  // mandatory (the greenfield/apex contract); resolving it is a CHEAP presence check
  // that throws `DeployProviderMissingError` when absent. Doing it before selection
  // means a project missing its deploy config fails FAST — we never trigger an
  // expensive just-in-time template build for a project that cannot deploy anyway. The
  // preflight (a not-linked probe) likewise gates before creation.
  const deploy = resolveGreenfieldDeployDependency(input.deploy, { required: true });
  if (deploy !== undefined && input.preflightDeploy !== undefined) {
    const notLinked = await input.preflightDeploy({ orgId: input.orgId, providerKind: deploy.providerKind });
    if (notLinked !== undefined) throw new DeployNotLinkedError(notLinked);
  }

  // SELECT a validated template to SEED from, BEFORE deriving the scaffold spec. On the
  // "project" origin selection ALWAYS runs: a match SEEDS; a no-match CREATES a
  // validated template just-in-time + seeds from it; an un-creatable no-match THROWS
  // `TemplateRequiredError` (a LOUD fail-closed halt — no project-direct from-scratch).
  // On "template_build" selection is skipped — that derive IS the from-scratch authoring.
  const templateSelection = await selectSeedTemplate({
    scaffoldOrigin,
    lifecycle: capture.lifecycle,
    ...(input.templateRegistryQuery === undefined ? {} : { templateRegistryQuery: input.templateRegistryQuery }),
    ...(input.templateChannelPreference === undefined
      ? {}
      : { templateChannelPreference: input.templateChannelPreference }),
    ...(input.selectionNow === undefined ? {} : { selectionNow: input.selectionNow }),
    ...(input.createTemplateForNoMatch === undefined
      ? {}
      : { createTemplateForNoMatch: input.createTemplateForNoMatch }),
  });

  // The scaffold spec SHRINKS to template-instantiation on a strong/partial match. The
  // from-scratch authoring (`scaffoldSpecsFor` with no decision) is reachable ONLY on
  // the "template_build" origin — a "project" origin ALWAYS has a seed by here (else
  // selection threw), enforced by the invariant guard.
  const scaffoldSpecs = scaffoldSpecsFor(capture.lifecycle, templateSelection);
  assertSeeded(scaffoldOrigin, templateSelection);

  // FINDING #1: opt-in autonomous config. `auto`/`simulated` ⇒ create the project
  // already autonomous (`native_queue` + matching review policy) so the DagWalker
  // can advance it off an empty repo with no follow-up PATCH. Absent/`human` ⇒ the
  // safe strict defaults — but STILL greenfield (the interview always builds off an
  // empty repo), so even the human tier persists `{ version: 1, greenfield: true }`
  // for the non-frozen in-loop deps-ensure. An unversioned `{}` blob is rejected
  // (no migration shim); `createProject` threads `config` through
  // `migrateProjectConfig` — no new plumbing.
  const autonomousOptIn = input.autonomy === "auto" || input.autonomy === "simulated";
  const baseConfig = autonomousOptIn
    ? autonomousConfig(input.autonomy as "auto" | "simulated")
    : { version: 1, greenfield: true };
  if (deploy === undefined || input.prepareDeploy === undefined) throw missingDeployProvisionerError();

  // IDEMPOTENT + ATOMIC ORDER (audit §3.10): repo-first, then deploy (extracted to
  // `resolveOrCreateGreenfieldRepo`). A pre-existing project bound to the deterministic
  // URL is a completed prior derive → resume it (no repo-create, no deploy-provision).
  const repoResolution = await resolveOrCreateGreenfieldRepo(pool, input, slug);
  if (repoResolution.kind === "resume") return repoResolution.result;
  const { repository, repoUrl } = repoResolution;

  // Provision deploy ONLY after the repo exists (the reorder above), so it is the LAST
  // external resource before the durable project row. PERSIST THE PRODUCT VISION too
  // (no migration) — the captured IDENTITY (`pitch`) + DESIGN-DNA onto `projects.config`.
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
  const config = {
    ...baseConfig,
    ...productVisionConfig(capture),
    // DETERMINISTIC CONTRACT FILES (v27 fix): PERSIST the captured lifecycle onto the
    // project config so the RUN path materializes the contract files (`.tanren/ci.yml`
    // + `justfile`) from it — they are NEVER LLM-authored. `CaptureLifecycle` maps 1:1
    // to `ProjectLifecycle` (same fields). Non-null here (validated above).
    lifecycle: capture.lifecycle,
    // TEMPLATING WAVE 3 — persist the seed reference when a template was selected
    // (strong/partial); absent on the from-scratch path. Recorded so the decision is
    // OBSERVABLE on the project config + the run can seed from the template repo.
    ...templateRefConfig(templateSelection),
    ...preparedDeploy.projectConfig,
  };
  const project = await createProject(
    pool,
    {
      name: slug,
      repoUrl,
      config,
      ...(repository === undefined ? {} : { defaultBranch: repository.defaultBranch }),
    },
    { ...input.actor, orgId: input.orgId },
    { configWriteProof: provisionedGreenfieldProjectConfigProof },
  );
  const projectId = project.projectId;
  const actor: ActorContext = { ...input.actor, orgId: input.orgId, projectId };

  // 1 · personas (project-scoped).
  const personaIdByName = new Map<string, string>();
  for (const persona of capture.personas) {
    const row = await PersonaStore.create(
      pool,
      PersonaCreateInput.parse({
        scope: "project",
        orgId: input.orgId,
        projectId,
        name: persona.name,
        description: persona.description,
        // The persona's delivery SURFACE (handheld / ops dashboard / …) is part of
        // the product vision the conflict resolver reads back, but the personas
        // table has no `surface` column — persist it on the existing `metadata`
        // jsonb (no migration). Omit it when the interview captured none.
        ...(persona.surface.trim() !== "" && { metadata: { surface: persona.surface } }),
      }),
      actor,
    );
    personaIdByName.set(persona.name.toLowerCase(), row.id);
  }

  // 2 · foundation milestone (M1 · scaffold) + scaffold specs (critical path).
  const milestoneIds: string[] = [];
  const scaffold = await MilestoneStore.create(
    pool,
    MilestoneCreateInput.parse({
      projectId,
      label: "M1",
      name: "scaffold",
      orderIndex: 0,
      status: "planned",
    }),
    actor,
  );
  milestoneIds.push(scaffold.id);

  const specIds: string[] = [];
  const scaffoldSpecIds: string[] = [];
  // Serialize the foundation into a CHAIN, not parallel roots. Each spec with
  // `dependsOnPrev` depends on the spec created immediately before it, so
  // `scaffold` is the sole root, `build` depends on it, and `deploy` depends on
  // build — one authoritative justfile/toolchain lands on `main` before the next
  // builds on it (no incompatible-stack races off an empty repo).
  let previousScaffoldSpecId: string | undefined;
  for (const def of scaffoldSpecs) {
    const dependsOn =
      def.dependsOnPrev === true && previousScaffoldSpecId !== undefined ? [previousScaffoldSpecId] : [];
    const spec = await createSpec(
      pool,
      {
        projectId,
        title: def.title,
        description: def.description,
        acceptanceCriteria: def.acceptanceCriteria ?? [
          `given the repo, when ${def.title} lands, then the pipeline is green`,
        ],
        ...(dependsOn.length > 0 ? { dependsOn } : {}),
      },
      actor,
    );
    await MilestoneStore.setSpecMilestone(pool, { specId: spec.specId, milestoneId: scaffold.id }, actor);
    scaffoldSpecIds.push(spec.specId);
    specIds.push(spec.specId);
    previousScaffoldSpecId = spec.specId;
  }

  // 3 · one milestone per interface, with a schema spec + a spec per behavior.
  const interfaces = capture.interfaces.length > 0 ? capture.interfaces : [{ name: "app", note: "" }];
  const behaviorIds: string[] = [];
  for (const [index, iface] of interfaces.entries()) {
    // M1 is the scaffold milestone; interfaces start at M2.
    const order = index + 1;
    const milestone = await MilestoneStore.create(
      pool,
      MilestoneCreateInput.parse({
        projectId,
        label: `M${order + 1}`,
        name: iface.name,
        orderIndex: order,
        status: "planned",
      }),
      actor,
    );
    milestoneIds.push(milestone.id);

    // Per-interface schema spec: depends on the scaffold (critical path).
    const schemaSpec = await createSpec(
      pool,
      {
        projectId,
        title: `${iface.name} · schema + scaffold`,
        description: `Schema + surface scaffold for the ${iface.name}.`,
        acceptanceCriteria: [`given the ${iface.name}, when scaffolded, then its schema + routing exist`],
        dependsOn: scaffoldSpecIds,
      },
      actor,
    );
    await MilestoneStore.setSpecMilestone(pool, { specId: schemaSpec.specId, milestoneId: milestone.id }, actor);
    specIds.push(schemaSpec.specId);

    const ifaceBehaviors = capture.behaviors.filter(
      (b) => interfaceForBehavior(b, capture, interfaces)?.name === iface.name,
    );
    for (const behavior of ifaceBehaviors) {
      const behaviorSpec = await deriveBehaviorSpec(pool, {
        projectId,
        orgId: input.orgId,
        behavior,
        milestoneId: milestone.id,
        dependsOn: [...scaffoldSpecIds, schemaSpec.specId],
        personaIdByName,
        actor,
      });
      specIds.push(behaviorSpec.specId);
      if (behaviorSpec.behaviorId !== undefined) behaviorIds.push(behaviorSpec.behaviorId);
    }
  }

  return {
    projectId,
    projectName: slug,
    ...(repository === undefined ? {} : { repository }),
    specIds,
    personaIds: [...personaIdByName.values()],
    behaviorIds,
    milestoneIds,
    ...(templateSelection === undefined ? {} : { templateSelection }),
  };
}
