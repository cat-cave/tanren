// Derive helpers split out of `derive.ts` to keep it under the 500-line cap:
//   - `deriveBehaviorSpec`: create one behavior spec + persist+link the behavior row.
//   - `resumeDerivedProject`: the idempotent-resume result for a retried derive whose
//     project already exists (audit §3.10).
// Both are pure compositions over the existing entity-creation paths — no new write
// surface, just a relocation behind the per-file line cap.

import type pg from "pg";
import type { ActorContext } from "../../../auth/schemas.js";
import { BehaviorCreateInput, BehaviorStore } from "../../entities/behaviors.js";
import { MilestoneStore } from "../../entities/milestones.js";
import { parseGitHubRepository } from "../../providers/github.js";
import { createSpec, type SpecContract } from "../../workflow/projectSpec.js";
import type { DeriveResult } from "./derive.js";
import type { CaptureBehavior } from "./types.js";

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
