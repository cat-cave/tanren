// gv-4: HTTP contract for the stacked-PR retarget safety view. Surfaces the
// complete persisted ancestor member vector + resolved walk target so operators
// and apex proofs can assert that merged transitive ancestors never remain as
// the PR base. Strict Zod shape — no UI affordances.

import { z } from "zod";
import { ancestorStackMemberSchema } from "../../engine/dag/ancestorStack.js";

export const StackRetargetMember = ancestorStackMemberSchema
  .extend({
    /** True when the member is genuinely merged (status + no unresolved speculative hold). */
    merged: z.boolean(),
  })
  .strict();
export type StackRetargetMember = z.infer<typeof StackRetargetMember>;

/**
 * Resolved stack-retarget view for one run. `missionNodeId` pins the apex proof
 * to gv-4 without inventing a new event type (reuse `merge.retargeted`).
 */
export const StackRetargetView = z
  .object({
    missionNodeId: z.literal("gv-4"),
    runId: z.string().min(1),
    projectId: z.string().min(1),
    orgId: z.string().min(1),
    /** True iff `ancestor_stack` is non-empty (sole speculative predicate). */
    speculative: z.boolean(),
    defaultBranch: z.string().min(1),
    /** Ordered ancestor member vector with per-member merge status. */
    members: z.array(StackRetargetMember),
    mergedSpecIds: z.array(z.string().min(1)),
    unmergedAncestors: z.array(z.string().min(1)),
    /** Walk target from {@link resolveStackRetarget} — PR base after this pass. */
    toBase: z.string().min(1),
    /** Stack after dropping genuinely-merged members. */
    remainingStack: z.array(ancestorStackMemberSchema),
  })
  .strict();
export type StackRetargetView = z.infer<typeof StackRetargetView>;
