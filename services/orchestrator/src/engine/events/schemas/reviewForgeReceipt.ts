import { z } from "zod";

const forgeHeadSha = z.string().regex(/^[0-9a-fA-F]{40}$/u, "forge receipt headSha must be exactly 40 hex");
const reviewerPrincipal = z
  .object({
    kind: z.enum(["agent_profile", "user", "team"]),
    name: z.string().min(1).max(256),
  })
  .strict();

const reviewApprovedBase = z
  .object({
    prUrl: z.string(),
    prNumber: z.number().int(),
    reviewer: z.string().optional(),
    reviewerPrincipal: reviewerPrincipal.optional(),
  })
  .strict();
const reviewApprovedReceipt = z
  .object({
    prUrl: z.string(),
    prNumber: z.number().int(),
    reviewer: z.string().min(1),
    reviewerPrincipal: reviewerPrincipal.optional(),
    forgeReviewId: z.string().min(1),
    forgeReviewState: z.literal("approved"),
    forgeReviewUrl: z.string().min(1),
    headSha: forgeHeadSha,
  })
  .strict();
export const ReviewApprovedPayload = z.union([reviewApprovedReceipt, reviewApprovedBase]);

const reviewChangesBase = z
  .object({
    prUrl: z.string(),
    prNumber: z.number().int(),
    reviewer: z.string().optional(),
    reviewerPrincipal: reviewerPrincipal.optional(),
    message: z.string().optional(),
  })
  .strict();
const reviewChangesReceipt = z
  .object({
    prUrl: z.string(),
    prNumber: z.number().int(),
    reviewer: z.string().min(1),
    reviewerPrincipal: reviewerPrincipal.optional(),
    message: z.string().optional(),
    forgeReviewId: z.string().min(1),
    forgeReviewState: z.literal("changes_requested"),
    forgeReviewUrl: z.string().min(1),
    headSha: forgeHeadSha,
  })
  .strict();
export const ReviewChangesRequestedPayload = z.union([reviewChangesReceipt, reviewChangesBase]);
