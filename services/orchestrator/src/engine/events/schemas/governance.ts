import { z } from "zod";
import { AuditPostureConfig } from "../../config/auditPostureConfig.js";

// GV-1: the durable fact for an actual audit-posture transition. The event
// envelope already carries org_id + project_id, so the payload contains only
// the non-secret mutation evidence needed to explain the decision: who made it
// and the exact validated posture before/after the successful CAS.
export const GovernanceAuditPostureUpdatedPayload = z
  .object({
    actorUserId: z.string().min(1),
    previous: AuditPostureConfig,
    current: AuditPostureConfig,
  })
  .strict();

export const governanceEventRegistry = {
  "governance.audit_posture.updated": GovernanceAuditPostureUpdatedPayload,
} as const satisfies Record<string, z.ZodTypeAny>;
