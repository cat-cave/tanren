import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStackContext, resolveHostPorts } from "./stack-context.js";
import { ExecutedBindings, LifecycleLedger, OnceFinalizer } from "./stack-lifecycle.js";
import { publishTerminalReceipt, type SmokeState } from "./stack-receipt.js";

const roots: string[] = [];

afterEach(() => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture(): Promise<SmokeState> {
  const root = await mkdtemp(join(tmpdir(), "tanren-receipt-"));
  roots.push(root);
  return {
    startedAt: new Date().toISOString(),
    runtimeBase: join(root, "runtime-base"),
    context: createStackContext({
      root: "/candidate",
      head: "a".repeat(40),
      tree: "b".repeat(40),
      runId: "receipt",
      nonce: "c".repeat(32),
      runtimeBase: join(root, "runtime-base"),
      receiptPath: join(root, "receipt.json"),
      ports: resolveHostPorts({}, 1_200),
    }),
    ledger: new LifecycleLedger(),
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
    fallbackReceiptPath: join(root, "fallback.json"),
    signalState: { sealed: false },
  };
}

async function publish(state: SmokeState, keep: boolean, recover = async () => {}): Promise<void> {
  await state.ledger.run("publish-receipt", async () => {
    state.ledger.completeActiveForReceipt("passed");
    await publishTerminalReceipt(state, { keep, onPrimaryFailure: recover });
  });
}

describe("terminal receipt commit", () => {
  it("authorizes KEEP_STACK only in the sealed passed receipt", async () => {
    const state = await fixture();
    await publish(state, true);
    const receipt = JSON.parse(await readFile(state.context.receiptPath, "utf8")) as {
      status: string;
      cleanup: string;
      keepStackAuthorized: boolean;
    };
    expect(receipt).toMatchObject({ status: "passed", cleanup: "kept", keepStackAuthorized: true });
    expect(state.keepAuthorized).toBe(true);
    expect(state.signalState.sealed).toBe(true);
    expect(state.ledger.terminalState().exitCode).toBe(0);
  });

  it("treats a stale primary collision as failure, revokes KEEP_STACK, cleans, and uses one fallback", async () => {
    const state = await fixture();
    await writeFile(state.context.receiptPath, "stale\n");
    let recoveries = 0;
    await publish(state, true, async () => {
      recoveries += 1;
      state.resourcesClean = true;
    });
    expect(await readFile(state.context.receiptPath, "utf8")).toBe("stale\n");
    const fallback = JSON.parse(await readFile(state.fallbackReceiptPath, "utf8")) as {
      status: string;
      cleanupErrors: string[];
      keepStackAuthorized: boolean;
      stages: { name: string; status: string }[];
    };
    expect(fallback.status).toBe("failed");
    expect(fallback.keepStackAuthorized).toBe(false);
    expect(fallback.cleanupErrors.join(" ")).toMatch(/receipt publication/u);
    expect(fallback.stages.at(-1)).toMatchObject({ name: "publish-receipt", status: "failed" });
    expect(recoveries).toBe(1);
    expect(state.ledger.terminalState().exitCode).toBe(1);
  });

  it("revokes provisional KEEP_STACK on SIGTERM before commit and seals a matching exit code", async () => {
    const state = await fixture();
    state.signalState = { name: "SIGTERM", exitCode: 143, sealed: false };
    let recovered = false;
    await publish(state, true, async () => {
      recovered = true;
      state.resourcesClean = true;
    });
    const receipt = JSON.parse(await readFile(state.context.receiptPath, "utf8")) as {
      status: string;
      keepStackAuthorized: boolean;
    };
    expect(receipt).toMatchObject({ status: "failed", keepStackAuthorized: false });
    expect(recovered).toBe(true);
    expect(state.ledger.terminalState().exitCode).toBe(143);
  });
});
