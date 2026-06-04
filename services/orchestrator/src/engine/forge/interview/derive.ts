// P3-0015 greenfield onboarding: derive the product graph from a completed
// vision-interview capture.
//
// This is the heart of "interview → DAG". On completion the accumulated
// capture is turned into a live project's product graph, created through the
// SAME foundations rather than a forked write path:
//
//   project    → createProject              (P2A-0013 workflow)
//   personas   → PersonaStore.create        (P2A-0018)
//   behaviors  → BehaviorStore.create + linkToSpec
//   milestones → MilestoneStore.create + setSpecMilestone   (P2A-0018)
//   specs      → createSpec                 (P2A-0013, incl. dependency wiring)
//
// The derived DAG is exactly what P3-0013's `getProjectDag` then reads back:
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
import { BehaviorCreateInput, BehaviorStore } from "../../entities/behaviors.js";
import { MilestoneCreateInput, MilestoneStore } from "../../entities/milestones.js";
import { PersonaCreateInput, PersonaStore } from "../../entities/personas.js";
import { createProject, createSpec, type SpecContract } from "../../workflow/projectSpec.js";
import { InterviewCapture, type CaptureBehavior, type CaptureInterface } from "./types.js";

export interface DeriveInput {
  orgId: string;
  capture: InterviewCapture;
  actor: ActorContext;
  // Optional repo url override; otherwise derived from the identity slug.
  repoUrl?: string;
  // GREENFIELD AUTONOMY (FINDING #1): how the derived project is governed at
  // creation. `createProject`'s schema DEFAULTS (`reviewPolicy: "human"` +
  // `mergeIntegration: "not_configured"`) are the SAFE brownfield/managed default,
  // but they leave a greenfield project unable to advance itself (PRs await a human
  // + never enter a merge engine). When the caller asks for `auto`/`simulated`, we
  // create the project ALREADY autonomous so the DagWalker drives it off an empty
  // repo with no follow-up PATCH. Absent or `human` ⇒ no config ⇒ the safe defaults.
  autonomy?: "auto" | "simulated" | "human";
}

// FINDING #1: the autonomous greenfield config. When the operator opts into
// `auto`/`simulated`, the project is created with the matching review policy + the
// `native_queue` merge engine (so derived PRs enter a merge engine instead of
// stalling on `not_configured`), AND the `lenient` governance posture. Lenient
// makes the in-loop gate's `lint`/`typecheck` ADVISORY (warn, non-blocking) while
// `build`/`test` stay blocking — the functional-but-weak apex doctrine
// (docs/operator-guide/apex.md): a functional-but-weak first pass lands imperfect
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
  specIds: string[];
  personaIds: string[];
  behaviorIds: string[];
  milestoneIds: string[];
}

// FINDING #3: the foundation scaffold specs. These used to carry EMPTY `dependsOn`,
// so the DagWalker ran all three IN PARALLEL off an empty `main` — each invented the
// repo from scratch with incompatible package-manager choices (e.g. one emitting
// `npm workspaces`, which the default pnpm gate rejects with exit 254) and they never
// converged (no authoritative toolchain on `main`, can't see each other's branches).
//
// Two fixes encoded here (the right place for this DOMAIN knowledge — not a
// walker-wide rule):
//   1. `dependsOnPrev` SERIALIZES the foundation into a chain: `monorepo scaffold`
//      is the sole root; `build · turbo` depends on it; `ci · gh actions` depends on
//      build. So one branch establishes the authoritative toolchain before the next
//      builds on it.
//   2. The `monorepo scaffold` description + acceptance criteria PIN the toolchain
//      the default gate (`pnpm lint`/`typecheck`/`test`/`build`, per the CI
//      `DEFAULT_CI_CONFIG`) accepts — pnpm workspaces with a `pnpm-workspace.yaml`,
//      a root `package.json` whose `lint`/`typecheck`/`test`/`build` scripts call
//      DIRECT tools (eslint/tsc/vitest), and a committed pnpm lockfile — so the
//      foundation is deterministic and gate-compatible (NOT the whole repo, just the
//      toolchain the gate expects). NO turbo in the scaffold: a direct-tool toolchain
//      is the simplest thing that satisfies the gate's script NAMES, and turbo is
//      introduced later by the `build · turbo` spec once the toolchain is stable on
//      `main` (so the foundation never depends on turbo being installed first).
//
// SCOPE (#273 convergence): the FIRST scaffold spec is deliberately MINIMAL — a
// pnpm workspace with just the root + ONE trivial package, no shared-types
// package and no tsconfig project-references. The over-prescribed earlier version
// (shared-types + project-references + base tsconfig + lockfile in one pass) was
// too big for a single ~10-min writer pass: most reruns TIMED OUT, and the one
// that split the work emitted `workspace:*` STUB packages for the toolchain
// (which the checker correctly rejected). The workspace SHAPE is preserved
// (later specs assume a `pnpm-workspace.yaml`); shared-types / project-references
// are deferred to a FOLLOW-ON spec if a later milestone actually needs them. An
// EXPLICIT criterion forbids stub/`workspace:*`/fake toolchain packages —
// typescript/eslint/vitest MUST be real published devDependencies.
interface ScaffoldSpecDef {
  title: string;
  description: string;
  // The acceptance criteria the writer must satisfy. When absent, a generic
  // "pipeline is green" criterion is synthesized in the create loop.
  acceptanceCriteria?: string[];
  // When true, this spec `dependsOn` the PREVIOUS scaffold spec in the list — the
  // wiring that serializes the foundation into a chain instead of 3 parallel roots.
  dependsOnPrev?: boolean;
}

const SCAFFOLD_SPECS: ScaffoldSpecDef[] = [
  {
    title: "monorepo scaffold",
    description:
      "Stand up a MINIMAL pnpm workspace on the DEFAULT TANREN TOOLCHAIN so the CI gate passes — " +
      "keep it small enough to finish in ONE pass. Author: a `pnpm-workspace.yaml` declaring the " +
      "package globs (a workspace with just the root, OR the root plus ONE trivial package); a root " +
      "`package.json` whose `lint`, `typecheck`, `test`, and `build` scripts call DIRECT tools — " +
      '`"lint": "eslint ."`, `"typecheck": "tsc --noEmit"`, `"test": "vitest run"`, `"build": "tsc -b"` ' +
      "— with `eslint`, `typescript`, and `vitest` as REAL published devDependencies; a real " +
      "`eslint.config.js` flat config that exists and passes; a `tsconfig.json`; one trivial " +
      "`src/index.ts`; one trivial PASSING vitest test; a COMMITTED `.gitignore` that ignores " +
      "`node_modules` and `dist` (so build/install artifacts are never committed); and a COMMITTED " +
      "`pnpm-lock.yaml`. " +
      "Use the REAL published `typescript`/`eslint`/`vitest` packages — NEVER create local " +
      "workspace stub packages, `workspace:*` placeholders, or fake toolchain binaries. Do NOT add " +
      "a shared-types package or tsconfig project references (a later spec adds those if needed), do " +
      "NOT use turbo (a later spec introduces it once the toolchain is stable), and do NOT use " +
      "npm/yarn workspaces — the gate runs `pnpm install` then `pnpm lint` / `pnpm typecheck` / " +
      "`pnpm test` / `pnpm build` and rejects a non-pnpm workspace.",
    acceptanceCriteria: [
      "given an empty repo, when the scaffold lands, then a `pnpm-workspace.yaml` and a committed `pnpm-lock.yaml` exist (a minimal pnpm workspace — root only, or root + one trivial package — not npm/yarn)",
      "given the root `package.json`, when inspected, then its `lint`, `typecheck`, `test`, and `build` scripts call direct tools (eslint/tsc/vitest), NOT turbo, with eslint/typescript/vitest as devDependencies",
      "given the toolchain packages, when inspected, then `typescript`, `eslint`, and `vitest` are REAL published devDependencies — NOT local stub packages, `workspace:*` placeholders, or fake binaries",
      "given the lint setup, when inspected, then a real `eslint.config.js` flat config exists (so `eslint .` runs cleanly), a `tsconfig.json` exists, and a trivial `src/index.ts` exists",
      "given the repo root, when inspected, then a committed `.gitignore` ignores `node_modules` and `dist` (so install/build artifacts are never committed)",
      "given a trivial passing vitest test exists, when `pnpm install` then `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` run, then each exits 0 (the default CI gate is green)",
    ],
  },
  {
    title: "build · turbo",
    description:
      "Introduce turbo on top of the scaffold's pnpm-workspace toolchain so every package builds + " +
      "caches. Build on the EXISTING pnpm-workspace + direct-tool scripts on `main` (the scaffold " +
      "uses `tsc -b`, not turbo); do not re-invent the package manager.",
    dependsOnPrev: true,
  },
  {
    title: "ci · gh actions",
    description:
      "CI on GitHub Actions: install with pnpm, then lint, typecheck, test, build on every PR, " +
      "matching the root scripts the scaffold defined.",
    dependsOnPrev: true,
  },
];

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
  const repoUrl = input.repoUrl ?? `https://github.com/${slug}`;

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
  // PERSIST THE PRODUCT VISION (no migration). The interview capture is otherwise
  // transient — personas/behaviors/specs become rows, but the product's IDENTITY
  // (`pitch`) + DESIGN-DNA were previously dropped. Persist them onto the existing
  // `projects.config` blob so the conflict resolver can frame a resolution against
  // the product vision. Only the fields the interview actually captured are
  // written (omit empties) — a real empty state, not a stub.
  const config = { ...baseConfig, ...productVisionConfig(capture) };
  const project = await createProject(pool, { name: slug, repoUrl, config }, { ...input.actor, orgId: input.orgId });
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
  // FINDING #3: serialize the foundation into a CHAIN, not 3 parallel roots. Each
  // spec with `dependsOnPrev` depends on the spec created immediately before it, so
  // `monorepo scaffold` is the sole root, `build · turbo` depends on it, and
  // `ci · gh actions` depends on build — one authoritative toolchain lands on `main`
  // before the next builds on it (no incompatible package-manager races).
  let previousScaffoldSpecId: string | undefined;
  for (const def of SCAFFOLD_SPECS) {
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
