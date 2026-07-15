import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createStackContext, resolveHostPorts } from "./stack-context.js";
import { DB_GATES, SMOKE_STAGES, STAGE_REGISTRY } from "./stack-gates.js";
import { DB_STAGE_RUNNERS } from "./stack-db-stage-runners.js";
import { ExecutedBindings, LifecycleLedger, OnceFinalizer } from "./stack-lifecycle.js";
import { finalizeSmoke } from "./stack-finalize.js";
import { synchronizeSignalFailure, type SmokeState } from "./stack-receipt.js";
import { executeSmoke, STAGE_RUNNERS } from "./stack-stages.js";

function state(failureStage?: string, artifactRoot = "/tmp/tanren-stage-test"): SmokeState {
  const context = createStackContext({
    root: process.cwd(),
    head: "a".repeat(40),
    tree: "b".repeat(40),
    runId: "stage-test",
    nonce: "c".repeat(32),
    runtimeBase: join(artifactRoot, "runtime"),
    receiptPath: join(artifactRoot, "receipt.json"),
    ports: resolveHostPorts({}, 1_200),
  });
  return {
    startedAt: new Date().toISOString(),
    runtimeBase: join(artifactRoot, "runtime"),
    context,
    ledger: new LifecycleLedger(failureStage),
    receiptFinalizer: new OnceFinalizer(),
    bindings: new ExecutedBindings(),
    env: {},
    runtimeOwned: false,
    composeTouched: false,
    platformCredentials: "not_configured",
    seedCredential: "sentinel",
    seedFingerprint: "fingerprint",
    keepAuthorized: false,
    cleanupFailed: false,
    resourcesClean: false,
    cleanupErrors: [],
    fallbackReceiptPath: join(artifactRoot, "fallback.json"),
    signalState: { sealed: false },
  };
}

async function walk(candidate: SmokeState): Promise<void> {
  try {
    await executeSmoke(candidate);
  } catch (error) {
    candidate.failure ??= error instanceof Error ? error : new Error(String(error));
  }
  await finalizeSmoke(candidate).catch(() => {});
  synchronizeSignalFailure(candidate);
}

describe("production STAGE_RUNNERS exact completeness", () => {
  it("pins runners 1:1 with STAGE_REGISTRY (no casts; removing a runner fails this pin)", () => {
    const runnerKeys = Object.keys(STAGE_RUNNERS).sort();
    const registryKeys = [...SMOKE_STAGES].sort();
    expect(runnerKeys).toEqual(registryKeys);
    expect(runnerKeys).toHaveLength(56);
    expect(Object.keys(DB_STAGE_RUNNERS).sort()).toEqual([...DB_GATES].sort());
    for (const stage of STAGE_REGISTRY) {
      expect(typeof STAGE_RUNNERS[stage.name]).toBe("function");
    }
  });
});

describe("production registry failure and signal injection", () => {
  it("drives the actual coordinator failure boundary at every registered stage", async () => {
    const originals = { ...STAGE_RUNNERS };
    try {
      for (const stage of STAGE_REGISTRY) STAGE_RUNNERS[stage.name] = async () => {};
      for (const target of STAGE_REGISTRY) {
        const candidate = state(target.name);
        await walk(candidate);
        expect(candidate.ledger.stages.find((stage) => stage.name === target.name)).toMatchObject({
          status: "failed",
        });
        expect(() => candidate.ledger.assertFailureInjectionObserved()).not.toThrow();
        expect(candidate.failure?.message).toContain(`injected smoke failure at ${target.name}`);
      }
    } finally {
      Object.assign(STAGE_RUNNERS, originals);
    }
  });

  it("propagates SIGTERM through the actual coordinator boundary at every stage", async () => {
    const originals = { ...STAGE_RUNNERS };
    try {
      for (const target of STAGE_REGISTRY) {
        for (const stage of STAGE_REGISTRY) STAGE_RUNNERS[stage.name] = async () => {};
        STAGE_RUNNERS[target.name] = async (candidate) => {
          candidate.signalState.name = "SIGTERM";
          candidate.signalState.exitCode = 143;
          candidate.ledger.abort("SIGTERM");
          throw candidate.ledger.abortController.signal.reason;
        };
        const candidate = state();
        await walk(candidate);
        expect(candidate.ledger.stages.find((stage) => stage.name === target.name)?.status).toMatch(/aborted|failed/u);
        expect(candidate.signalExitCode).toBe(143);
        expect(candidate.failure?.message).toMatch(/SIGTERM/u);
      }
    } finally {
      Object.assign(STAGE_RUNNERS, originals);
    }
  });

  it("seals a failed receipt and nonzero exit when a production finalizer fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "tanren-finalizer-failure-"));
    const originals = { ...STAGE_RUNNERS };
    try {
      const publish = STAGE_RUNNERS["publish-receipt"];
      for (const stage of STAGE_REGISTRY) STAGE_RUNNERS[stage.name] = async () => {};
      STAGE_RUNNERS["publish-receipt"] = publish;
      const candidate = state("remove-runtime-dir", root);
      await walk(candidate);
      const receipt = JSON.parse(await readFile(candidate.context.receiptPath, "utf8")) as {
        status: string;
        cleanup: string;
        cleanupErrors: string[];
      };
      expect(receipt).toMatchObject({ status: "failed", cleanup: "failed" });
      expect(receipt.cleanupErrors.join(" ")).toMatch(/remove-runtime-dir/u);
      expect(candidate.ledger.terminalState().exitCode).toBe(1);
    } finally {
      Object.assign(STAGE_RUNNERS, originals);
      await rm(root, { recursive: true, force: true });
    }
  });
});
