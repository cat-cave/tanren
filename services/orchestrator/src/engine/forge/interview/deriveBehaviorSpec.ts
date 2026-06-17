// Derive helpers split out of `derive.ts` to keep it under the 500-line cap:
//   - `deriveBehaviorSpec`: create one behavior spec + persist+link the behavior row.
//   - `resumeDerivedProject`: the idempotent-resume result for a retried derive whose
//     project already exists (audit §3.10).
// Both are pure compositions over the existing entity-creation paths — no new write
// surface, just a relocation behind the per-file line cap.

import type pg from "pg";
import type { ActorContext } from "../../../auth/schemas.js";
import { BehaviorCreateInput, BehaviorStore } from "../../entities/behaviors.js";
import { MilestoneCreateInput, MilestoneStore } from "../../entities/milestones.js";
import { parseGitHubRepository } from "../../providers/github.js";
import { createSpec, type SpecContract } from "../../workflow/projectSpec.js";
import { behaviorKey } from "./deriveDesignContract.js";
import type { DeriveResult } from "./derive.js";
import type { CaptureBehavior, CaptureInterface, InterviewCapture } from "./types.js";

// Re-export the design-contract derive helpers (native design subsystem, WS-D1)
// through this behavior-derive module so `derive.ts` reaches them without a
// separate module dependency (the design contract binds the SAME behaviors this
// module derives — they belong to the same derive concern).
export { behaviorKey, persistDesignContract, productVisionConfig } from "./deriveDesignContract.js";

// Build the BDD acceptance criteria for a behavior spec from its given/when/then.
function acceptanceFor(behavior: CaptureBehavior): string[] {
  const given = behavior.given === "" ? "the persona in context" : behavior.given;
  const when = behavior.when === "" ? `they ${behavior.title}` : behavior.when;
  const then = behavior.then === "" ? "the behavior is demonstrated" : behavior.then;
  return [`given ${given}, when ${when}, then ${then}`];
}

// IDEMPOTENT RESUME (audit §3.10): a derive whose project ALREADY exists for the
// deterministic repo URL is a retry of a completed derive. Return the existing project
// (id + the repo it is bound to) instead of re-provisioning the repo/deploy or
// re-creating the entity graph (which would duplicate personas/specs). The derived
// entity ids are not re-enumerated here — the project + its DAG already exist and are
// read back through the project-DAG endpoint; the resume only needs to identify the
// project so the caller does not double-provision.
export function resumeDerivedProject(existing: {
  projectId: string;
  name: string;
  repoUrl: string;
  defaultBranch: string;
}): DeriveResult {
  const parsed = parseGitHubRepository(existing.repoUrl);
  return {
    projectId: existing.projectId,
    projectName: existing.name,
    repository: {
      fullName: `${parsed.owner}/${parsed.name}`,
      repoUrl: existing.repoUrl,
      defaultBranch: existing.defaultBranch,
    },
    specIds: [],
    personaIds: [],
    behaviorIds: [],
    milestoneIds: [],
  };
}

export interface DeriveBehaviorSpecInput {
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
export async function deriveBehaviorSpec(
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

// A behavior belongs to an interface when its persona's surface matches the
// interface name (best-effort, lowercase substring). Unmatched behaviors fall to
// the first interface so nothing is dropped from the DAG.
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

export interface InterfaceMilestonesInput {
  projectId: string;
  orgId: string;
  capture: InterviewCapture;
  scaffoldSpecIds: string[];
  personaIdByName: Map<string, string>;
  actor: ActorContext;
}

export interface InterfaceMilestonesResult {
  specIds: string[];
  milestoneIds: string[];
  behaviorIds: string[];
  // THE MOAT (WS-D1): behavior key (`persona::title`) → persisted behavior id, so
  // the design contract can bind its `behaviorRefs` to the REAL behavior rows.
  behaviorIdByKey: Map<string, string>;
}

// Step 3 of the derive: one milestone per inferred INTERFACE, each carrying a
// per-interface schema spec + a spec per behavior tied to a persona whose surface
// matches that interface. Extracted from `derive.ts` for the per-file line cap.
export async function deriveInterfaceMilestones(
  pool: pg.Pool,
  input: InterfaceMilestonesInput,
): Promise<InterfaceMilestonesResult> {
  const { projectId, capture, scaffoldSpecIds, personaIdByName, actor } = input;
  const interfaces = capture.interfaces.length > 0 ? capture.interfaces : [{ name: "app", note: "" }];
  const specIds: string[] = [];
  const milestoneIds: string[] = [];
  const behaviorIds: string[] = [];
  const behaviorIdByKey = new Map<string, string>();
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
      const bId = behaviorSpec.behaviorId;
      if (bId === undefined) continue;
      behaviorIds.push(bId);
      behaviorIdByKey.set(behaviorKey(behavior.persona, behavior.title), bId);
    }
  }
  return { specIds, milestoneIds, behaviorIds, behaviorIdByKey };
}
