// THE POST-CREATE-PROJECT entity-graph build-out — split out of `derive.ts` so
// the transactional-rollback wrapper (task #78, which spans through `createProject`)
// stays under the 500-line file cap.
//
// SCOPE: this runs only after the durable deriving project shell exists. Every
// graph row is written through one org-scoped transaction. A failure rolls the
// whole graph attempt back while retaining the shell and earlier external-effect
// receipts, so retry can rebuild the graph without duplicating partial entities.

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { ActorContext } from "../../../auth/schemas.js";
import { MilestoneCreateInput, MilestoneStore, PersonaCreateInput, PersonaStore } from "../../entities/index.js";
import { createSpecOnClient, type ProjectSpecQueryClient } from "../../workflow/projectSpec.js";
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
 * durable shell and phase receipts. This function provides the atomic graph
 * boundary that makes an interrupted graph phase safe to retry.
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
  return runWithOrgScope(pool, input.orgId, (client) =>
    buildEntityGraphOnClient(client, input, capture, slug, seed, repository, projectId, actor, scaffoldSpecs),
  );
}

async function buildEntityGraphOnClient(
  pool: ProjectSpecQueryClient,
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
    const spec = await createSpecOnClient(
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
        // spec definition. EVERY foundation spec (`scaffold` · `build` · `deploy`)
        // carries `specialize_seed` — each specializes a surface the composed seed
        // already shipped (the justfile recipes, the toolchain) for THIS product.
        // Behavior/schema specs created downstream omit it and default to `from_scratch`.
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
