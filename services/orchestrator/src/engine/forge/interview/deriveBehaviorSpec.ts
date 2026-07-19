// Behavior-spec derivation is split out of `derive.ts` to keep it under the
// 500-line cap. It composes the existing entity-creation paths and adds no write
// authority of its own.

import type { ActorContext } from "../../../auth/schemas.js";
import { AUTONOMOUS_AUDIT_POSTURE } from "../../config/index.js";
import { BehaviorCreateInput, BehaviorStore } from "../../entities/behaviors.js";
import { MilestoneCreateInput, MilestoneStore } from "../../entities/milestones.js";
import { PersonaStore } from "../../entities/personas.js";
import {
  PgBehaviorRevisionStore,
  PgPersonaRevisionStore,
  RevisionBindingError,
} from "../../repositories/behaviorRevisionStore.js";
import type { BehaviorRevision } from "../../contracts/behaviorRevision.js";
import { createSpecOnClient, type ProjectSpecQueryClient, type SpecContract } from "../../workflow/projectSpec.js";
import { behaviorKey, DanglingDesignRefError } from "./deriveDesignContract.js";
import type { CaptureBehavior, CaptureInterface, InterviewCapture } from "./types.js";

// Re-export the design-contract derive helpers (native design subsystem, WS-D1)
// through this behavior-derive module so `derive.ts` reaches them without a
// separate module dependency (the design contract binds the SAME behaviors this
// module derives — they belong to the same derive concern).
export {
  behaviorKey,
  DanglingDesignRefError,
  MissingDesignContractError,
  persistDesignContract,
  productVisionConfig,
} from "./deriveDesignContract.js";

// H1 finding #4 — the greenfield derive's EARLY-FEEDBACK JIT env-image guard
// (env-management.md §2.2 halt-loud). Re-exported through this same behavior-derive
// module so `derive.ts` reaches it without a separate module dependency (derive.ts
// already imports from this module and is at its max-imports cap).
export { assertJitAvailableForToolchain } from "../../environments/creation/index.js";

// fix/f2-prompt-hardening: the F2 writer-prompt product-context builder
// (deriveProductContext.ts). Re-exported through this same behavior-derive module
// so `derive.ts` reaches it without a separate module dependency (derive.ts is
// already at its max-imports cap).
export { buildProductContextFromCapture } from "./deriveProductContext.js";

// FINDING #1 + task #79: the autonomous greenfield config. When the operator opts
// into `auto`/`simulated`, the project is created ATOMICALLY with EVERY knob
// autonomous operation requires — no second governance PUT, no operator race-window.
// The DagWalker auto-claims within seconds of project insert; a project that landed
// without the autonomous audit posture + CI-intelligence threshold would halt the
// first scaffold run on `audit.posture_strands_findings`. The four axes:
//   - `reviewPolicy` + `mergeIntegration` — derived PRs enter the native merge queue.
//   - `governancePosture: "lenient"` — functional-but-weak in-loop gate.
//   - `auditPosture: AUTONOMOUS_AUDIT_POSTURE` — P2/P3 route into DAG; blockers
//     remediate. Without it the audit-posture preflight FAILS LOUD.
//   - `insightThresholds: { ciInsightFlakyMinShas: 1 }` — single-run flake spec.
// `autonomy: "auto"` is the operator saying "configure this project for fully
// autonomous operation"; doctrine demands every knob, atomically. Absent or
// `human` ⇒ no overrides ⇒ the safe defaults (the §2.5 PUT remains the operator
// surface for adjusting posture later). Lives here (not in derive.ts) to stay
// under derive.ts's max-imports cap; derive.ts already imports from this module.
export function autonomousConfig(autonomy: "auto" | "simulated"): Record<string, unknown> {
  return {
    version: 1,
    reviewPolicy: autonomy,
    mergeIntegration: "native_queue",
    governancePosture: "lenient",
    auditPosture: AUTONOMOUS_AUDIT_POSTURE,
    insightThresholds: { ciInsightFlakyMinShas: 1 },
    greenfield: true,
  };
}

// Build the BDD acceptance criteria for a behavior spec from its given/when/then.
function acceptanceFor(behavior: CaptureBehavior): string[] {
  const given = behavior.given === "" ? "the persona in context" : behavior.given;
  const when = behavior.when === "" ? `they ${behavior.title}` : behavior.when;
  const then = behavior.then === "" ? "the behavior is demonstrated" : behavior.then;
  return [`given ${given}, when ${when}, then ${then}`];
}

// rv-1 freeze seam — mint the IMMUTABLE, content-addressed behavior revision for
// a behavior the derive just authored, bound to its originating spec. Runs on the
// SAME org-scoped client/transaction as the behavior + spec_behaviors link, so
// the revision is frozen atomically with the spec that declares it. A behavior
// can only cite a persona revision that exists (rejected otherwise), and the
// frozen revision must resolve back by its own content digest (fail-closed).
async function mintFrozenBehaviorRevision(
  client: ProjectSpecQueryClient,
  input: {
    orgId: string;
    projectId: string;
    specId: string;
    personaId: string;
    behavior: CaptureBehavior;
    behaviorId: string;
    actor: ActorContext;
  },
): Promise<BehaviorRevision> {
  const persona = await PersonaStore.get(client, input.personaId, input.actor);
  if (persona === undefined) {
    throw new Error(`persona not found for behavior revision: ${input.personaId}`);
  }
  const personaRevision = await new PgPersonaRevisionStore(client).create({
    orgId: input.orgId,
    projectId: persona.projectId,
    personaId: input.personaId,
    scope: persona.scope,
    name: persona.name,
    description: persona.description,
    attributes: persona.metadata,
    authoringProvenance: { source: "derive", personaId: input.personaId },
  });
  const behaviorStore = new PgBehaviorRevisionStore(client);
  /* eslint-disable unicorn/no-thenable */
  // `then` is the BDD Given/When/Then field name carried into the revision body.
  const behaviorRevision = await behaviorStore.create({
    orgId: input.orgId,
    projectId: input.projectId,
    behaviorId: input.behaviorId,
    personaRevisionId: personaRevision.id,
    title: input.behavior.title,
    given: input.behavior.given,
    when: input.behavior.when,
    then: input.behavior.then,
    acceptance: { criteria: acceptanceFor(input.behavior) },
    authoringProvenance: { source: "derive", originatingSpecId: input.specId, behaviorId: input.behaviorId },
  });
  /* eslint-enable unicorn/no-thenable */
  // Fail-closed: the frozen behavior MUST resolve by its content digest (the same
  // content-addressed binding downstream spec consumers use). A miss is a broken
  // append-only write, never a silent pass.
  const bound = await behaviorStore.getByDigest(input.orgId, behaviorRevision.contentDigest);
  if (bound === undefined || bound.id !== behaviorRevision.id) {
    throw new RevisionBindingError(behaviorRevision.contentDigest);
  }
  return behaviorRevision;
}

export interface DeriveBehaviorSpecInput {
  projectId: string;
  orgId: string;
  behavior: CaptureBehavior;
  milestoneId: string;
  dependsOn: string[];
  personaIdByName: Map<string, string>;
  behaviorId: string;
  actor: ActorContext;
}

// Create the spec for one behavior, persist the behavior under its persona, and
// link the two (spec ⇄ behavior) so the DAG shows the b-tag tie.
export async function deriveBehaviorSpec(
  pool: ProjectSpecQueryClient,
  input: DeriveBehaviorSpecInput,
): Promise<SpecContract & { behaviorId?: string }> {
  const spec = await createSpecOnClient(
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
      id: input.behaviorId,
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
  // rv-1 — freeze the behavior as an immutable, content-addressed revision bound
  // to the spec that just declared it (atomic with the link above).
  await mintFrozenBehaviorRevision(pool, {
    orgId: input.orgId,
    projectId: input.projectId,
    specId: spec.specId,
    personaId,
    behavior: input.behavior,
    behaviorId: behaviorRow.id,
    actor: input.actor,
  });
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
  plannedBehaviorIdByKey: Map<string, string>;
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
  pool: ProjectSpecQueryClient,
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
    const schemaSpec = await createSpecOnClient(
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
      const key = behaviorKey(behavior.persona, behavior.title);
      const plannedBehaviorId = input.plannedBehaviorIdByKey.get(key);
      if (plannedBehaviorId === undefined) throw new DanglingDesignRefError("behavior", key);
      const behaviorSpec = await deriveBehaviorSpec(pool, {
        projectId,
        orgId: input.orgId,
        behavior,
        milestoneId: milestone.id,
        dependsOn: [...scaffoldSpecIds, schemaSpec.specId],
        personaIdByName,
        behaviorId: plannedBehaviorId,
        actor,
      });
      specIds.push(behaviorSpec.specId);
      const bId = behaviorSpec.behaviorId;
      if (bId === undefined) continue;
      behaviorIds.push(bId);
      behaviorIdByKey.set(key, bId);
    }
  }
  return { specIds, milestoneIds, behaviorIds, behaviorIdByKey };
}
