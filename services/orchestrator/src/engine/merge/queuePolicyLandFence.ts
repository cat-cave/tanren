// Runtime guard for the required queue-policy land fence. The interface keeps
// implementations honest at compile time; this guard also rejects an unsafe
// legacy/runtime adapter that omitted the method instead of silently landing.
import type { MergeQueueModel } from "../contracts/mergeCoordinator.js";

export async function confirmQueuePolicyBeforeLand(queue: MergeQueueModel, queueId: string): Promise<boolean> {
  const confirm: unknown = queue.confirmPolicyBeforeLand;
  if (typeof confirm !== "function") return false;
  try {
    return (await confirm.call(queue, queueId)) === true;
  } catch {
    return false;
  }
}
