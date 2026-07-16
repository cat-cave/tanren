import { createHash } from "node:crypto";
import type { RecoveryOwnedSettleInput } from "../contracts/runStateWriter.js";

/** Stable exact receipt identity stored on the canonical old-candidate dequeue event. */
export function recoveryReceiptFingerprint(input: RecoveryOwnedSettleInput): string {
  const run = input.receipt.run;
  const fields = [
    "recovery-owned-settle:v1",
    input.orgId,
    input.projectId,
    input.specId,
    input.runId,
    input.queueId,
    input.receipt.kind,
    run.kind,
    run.kind === "enqueued" ? run.replanRunId : run.runId,
    run.kind === "enqueued" ? run.plannerTaskId : "",
    input.reason,
  ];
  const digest = createHash("sha256").update(JSON.stringify(fields)).digest("hex");
  return `recovery-owned-settle:v1:${digest}`;
}
