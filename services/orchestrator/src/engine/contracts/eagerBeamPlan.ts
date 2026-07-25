// mq-8's frozen, CAS-persisted description of one speculative integration beam.
// The plan is evidence of an exact local build candidate, never merge authority.

import { z } from "zod";
import { ancestorStackSchema } from "../dag/ancestorStack.js";
import { memberKey, proofReuseKey, type IntegrationNodeMember, type ProofReuseKeyInput } from "./integrationNodes.js";

const fullSha = z.string().regex(/^[0-9a-f]{40}$/u);
const nonBlank = z.string().trim().min(1);

const memberSchema = z
  .object({
    specId: nonBlank,
    runId: nonBlank,
    branch: nonBlank,
    headSha: fullSha,
  })
  .strict();

const proofReuseInputSchema = z
  .object({
    memberKey: z.string().regex(/^[0-9a-f]{64}$/u),
    gateConfigHash: z.string().regex(/^[0-9a-f]{64}$/u),
    policyVersion: nonBlank,
    runnerImage: nonBlank,
    appEnvHash: z.string().regex(/^[0-9a-f]{64}$/u),
    quarantineVersion: nonBlank,
  })
  .strict();

/** Frozen, exact build candidate. Every SHA is a full git SHA and every proof input is present. */
export const eagerBeamPlanV1Schema = z
  .object({
    schemaVersion: z.literal("eager_beam.v1"),
    beamWidth: z.number().int().positive(),
    rank: z.number().int().positive(),
    orgId: nonBlank,
    projectId: nonBlank,
    frontierRunId: nonBlank,
    frontierSpecId: nonBlank,
    baseBranch: nonBlank,
    baseSha: fullSha,
    members: z.array(memberSchema).min(1),
    ancestorStack: ancestorStackSchema,
    expectedMemberKey: z.string().regex(/^[0-9a-f]{64}$/u),
    proofReuseInput: proofReuseInputSchema,
    integration: z.object({ ref: nonBlank, headSha: fullSha, treeHash: fullSha }).strict(),
    fragmentEvidenceDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  })
  .strict()
  .superRefine((plan, context) => {
    const expectedMemberKey = memberKey(
      plan.baseSha,
      plan.members.map((member) => member.headSha),
    );
    if (plan.expectedMemberKey !== expectedMemberKey) {
      context.addIssue({
        code: "custom",
        path: ["expectedMemberKey"],
        message: "does not bind the exact base and member SHA order",
      });
    }
    if (plan.proofReuseInput.memberKey !== plan.expectedMemberKey) {
      context.addIssue({
        code: "custom",
        path: ["proofReuseInput", "memberKey"],
        message: "must equal expectedMemberKey",
      });
    }
    const expectedReuseKey = proofReuseKey(plan.proofReuseInput);
    if (expectedReuseKey.length !== 64) {
      context.addIssue({ code: "custom", path: ["proofReuseInput"], message: "must form a complete proof reuse key" });
    }
    const frontier = plan.members.at(-1);
    if (frontier?.runId !== plan.frontierRunId || frontier.specId !== plan.frontierSpecId) {
      context.addIssue({ code: "custom", path: ["members"], message: "must end with the frontier run and spec" });
    }
    const ancestorMembers = plan.members.slice(0, -1);
    if (JSON.stringify(ancestorMembers) !== JSON.stringify(plan.ancestorStack)) {
      context.addIssue({
        code: "custom",
        path: ["ancestorStack"],
        message: "must exactly match the ordered ancestor members",
      });
    }
  });

export type EagerBeamPlanV1 = z.infer<typeof eagerBeamPlanV1Schema>;

/** Build and validate a plan; callers never supply a score or scope. */
export function createEagerBeamPlan(input: {
  beamWidth: number;
  rank: number;
  orgId: string;
  projectId: string;
  frontierRunId: string;
  frontierSpecId: string;
  baseBranch: string;
  baseSha: string;
  ancestorStack: ReadonlyArray<IntegrationNodeMember>;
  frontier: IntegrationNodeMember;
  proofReuseInput: ProofReuseKeyInput;
  integration: { ref: string; headSha: string; treeHash: string };
  fragmentEvidenceDigest: string;
}): EagerBeamPlanV1 {
  const members = [...input.ancestorStack, input.frontier];
  const expectedMemberKey = memberKey(
    input.baseSha,
    members.map((member) => member.headSha),
  );
  return eagerBeamPlanV1Schema.parse({
    schemaVersion: "eager_beam.v1",
    beamWidth: input.beamWidth,
    rank: input.rank,
    orgId: input.orgId,
    projectId: input.projectId,
    frontierRunId: input.frontierRunId,
    frontierSpecId: input.frontierSpecId,
    baseBranch: input.baseBranch,
    baseSha: input.baseSha,
    members,
    ancestorStack: input.ancestorStack,
    expectedMemberKey,
    proofReuseInput: { ...input.proofReuseInput, memberKey: expectedMemberKey },
    integration: input.integration,
    fragmentEvidenceDigest: input.fragmentEvidenceDigest,
  });
}
