import { emergencyCleanup } from "./stack-cleanup.js";
import { STAGE_REGISTRY } from "./stack-gates.js";
import { safeError } from "./stack-lifecycle.js";
import { synchronizeSignalFailure, type SmokeState } from "./stack-receipt.js";
import { runStage } from "./stack-stages.js";

function recordFinalizerFailure(state: SmokeState, label: string, error: unknown): void {
  const failure = error instanceof Error ? error : new Error(String(error));
  state.failure ??= failure;
  state.cleanupFailed = true;
  state.keepAuthorized = false;
  state.cleanupErrors.push(`${label}: ${safeError(failure)}`);
}

export async function finalizeSmoke(state: SmokeState): Promise<void> {
  const finalizers = STAGE_REGISTRY.filter((entry) => entry.kind === "finalize");
  for (const stage of finalizers) {
    synchronizeSignalFailure(state);
    if (stage.name === "publish-receipt") {
      try {
        state.ledger.assertFailureInjectionObserved("publish-receipt");
      } catch (error) {
        state.failure ??= error instanceof Error ? error : new Error(String(error));
      }
      if (state.cleanupFailed) {
        try {
          await emergencyCleanup(state);
        } catch {
          // Individual recovery failures are already retained in cleanupErrors.
        }
      }
    }
    try {
      await runStage(state, stage.name, { allowWhenAborted: true });
    } catch (error) {
      recordFinalizerFailure(state, stage.name, error);
      if (stage.name === "teardown-stack" || stage.name === "attest-resource-leaks") {
        try {
          await emergencyCleanup(state);
        } catch {
          // Individual recovery failures are already retained in cleanupErrors.
        }
      }
      if (stage.name === "publish-receipt") {
        try {
          await emergencyCleanup(state);
        } catch {
          // Individual recovery failures are already retained in cleanupErrors.
        }
        state.ledger.assertFailureInjectionObserved();
        throw error;
      }
      // Continue so every owned resource gets a cleanup attempt before publication.
    }
  }
}
