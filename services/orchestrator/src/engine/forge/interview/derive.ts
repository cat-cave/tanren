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
import type { CreatedRepository, CreateRepositoryInput } from "../../contracts/vcsProvider.js";
import { RepositoryAlreadyExistsError } from "../../contracts/vcsProvider.js";
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
import {
  selectTemplate,
  type SelectedTemplate,
  type TemplateRegistryQuery,
  type TemplateSelectionDecision,
} from "./templateSelection.js";
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
  // TEMPLATING WAVE 3 (templating-system.md §3): the ORG-SCOPED template-registry
  // query, injected so the derive can SELECT a validated template to SEED from
  // BEFORE authoring the scaffold spec. Org-scoped in prod (RLS bounds candidates
  // to the org's own + the cross-org `official` catalogue); a fixture in tests.
  // Absent ⇒ selection is skipped entirely and the from-scratch path runs (the
  // current live default — the registry is empty until the creation wave lands).
  templateRegistryQuery?: TemplateRegistryQuery;
  // Optional seed channel preference (defaults to "lts" — conservative greenfield).
  templateChannelPreference?: "lts" | "nightly";
  // Injectable clock for deterministic selection-freshness tests.
  selectionNow?: number;
  // TEMPLATING WAVE 4 (templating-system.md §3): the DECOUPLED no-match → CREATION
  // seam. When wired and selection finds NO validated template, it CREATES one (the
  // creation meta-flow) + SEEDS from it instead of falling to from-scratch. Supplied
  // by the wiring layer (`buildCreateForNoMatch`) so the derive/selection layers keep
  // NO creation dependency. Absent ⇒ the from-scratch path (the default + the test
  // path). Only consulted when `templateRegistryQuery` is also injected.
  createTemplateForNoMatch?: (lifecycle: CaptureLifecycle) => Promise<SelectedTemplate | undefined>;
}

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

  // TEMPLATING WAVE 3 — SELECT a validated template to SEED from, BEFORE deriving the
  // scaffold spec (templating-system.md §3). Runs only when a registry query is
  // injected (org-scoped in prod); otherwise selection is skipped and the
  // from-scratch path runs. The decision is fail-closed: any registry/freshness
  // problem downgrades to a from-scratch outcome with a LOUD log (inside
  // `selectTemplate`), so onboarding is NEVER stranded by the registry.
  const templateSelection =
    input.templateRegistryQuery === undefined
      ? undefined
      : await selectTemplate({
          lifecycle: capture.lifecycle,
          registryQuery: input.templateRegistryQuery,
          actor: { kind: "operator" },
          ...(input.templateChannelPreference === undefined
            ? {}
            : { channelPreference: input.templateChannelPreference }),
          ...(input.selectionNow === undefined ? {} : { now: input.selectionNow }),
          ...(input.createTemplateForNoMatch === undefined ? {} : { createForNoMatch: input.createTemplateForNoMatch }),
        });
  // The scaffold spec SHRINKS to template-instantiation on a strong/partial match;
  // otherwise it is the unchanged from-scratch authoring (the guaranteed fallback).
  const scaffoldSpecs = scaffoldSpecsFor(capture.lifecycle, templateSelection);

  // FINDING #1: opt-in autonomous config. `auto`/`simulated` ⇒ create the project
  // already autonomous (`native_queue` + matching review policy) so the DagWalker
  // can advance it off an empty repo with no follow-up PATCH. Absent/`human` ⇒ the
  // safe strict defaults — but STILL greenfield (the interview always builds off an
  // empty repo), so even the human tier persists `{ version: 1, greenfield: true }`
  // for the non-frozen in-loop deps-ensure. An unversioned `{}` blob is rejected
  // (no migration shim); `createProject` threads `config` through
  // `migrateProjectConfig` — no new plumbing.
  const autonomousOptIn = input.autonomy === "auto" || input.autonomy === "simulated";
  const deploy = resolveGreenfieldDeployDependency(input.deploy, { required: true });
  if (deploy !== undefined && input.preflightDeploy !== undefined) {
    const notLinked = await input.preflightDeploy({ orgId: input.orgId, providerKind: deploy.providerKind });
    if (notLinked !== undefined) throw new DeployNotLinkedError(notLinked);
  }
  const baseConfig = autonomousOptIn
    ? autonomousConfig(input.autonomy as "auto" | "simulated")
    : { version: 1, greenfield: true };
  if (deploy === undefined || input.prepareDeploy === undefined) throw missingDeployProvisionerError();

  // IDEMPOTENT + ATOMIC ORDER (audit §3.10). The order is REPO-FIRST, THEN deploy — so
  // a repo-create failure never strands a deploy app, and a stranded retry resumes off
  // the durable `projects` row keyed by the deterministic repo URL instead of
  // double-provisioning a SECOND deploy app + 409-ing on the already-created repo.
  // (Engine-test paths pass an explicit `repoUrl` + no `createRepository` — they skip
  // the repo step entirely and are not subject to the idempotency probe.)
  let repository: CreatedRepository | undefined;
  let repoUrl = input.repoUrl;
  if (repoUrl === undefined) {
    if (input.owner === undefined || input.createRepository === undefined) {
      throw new Error("greenfield repository owner and creator are required");
    }
    const owner = input.owner;
    const createRepository = input.createRepository;
    // The deterministic repo URL is the idempotency key — a project already bound to it
    // is a completed prior derive: return it (no repo-create, no deploy-provision).
    const deterministicRepoUrl = githubHttpsRemote({ owner, name: slug });
    const existingProject = await ProjectStore.findByRepoUrl(pool, deterministicRepoUrl, { kind: "operator" });
    if (existingProject !== undefined) {
      return resumeDerivedProject(existingProject);
    }
    try {
      repository = await createRepository({
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
        repository = {
          fullName: `${owner}/${slug}`,
          repoUrl: deterministicRepoUrl,
          // The auto-init default branch GitHub seeds (the repo already exists).
          defaultBranch: "main",
        };
      } else {
        throw error;
      }
    }
    repoUrl = repository.repoUrl;
  }

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
