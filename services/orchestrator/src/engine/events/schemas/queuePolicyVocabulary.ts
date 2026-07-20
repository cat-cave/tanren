import { z } from "zod";

const QueueHoldReason = z.enum([
  "missing_policy",
  "malformed_policy",
  "route_unmatched",
  "window_closed",
  "blackout",
  "partition_not_active",
  "policy_revised",
]);

export const queuePolicyEventRegistry = {
  "merge.policy.revised": z
    .object({
      policyId: z.string().min(1),
      version: z.number().int().positive(),
      compiledHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    })
    .strict(),
  "merge.queue.command_applied": z
    .object({
      commandId: z.string().min(1),
      command: z.string().min(1),
      idempotencyKey: z.string().min(1),
      result: z.unknown(),
    })
    .strict(),
  "merge.queue.window_changed": z
    .object({
      windowId: z.string().min(1),
      name: z.string().min(1),
      kind: z.enum(["allow", "blackout"]),
      action: z.enum(["created", "deleted"]),
    })
    .strict(),
  "merge.queue.admission_held": z
    .object({
      queueId: z.string().min(1),
      reason: QueueHoldReason,
      phase: z.enum(["admission", "coordinate", "claim"]),
    })
    .strict(),
} as const;
