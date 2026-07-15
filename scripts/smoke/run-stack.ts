import {
  ExecutedBindings,
  fingerprintText,
  LifecycleLedger,
  OnceFinalizer,
  safeError,
  type BootstrapInstallEvidence,
} from "./stack-lifecycle.js";
import {
  publishPartialReceipt,
  synchronizeSignalFailure,
  type SmokeSignalState,
  type SmokeState,
} from "./stack-receipt.js";
import { emergencyCleanup } from "./stack-cleanup.js";
import { finalizeSmoke } from "./stack-finalize.js";
import { executeSmoke } from "./stack-stages.js";
import type { CandidateIdentity } from "./stack-lifecycle.js";
import type { StackContext } from "./stack-context.js";

export interface PreparedSmokeRun {
  startedAt: string;
  runtimeBase: string;
  context: StackContext;
  candidate: CandidateIdentity;
  buildBase: string;
  buildSource: string;
  checkoutFingerprint: string;
  executionFingerprint: string;
  bootstrapInstall?: BootstrapInstallEvidence;
  fallbackReceiptPath: string;
  abortController: AbortController;
  signalState: SmokeSignalState;
  ambient: NodeJS.ProcessEnv;
}

function errorValue(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function createState(prepared: PreparedSmokeRun): SmokeState {
  const nonceSeed = `smoke-sentinel-${prepared.context.nonce}`;
  return {
    candidate: prepared.candidate,
    startedAt: prepared.startedAt,
    runtimeBase: prepared.runtimeBase,
    context: prepared.context,
    ledger: new LifecycleLedger(prepared.ambient["TANREN_SMOKE_FAIL_STAGE"], prepared.abortController),
    receiptFinalizer: new OnceFinalizer(),
    bindings: new ExecutedBindings(),
    env: { ...prepared.ambient },
    runtimeOwned: false,
    buildBase: prepared.buildBase,
    buildSource: prepared.buildSource,
    composeTouched: false,
    platformCredentials: "not_configured",
    seedCredential: nonceSeed,
    seedFingerprint: fingerprintText(nonceSeed),
    checkoutFingerprint: prepared.checkoutFingerprint,
    executionFingerprint: prepared.executionFingerprint,
    bootstrapInstall: prepared.bootstrapInstall,
    keepAuthorized: false,
    cleanupFailed: false,
    resourcesClean: false,
    cleanupErrors: [],
    fallbackReceiptPath: prepared.fallbackReceiptPath,
    signalState: prepared.signalState,
  };
}

/** Run only after stack-bootstrap has archived and verified the candidate tree. */
export async function runPreparedSmoke(prepared: PreparedSmokeRun): Promise<number> {
  const state = createState(prepared);
  try {
    try {
      synchronizeSignalFailure(state);
      await executeSmoke(state);
    } catch (error) {
      state.failure ??= errorValue(error);
    }
    synchronizeSignalFailure(state);
    try {
      await finalizeSmoke(state);
    } catch (error) {
      state.failure ??= errorValue(error);
      state.cleanupFailed = true;
      if (state.ledger.terminalState().phase !== "committed") {
        await publishPartialReceipt(state, state.failure, () => emergencyCleanup(state));
      }
    }
  } finally {
    synchronizeSignalFailure(state);
    if (state.ledger.terminalState().phase !== "committed") {
      try {
        await emergencyCleanup(state);
      } catch (error) {
        state.cleanupFailed = true;
        state.cleanupErrors.push(`terminal recovery: ${safeError(error)}`);
        state.failure ??= errorValue(error);
      }
      await publishPartialReceipt(state, state.failure ?? new Error("smoke exited without terminal receipt"));
    }
  }
  const terminal = state.ledger.terminalState();
  const exitCode = terminal.exitCode ?? state.signalExitCode ?? (state.failure === undefined ? 0 : 1);
  if (state.failure !== undefined) process.stderr.write(`${state.failure.message}\n`);
  return exitCode;
}
