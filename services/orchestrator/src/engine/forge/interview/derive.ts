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
}

export interface DeriveResult {
  projectId: string;
  projectName: string;
  specIds: string[];
  personaIds: string[];
  behaviorIds: string[];
  milestoneIds: string[];
}

const SCAFFOLD_SPECS: Array<{ title: string; description: string }> = [
  {
    title: "monorepo scaffold",
    description: "Stand up the monorepo: workspaces, base tsconfig, shared types package.",
  },
  {
    title: "build · turbo",
    description: "Wire the build pipeline (turbo) so every package builds + caches.",
  },
  {
    title: "ci · gh actions",
    description: "CI on GitHub Actions: install, lint, typecheck, test, build on every PR.",
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
  const given = behavior.given !== "" ? behavior.given : "the persona in context";
  const when = behavior.when !== "" ? behavior.when : `they ${behavior.title}`;
  const then = behavior.then !== "" ? behavior.then : "the behavior is demonstrated";
  return [`given ${given}, when ${when}, then ${then}`];
}

export async function deriveProductGraph(pool: pg.Pool, input: DeriveInput): Promise<DeriveResult> {
  // Validate the capture at the derive boundary (defence in depth; the round
  // engine also validates) so a malformed capture never reaches the create path.
  const capture = InterviewCapture.parse(input.capture);
  const slug = capture.identity?.slug ?? "greenfield-project";
  const repoUrl = input.repoUrl ?? `https://github.com/${slug}`;

  const project = await createProject(
    pool,
    { name: slug, repoUrl, config: {} },
    { ...input.actor, orgId: input.orgId },
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
  for (const def of SCAFFOLD_SPECS) {
    const spec = await createSpec(
      pool,
      {
        projectId,
        title: def.title,
        description: def.description,
        acceptanceCriteria: [`given the repo, when ${def.title} lands, then the pipeline is green`],
      },
      actor,
    );
    await MilestoneStore.setSpecMilestone(pool, { specId: spec.specId, milestoneId: scaffold.id }, actor);
    scaffoldSpecIds.push(spec.specId);
    specIds.push(spec.specId);
  }

  // 3 · one milestone per interface, with a schema spec + a spec per behavior.
  const interfaces = capture.interfaces.length > 0 ? capture.interfaces : [{ name: "app", note: "" }];
  const behaviorIds: string[] = [];
  for (const [index, iface] of interfaces.entries()) {
    const order = index + 1; // M1 is the scaffold milestone; interfaces start at M2.
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
