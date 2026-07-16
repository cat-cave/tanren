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
import { ProjectDerivationStore, type ProjectDerivationRow } from "../../repositories/projectDerivations.js";
import {
  buildDerivationDesignPlan,
  type DerivationDesignPlan,
  type DerivationDesignResult,
} from "./deriveDesignContract.js";

/** Graph rows and their durable receipt commit or roll back as one org-scoped unit. */
export async function buildEntityGraphWithReceipt(
  pool: pg.Pool,
  input: DeriveInput,
  capture: InterviewCapture,
  slug: string,
  seed: SeededTemplate,
  repository: CreatedRepository | undefined,
  projectId: string,
  actor: ActorContext,
  scaffoldSpecs: ScaffoldSpecDef[],
  operation: ProjectDerivationRow,
  design: DerivationDesignResult,
): Promise<{ graph: DeriveResult; operation: ProjectDerivationRow }> {
  const designPlan = buildDerivationDesignPlan(capture, operation.idempotencyFingerprint);
  return runWithOrgScope(pool, input.orgId, async (client) => {
    const graph = await buildEntityGraphOnClient(
      client,
      input,
      capture,
      slug,
      seed,
      repository,
      projectId,
      actor,
      scaffoldSpecs,
      designPlan,
      design,
    );
    const updated = await ProjectDerivationStore.recordReceiptOnClient(client, operation, "graph", graph, "graph");
    return { graph, operation: updated };
  });
}

export async function buildEntityGraphOnClient(
  pool: ProjectSpecQueryClient,
  input: DeriveInput,
  capture: InterviewCapture,
  slug: string,
  seed: SeededTemplate,
  repository: CreatedRepository | undefined,
  projectId: string,
  actor: ActorContext,
  scaffoldSpecs: ScaffoldSpecDef[],
  designPlan: DerivationDesignPlan,
  design: DerivationDesignResult,
): Promise<DeriveResult> {
  // 1 · personas (project-scoped).
  const personaIdByName = new Map<string, string>();
  for (const persona of capture.personas) {
    const personaKey = persona.name.trim().toLowerCase();
    const plannedPersonaId = designPlan.personaIdByName.get(personaKey);
    if (plannedPersonaId === undefined) throw new Error(`missing planned identity for persona '${persona.name}'`);
    const row = await PersonaStore.create(
      pool,
      PersonaCreateInput.parse({
        id: plannedPersonaId,
        scope: "project",
        orgId: input.orgId,
        projectId,
        name: persona.name,
        description: persona.description,
        ...(persona.surface.trim() !== "" && { metadata: { surface: persona.surface } }),
      }),
      actor,
    );
    personaIdByName.set(personaKey, row.id);
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
    plannedBehaviorIdByKey: designPlan.behaviorIdByKey,
    actor,
  });
  specIds.push(...ifaceResult.specIds);
  milestoneIds.push(...ifaceResult.milestoneIds);
  const behaviorIds = ifaceResult.behaviorIds;

  // 4 · design contract.
  const designContract = await persistDesignContract(pool, {
    orgId: input.orgId,
    projectId,
    design,
  });

  return {
    projectId,
    projectName: slug,
    ...(repository === undefined ? {} : { repository }),
    specIds,
    personaIds: [...personaIdByName.values()],
    behaviorIds,
    milestoneIds,
    designContract,
    templateSeed: seed,
  };
}
