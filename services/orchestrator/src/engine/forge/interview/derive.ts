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
import { BehaviorCreateInput, BehaviorStore } from "../../entities/behaviors.js";
import { MilestoneCreateInput, MilestoneStore } from "../../entities/milestones.js";
import { PersonaCreateInput, PersonaStore } from "../../entities/personas.js";
import { provisionedGreenfieldProjectConfigProof } from "../../workflow/projectConfigWriteGuards.js";
import { createProject, createSpec, type SpecContract } from "../../workflow/projectSpec.js";
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
  buildScaffoldAcceptanceCriteria,
  buildScaffoldDescription,
  MissingLifecycleError,
} from "./scaffoldAuthoring.js";
import { InterviewCapture, type CaptureBehavior, type CaptureInterface, type CaptureLifecycle } from "./types.js";

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
}

// The foundation scaffold specs are AUTHORED FROM THE CAPTURED LIFECYCLE
// (stack-flexible contract, docs/roadmap/stack-flexible-contract.md) — Tanren
// bakes in NO stack. The architecture step captures the project's concrete
// lifecycle (the stack commands behind the conventional justfile targets); the
// scaffold spec instructs the writer to start from Wave A's bare skeleton and
// FILL the justfile with those commands, keeping the stable `.tanren/ci.yml` as
// the lifecycle→`just <target>` map. The hardcoded-pnpm `scaffoldCiConfig.ts`
// example + the pnpm/turbo/`gh actions` specs are GONE — they were the apex
// v25/v26 bug (the interview captured the architecture but the scaffold ignored
// it and baked in Node).
//
// Fixes preserved here (DOMAIN knowledge — not a walker-wide rule):
//   1. `dependsOnPrev` SERIALIZES the foundation into a chain (`scaffold` is the
//      sole root; `build` then `deploy` chain off it), so one branch establishes
//      the authoritative justfile/toolchain on `main` before the next builds on it
//      (no incompatible-stack races off an empty repo).
//   2. The `scaffold` spec authors the justfile + the stable ci.yml FROM the
//      captured lifecycle (no hardcoded stack); the `build`/`deploy` specs route
//      through the conventional `just build` / `just deploy` targets — never a
//      hardcoded build/deploy command.
//   3. The SCAFFOLD BAR is structure + bootstrap/tier-1/build passing — a thorough
//      test SUITE is NOT required at scaffold (tests arrive with the feature specs).
interface ScaffoldSpecDef {
  title: string;
  description: string;
  // The acceptance criteria the writer must satisfy. When absent, a generic
  // "pipeline is green" criterion is synthesized in the create loop.
  acceptanceCriteria?: string[];
  // When true, this spec `dependsOn` the PREVIOUS scaffold spec in the list — the
  // wiring that serializes the foundation into a chain instead of parallel roots.
  dependsOnPrev?: boolean;
}

// Build the foundation scaffold specs from the captured lifecycle. The `scaffold`
// spec is authored from the lifecycle (justfile + stable ci.yml); `build` and
// `deploy` route through the conventional `just build` / `just deploy` targets the
// scaffold just established — so the deploy/build paths invoke the PROJECT's
// declared command, never a hardcoded assumption.
function scaffoldSpecsFor(lifecycle: CaptureLifecycle): ScaffoldSpecDef[] {
  return [
    {
      title: "scaffold",
      description: buildScaffoldDescription(lifecycle),
      acceptanceCriteria: buildScaffoldAcceptanceCriteria(lifecycle),
    },
    {
      title: "build",
      description:
        `Wire the project's build so the deployable artifact is produced via the conventional ` +
        `\`just build\` target the scaffold established (for ${lifecycle.stack}: \`${lifecycle.build.trim()}\`). ` +
        "Build on the EXISTING justfile/toolchain on `main` — do NOT re-invent the stack or bypass `just build`.",
      acceptanceCriteria: [
        "given the scaffolded repo, when `just build` runs, then it produces the deployable artifact and exits 0",
      ],
      dependsOnPrev: true,
    },
    {
      title: "deploy",
      description:
        `Wire the project's deploy so it ships via the conventional \`just deploy\` target the scaffold ` +
        `established (for ${lifecycle.stack}: \`${lifecycle.deploy.trim()}\`). Route deploy ONLY through ` +
        "`just deploy` — never a hardcoded deploy command or a Node/platform assumption.",
      acceptanceCriteria: [
        "given a built artifact, when `just deploy` runs, then it ships to the deploy target via the conventional `just deploy` (no hardcoded deploy command)",
      ],
      dependsOnPrev: true,
    },
  ];
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

// Build the BDD acceptance criteria for a behavior spec from its given/when/then.
function acceptanceFor(behavior: CaptureBehavior): string[] {
  const given = behavior.given === "" ? "the persona in context" : behavior.given;
  const when = behavior.when === "" ? `they ${behavior.title}` : behavior.when;
  const then = behavior.then === "" ? "the behavior is demonstrated" : behavior.then;
  return [`given ${given}, when ${when}, then ${then}`];
}

export async function deriveProductGraph(pool: pg.Pool, input: DeriveInput): Promise<DeriveResult> {
  // Validate the capture at the derive boundary (defence in depth; the round
  // engine also validates) so a malformed capture never reaches the create path.
  const capture = InterviewCapture.parse(input.capture);
  const slug = capture.identity?.slug ?? "greenfield-project";

  // The architecture step's lifecycle is LOAD-BEARING + REQUIRED — the scaffold
  // authors the justfile + ci.yml from it. FAIL LOUD if it is missing (the
  // stack-flexible contract's core invariant: never silently default to Node).
  if (capture.lifecycle === null) throw new MissingLifecycleError();
  const scaffoldSpecs = scaffoldSpecsFor(capture.lifecycle);

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
  // PERSIST THE PRODUCT VISION (no migration). The interview capture is otherwise
  // transient — personas/behaviors/specs become rows, but the product's IDENTITY
  // (`pitch`) + DESIGN-DNA were previously dropped. Persist them onto the existing
  // `projects.config` blob so the conflict resolver can frame a resolution against
  // the product vision. Only the fields the interview actually captured are
  // written (omit empties) — a real empty state, not a stub.
  if (deploy === undefined || input.prepareDeploy === undefined) throw missingDeployProvisionerError();
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
  let repository: CreatedRepository | undefined;
  let repoUrl = input.repoUrl;
  if (repoUrl === undefined) {
    if (input.owner === undefined || input.createRepository === undefined) {
      throw new Error("greenfield repository owner and creator are required");
    }
    repository = await input.createRepository({
      owner: input.owner,
      name: slug,
      private: input.private ?? true,
      autoInit: true,
      ...(input.description === undefined ? {} : { description: input.description }),
    });
    repoUrl = repository.repoUrl;
  }
  const config = { ...baseConfig, ...productVisionConfig(capture), ...preparedDeploy.projectConfig };
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
  };
}

interface DeriveBehaviorSpecInput {
  projectId: string;
  orgId: string;
  behavior: CaptureBehavior;
  milestoneId: string;
  dependsOn: string[];
  personaIdByName: Map<string, string>;
  actor: ActorContext;
}

// Create the spec for one behavior, persist the behavior under its persona, and
// link the two (spec ⇄ behavior) so the DAG shows the b-tag tie.
async function deriveBehaviorSpec(
  pool: pg.Pool,
  input: DeriveBehaviorSpecInput,
): Promise<SpecContract & { behaviorId?: string }> {
  const spec = await createSpec(
    pool,
    {
      projectId: input.projectId,
      title: input.behavior.title,
      description: `${input.behavior.persona}: ${input.behavior.title}.`,
      acceptanceCriteria: acceptanceFor(input.behavior),
      dependsOn: input.dependsOn,
    },
    input.actor,
  );
  await MilestoneStore.setSpecMilestone(pool, { specId: spec.specId, milestoneId: input.milestoneId }, input.actor);

  const personaId = input.personaIdByName.get(input.behavior.persona.toLowerCase());
  if (personaId === undefined) {
    return spec;
  }
  /* eslint-disable unicorn/no-thenable */
  // `then` is the BDD Given/When/Then field name carried into the behavior row.
  const behaviorRow = await BehaviorStore.create(
    pool,
    BehaviorCreateInput.parse({
      personaId,
      title: input.behavior.title,
      given: input.behavior.given,
      when: input.behavior.when,
      then: input.behavior.then,
    }),
    input.actor,
  );
  /* eslint-enable unicorn/no-thenable */
  await BehaviorStore.linkToSpec(pool, { specId: spec.specId, behaviorId: behaviorRow.id }, input.actor);
  return { ...spec, behaviorId: behaviorRow.id };
}
