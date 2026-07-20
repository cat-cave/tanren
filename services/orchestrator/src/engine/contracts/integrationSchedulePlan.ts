// Frozen read contract for the merge queue's semantic scheduling proposal. A plan
// is explanatory only: it neither claims queue ownership nor carries land authority.

import { z } from "zod";

export const INTEGRATION_SCHEDULE_PLAN_VERSION = "integration_schedule_plan.v1" as const;

export const SemanticPartitionClassSchema = z.enum([
  "path",
  "api",
  "behavior",
  "design",
  "migration",
  "shared",
  "all_scopes",
]);
export type SemanticPartitionClass = z.infer<typeof SemanticPartitionClassSchema>;

const NonBlank = z.string().trim().min(1);
const Sha = z.string().regex(/^[0-9a-f]{40}$/u);

const ScheduleMemberSchema = z
  .object({
    queueId: NonBlank,
    runId: NonBlank,
    specId: NonBlank,
    baseSha: Sha,
    headSha: Sha,
  })
  .strict();

const SemanticPartitionSchema = z
  .object({
    queueId: NonBlank,
    runId: NonBlank,
    specId: NonBlank,
    fingerprint: NonBlank,
    classes: z.array(SemanticPartitionClassSchema).min(1),
    scopes: z.array(NonBlank).min(1),
    conservative: z.boolean(),
  })
  .strict();

const ActiveLeaseSchema = z
  .object({
    partitionId: NonBlank,
    leaseOwner: NonBlank,
    leaseEpoch: z.number().int().min(1),
    generation: z.number().int().min(0),
    fingerprint: NonBlank,
  })
  .strict();

const DynamicCapacitySchema = z
  .object({
    minimum: z.number().int().min(1),
    maximum: z.number().int().min(1),
    selected: z.number().int().min(0),
    queueAgeUnits: z.number().int().min(0),
    availableCapacity: z.number().int().min(0),
    reusableProofNodeCount: z.number().int().min(0),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.minimum > value.maximum) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "minimum capacity exceeds maximum capacity" });
    }
    if (value.selected > value.maximum) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "selected capacity exceeds maximum capacity" });
    }
  });

/** Strict, versioned wire shape of one current scheduler decision. */
export const IntegrationSchedulePlanV1Schema = z
  .object({
    schemaVersion: z.literal(INTEGRATION_SCHEDULE_PLAN_VERSION),
    snapshot: z
      .object({
        projectId: NonBlank,
        identity: NonBlank,
        members: z.array(ScheduleMemberSchema),
      })
      .strict(),
    proposedRunIds: z.array(NonBlank),
    semanticPartitions: z.array(SemanticPartitionSchema),
    activeLeases: z.array(ActiveLeaseSchema),
    dynamicCapacity: DynamicCapacitySchema,
    blockers: z.array(NonBlank),
    conservativeReason: NonBlank.optional(),
  })
  .strict();

export type IntegrationSchedulePlanV1 = z.infer<typeof IntegrationSchedulePlanV1Schema>;

/** Parse and deeply freeze an untrusted schedule response before it crosses a read boundary. */
export function parseIntegrationSchedulePlanV1(input: unknown): IntegrationSchedulePlanV1 {
  const plan = IntegrationSchedulePlanV1Schema.parse(input);
  return freezePlan(plan);
}

function freezePlan(plan: IntegrationSchedulePlanV1): IntegrationSchedulePlanV1 {
  for (const member of plan.snapshot.members) Object.freeze(member);
  Object.freeze(plan.snapshot.members);
  Object.freeze(plan.snapshot);
  for (const partition of plan.semanticPartitions) {
    Object.freeze(partition.classes);
    Object.freeze(partition.scopes);
    Object.freeze(partition);
  }
  Object.freeze(plan.semanticPartitions);
  for (const lease of plan.activeLeases) Object.freeze(lease);
  Object.freeze(plan.activeLeases);
  Object.freeze(plan.proposedRunIds);
  Object.freeze(plan.blockers);
  Object.freeze(plan.dynamicCapacity);
  return Object.freeze(plan);
}
