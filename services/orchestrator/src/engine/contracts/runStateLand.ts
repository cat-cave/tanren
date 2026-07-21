import type { AuditEnvelope } from "../events/schemas/audit.js";
import type { RuntimeOutcomeRecord } from "./runtimeOutcome.js";

/** Durable land finalize (§5): `merge.completed` + guarded spec `merged` in one org tx. */
export interface FinalizeLandInput {
  /** The owning run's org, so the finalize transaction is org-scoped server-side (or in-process). */
  orgId: string;
  runId: string;
  specId: string;
  projectId: string;
  taskId: string;
  prUrl: string;
  prNumber: number;
  /** Labels the `merge.completed` event (`direct_merge` / `native_queue`). */
  integration: "direct_merge" | "native_queue";
  /** The host sha `main` advanced to (recorded as `mergeSha` on `merge.completed`). */
  mergeSha: string;
  /** The pre-CAS authority decision whose transactional delivery outbox this land creates. */
  authorityDecisionId: string;
  /** The policy version + initiating/approving actors stamped onto `merge.completed`. */
  auditEnvelope: AuditEnvelope;
  /** Present only for a V2 authority land; written atomically with merge completion. */
  runtimeOutcome?: RuntimeOutcomeRecord;
}
