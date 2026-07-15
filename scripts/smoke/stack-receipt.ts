import { linkSync, unlinkSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { HostPorts, StackContext } from "./stack-context.js";
import {
  safeError,
  type CandidateIdentity,
  type ExecutedBindings,
  type LifecycleLedger,
  type OnceFinalizer,
  type RuntimeIdentity,
} from "./stack-lifecycle.js";
import type { ContainerEvidence, ImageEvidence, ProvenanceSnapshot } from "./stack-provenance.js";
import type { RuntimeBinding } from "./stack-runtime.js";
import { assertArtifactPathSafe } from "./stack-paths.js";

export interface SmokeReceipt {
  status: "passed" | "failed";
  startedAt: string;
  finishedAt: string;
  context: {
    head?: string;
    tree?: string;
    project?: string;
    buildId?: string;
    nonce: string;
    root?: string;
    requestedPorts?: HostPorts;
    publishedPorts?: HostPorts;
  };
  runtime?: RuntimeIdentity;
  images?: Record<string, ImageEvidence>;
  containers?: Record<string, ContainerEvidence>;
  probes: Record<string, string>;
  credentials?: { sshHostKey: string; sshIdentity: string; ca: string; seedFingerprint?: string };
  planeSplitRunId?: string;
  planeSplitStatus?: string;
  platformCredentials: "seeded" | "not_configured" | "sentinel";
  cleanup: "completed" | "kept" | "failed" | "partial";
  cleanupErrors?: string[];
  stages: LifecycleLedger["stages"];
  artifacts?: { composeLogs?: string };
  error?: string;
  keepStackAuthorized?: boolean;
}

export interface SmokeState {
  candidate?: CandidateIdentity;
  startedAt: string;
  runtimeBase: string;
  context: StackContext;
  ledger: LifecycleLedger;
  receiptFinalizer: OnceFinalizer;
  bindings: ExecutedBindings;
  env: NodeJS.ProcessEnv;
  runtime?: RuntimeBinding;
  runtimeIdentity?: RuntimeIdentity;
  runtimeOwned: boolean;
  buildBase?: string;
  buildSource?: string;
  composeTouched: boolean;
  snapshot?: ProvenanceSnapshot;
  credentials?: SmokeReceipt["credentials"];
  planeSplitRunId?: string;
  planeSplitStatus?: string;
  platformCredentials: SmokeReceipt["platformCredentials"];
  seedCredential: string;
  seedFingerprint: string;
  checkoutFingerprint?: string;
  executionFingerprint?: string;
  failure?: Error;
  signalExitCode?: number;
  composeLogsPath?: string;
  keepAuthorized: boolean;
  cleanupFailed: boolean;
  resourcesClean: boolean;
  cleanupErrors: string[];
  fallbackReceiptPath: string;
  signalState: SmokeSignalState;
}

export interface SmokeSignalState {
  name?: "SIGINT" | "SIGTERM";
  exitCode?: number;
  sealed: boolean;
}

export function synchronizeSignalFailure(state: SmokeState): void {
  if (state.signalState.name === undefined) return;
  state.signalExitCode ??= state.signalState.exitCode;
  state.failure ??= new Error(`smoke interrupted by ${state.signalState.name}`);
}

export function buildReceipt(
  state: SmokeState,
  cleanupOverride?: SmokeReceipt["cleanup"],
  keepOverride?: boolean,
): SmokeReceipt {
  const { context, ledger, bindings } = state;
  const keepAuthorized = keepOverride ?? state.keepAuthorized;
  const cleanup = cleanupOverride ?? (keepAuthorized ? "kept" : state.cleanupFailed ? "failed" : "completed");
  const headReady = /^[0-9a-f]{40}$/u.test(context.head) && !/^0+$/u.test(context.head);
  return {
    status: state.failure === undefined ? "passed" : "failed",
    startedAt: state.startedAt,
    finishedAt: new Date().toISOString(),
    context: {
      nonce: context.nonce,
      ...(headReady
        ? {
            head: context.head,
            tree: context.tree,
            project: context.project,
            buildId: context.buildId,
            root: context.root,
            requestedPorts: context.requestedPorts,
          }
        : {}),
      ...(context.publishedPorts === undefined ? {} : { publishedPorts: context.publishedPorts }),
    },
    ...(state.runtimeIdentity === undefined ? {} : { runtime: state.runtimeIdentity }),
    ...(state.snapshot === undefined
      ? {}
      : Object.keys(state.snapshot.containers).length === 0
        ? { images: state.snapshot.images }
        : { images: state.snapshot.images, containers: state.snapshot.containers }),
    probes: bindings.snapshot(),
    ...(state.credentials === undefined ? {} : { credentials: state.credentials }),
    ...(state.planeSplitRunId === undefined ? {} : { planeSplitRunId: state.planeSplitRunId }),
    ...(state.planeSplitStatus === undefined ? {} : { planeSplitStatus: state.planeSplitStatus }),
    platformCredentials: state.platformCredentials,
    cleanup,
    ...(state.cleanupErrors.length === 0 ? {} : { cleanupErrors: [...state.cleanupErrors] }),
    stages: ledger.stages,
    ...(state.composeLogsPath === undefined ? {} : { artifacts: { composeLogs: state.composeLogsPath } }),
    ...(state.failure === undefined ? {} : { error: safeError(state.failure) }),
    keepStackAuthorized: keepAuthorized,
  };
}

interface PreparedReceipt {
  commit(): void;
  discard(): Promise<void>;
}

async function prepareReceipt(path: string, content: string): Promise<PreparedReceipt> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
  return {
    commit() {
      try {
        linkSync(temporary, path);
      } finally {
        try {
          unlinkSync(temporary);
        } catch {
          // The exclusive hard-link is the commit; a stale temp is harmless evidence.
        }
      }
    },
    discard: () => unlink(temporary).catch(() => {}),
  };
}

function terminalSignature(state: SmokeState, keep: boolean, cleanup: SmokeReceipt["cleanup"]): string {
  return JSON.stringify({
    failure: state.failure?.message,
    signal: state.signalExitCode,
    cleanup,
    cleanupErrors: state.cleanupErrors,
    keep,
  });
}

export async function publishTerminalReceipt(
  state: SmokeState,
  options: {
    cleanup?: SmokeReceipt["cleanup"];
    keep?: boolean;
    onPrimaryFailure?: (error: unknown) => Promise<void>;
  } = {},
): Promise<void> {
  await state.receiptFinalizer.run(async () => {
    if (state.ledger.terminalState().phase === "committed") return;
    let target = state.context.receiptPath;
    let primary = true;
    let keepRecoveryDone = false;
    const recoverPublicationFailure = async (error: unknown) => {
      if (!primary) throw error;
      primary = false;
      state.keepAuthorized = false;
      state.cleanupFailed = true;
      state.failure ??= error instanceof Error ? error : new Error(String(error));
      state.cleanupErrors.push(`receipt publication: ${safeError(error)}`);
      state.ledger.completeActiveForReceipt("failed", error);
      keepRecoveryDone = true;
      try {
        await options.onPrimaryFailure?.(error);
      } catch (cleanupError) {
        state.cleanupErrors.push(`receipt recovery: ${safeError(cleanupError)}`);
      }
      target = state.fallbackReceiptPath;
    };
    for (;;) {
      synchronizeSignalFailure(state);
      const keep =
        options.keep === true &&
        state.failure === undefined &&
        state.signalExitCode === undefined &&
        state.cleanupErrors.length === 0;
      if (options.keep === true && !keep && !keepRecoveryDone) {
        keepRecoveryDone = true;
        try {
          await options.onPrimaryFailure?.(new Error("KEEP_STACK authorization was revoked before receipt commit"));
        } catch (cleanupError) {
          state.cleanupFailed = true;
          state.cleanupErrors.push(`KEEP_STACK recovery: ${safeError(cleanupError)}`);
        }
        continue;
      }
      const cleanup = state.cleanupFailed ? "failed" : (options.cleanup ?? (keep ? "kept" : "completed"));
      const signature = terminalSignature(state, keep, cleanup);
      const json = `${JSON.stringify(buildReceipt(state, cleanup, keep), null, 2)}\n`;
      let prepared: PreparedReceipt;
      let safeTarget: string;
      try {
        safeTarget = await assertArtifactPathSafe(
          target,
          [state.context.runtimeDir, state.buildBase ?? ""],
          state.context.root,
        );
        target = safeTarget;
        prepared = await prepareReceipt(safeTarget, json);
        const revalidated = await assertArtifactPathSafe(
          safeTarget,
          [state.context.runtimeDir, state.buildBase ?? ""],
          state.context.root,
        );
        if (revalidated !== safeTarget) {
          await prepared.discard();
          throw new Error(`receipt path changed during publication: ${safeTarget} -> ${revalidated}`);
        }
      } catch (error) {
        await recoverPublicationFailure(error);
        continue;
      }
      synchronizeSignalFailure(state);
      const finalKeep =
        options.keep === true &&
        state.failure === undefined &&
        state.signalExitCode === undefined &&
        state.cleanupErrors.length === 0;
      const finalCleanup = state.cleanupFailed ? "failed" : (options.cleanup ?? (finalKeep ? "kept" : "completed"));
      if (terminalSignature(state, finalKeep, finalCleanup) !== signature) {
        await prepared.discard();
        continue;
      }
      state.ledger.beginTerminalPrepare();
      try {
        prepared.commit();
      } catch (error) {
        await recoverPublicationFailure(error);
        continue;
      }
      state.keepAuthorized = finalKeep;
      const exitCode = state.signalExitCode ?? (state.failure === undefined ? 0 : 1);
      state.ledger.commitTerminal(json, exitCode);
      state.signalState.sealed = true;
      try {
        process.stdout.write(`smoke receipt: ${target}\n`);
      } catch {
        // The terminal file and exit code are already sealed.
      }
      return;
    }
  });
}

export async function publishPartialReceipt(
  state: SmokeState,
  error: unknown,
  onPrimaryFailure?: (error: unknown) => Promise<void>,
): Promise<void> {
  state.failure ??= error instanceof Error ? error : new Error(String(error));
  await publishTerminalReceipt(state, { cleanup: state.cleanupFailed ? "failed" : "partial", onPrimaryFailure });
}
