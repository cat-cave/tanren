// THE POST-CREATE-PROJECT entity-graph build-out — split out of `derive.ts` so
// the transactional-rollback wrapper (task #78, which spans through `createProject`)
// stays under the 500-line file cap.
//
// SCOPE: this runs ONLY after `createProject` has landed the durable project
// row. The compensation stack from task #78 covers the EXTERNAL-RESOURCE window
// up through `createProject`; failures in THIS module leave the project row +
// external resources intact and the existing `resumeDerivedProject` returns the
// project idempotently on retry. A partial entity graph here is a known
// pre-existing limitation (the resume returns the project without re-running
// these creates) and is out of scope for the transactional-rollback patch.

import type pg from "pg";
import type { ActorContext } from "../../../auth/schemas.js";
import { MilestoneCreateInput, MilestoneStore, PersonaCreateInput, PersonaStore } from "../../entities/index.js";
import { createSpec } from "../../workflow/projectSpec.js";
import { deriveInterfaceMilestones, persistDesignContract } from "./deriveBehaviorSpec.js";
import type { DeriveInput, DeriveResult } from "./derive.js";
import type { ScaffoldSpecDef } from "./deriveScaffoldSpecs.js";
import type { SeededTemplate } from "../../templates/index.js";
import type { CreatedRepository } from "../../contracts/codeHostTypes.js";
import type { InterviewCapture } from "./types.js";

/**
 * Build out the entity graph (personas + milestones + scaffold specs + interface
 * milestones + design contract) for the just-created project row, and assemble
 * the `DeriveResult`. The caller (`deriveProductGraph`) is responsible for the
 * external-resource creates + the transactional rollback that wraps them; this
 * function is the durable, idempotency-resume-handled tail.
 */
export async function buildEntityGraph(
  pool: pg.Pool,
  input: DeriveInput,
  capture: InterviewCapture,
  slug: string,
  seed: SeededTemplate,
  repository: CreatedRepository | undefined,
  projectId: string,
  actor: ActorContext,
  scaffoldSpecs: ScaffoldSpecDef[],
): Promise<DeriveResult> {
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
        ...(persona.surface.trim() !== "" && { metadata: { surface: persona.surface } }),
      }),
      actor,
    );
    personaIdByName.set(persona.name.toLowerCase(), row.id);
  }

  // 2 · foundation milestone + scaffold specs.
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
        // Task #86 (v64 root cause): thread the writer-prompt mode from the scaffold-
        // spec definition. The `scaffold` spec carries `specialize_seed`; `build`/
        // `deploy` and every behavior/schema spec omit it and default to `from_scratch`.
        ...(def.mode !== undefined && { mode: def.mode }),
      },
      actor,
    );
    await MilestoneStore.setSpecMilestone(pool, { specId: spec.specId, milestoneId: scaffold.id }, actor);
    scaffoldSpecIds.push(spec.specId);
    specIds.push(spec.specId);
    previousScaffoldSpecId = spec.specId;
  }

  // 3 · interface milestones.
  const ifaceResult = await deriveInterfaceMilestones(pool, {
    projectId,
    orgId: input.orgId,
    capture,
    scaffoldSpecIds,
    personaIdByName,
    actor,
  });
  specIds.push(...ifaceResult.specIds);
  milestoneIds.push(...ifaceResult.milestoneIds);
  const behaviorIds = ifaceResult.behaviorIds;

  // 4 · design contract.
  const designContractId = await persistDesignContract(pool, {
    orgId: input.orgId,
    projectId,
    capture: capture.designContract,
    personaIdByName,
    behaviorIdByKey: ifaceResult.behaviorIdByKey,
    ...(input.designAgent === undefined ? {} : { designAgent: input.designAgent, actor }),
  });

  return {
    projectId,
    projectName: slug,
    ...(repository === undefined ? {} : { repository }),
    specIds,
    personaIds: [...personaIdByName.values()],
    behaviorIds,
    milestoneIds,
    designContractId,
    templateSeed: seed,
  };
}
