import type { SensitivityRule } from "./sensitivity.js";

// GV-1: user ids and policy knobs are governance audit evidence, not secrets.
// Keep every leaf explicit so the event-field coverage gate fails on schema
// growth until the new field receives a deliberate classification.
export const governanceSensitivityRules: SensitivityRule[] = [
  { eventName: "governance.audit_posture.updated", path: "actorUserId", tag: "public" },
  { eventName: "governance.audit_posture.updated", path: "previous.blockReviewAt", tag: "public" },
  { eventName: "governance.audit_posture.updated", path: "previous.p2p3Handling", tag: "public" },
  { eventName: "governance.audit_posture.updated", path: "previous.autonomousRemediation", tag: "public" },
  { eventName: "governance.audit_posture.updated", path: "current.blockReviewAt", tag: "public" },
  { eventName: "governance.audit_posture.updated", path: "current.p2p3Handling", tag: "public" },
  { eventName: "governance.audit_posture.updated", path: "current.autonomousRemediation", tag: "public" },
];
