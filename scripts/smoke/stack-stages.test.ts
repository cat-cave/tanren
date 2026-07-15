import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createStackContext, resolveHostPorts, withDiscoveredPorts } from "./stack-context.js";
import { DB_GATES, SMOKE_STAGES, STAGE_REGISTRY } from "./stack-gates.js";
import { DB_STAGE_RUNNERS } from "./stack-db-stage-runners.js";
import { ExecutedBindings, LifecycleLedger, OnceFinalizer } from "./stack-lifecycle.js";
import { finalizeSmoke } from "./stack-finalize.js";
import { synchronizeSignalFailure, type SmokeState } from "./stack-receipt.js";
import { executeSmoke, runStage, STAGE_RUNNERS } from "./stack-stages.js";

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
  it("waits for finite delayed Compose logs instead of aborting a quiet child", async () => {
    const root = await mkdtemp(join(tmpdir(), "tanren-compose-logs-"));
    const runtime = join(root, "runtime.cjs");
    try {
      await writeFile(
        runtime,
        `#!${process.execPath}\nsetTimeout(()=>process.stdout.write('delayed compose log\\n'),150);\n`,
        { mode: 0o755 },
      );
      await chmod(runtime, 0o755);
      const candidate = state(undefined, root);
      candidate.failure = new Error("primary failure");
      candidate.composeTouched = true;
      candidate.runtime = { provider: "podman", executable: runtime, socket: join(root, "fake.sock") };
      candidate.env = { ...process.env };
      await mkdir(candidate.context.runtimeDir, { recursive: true });
      await writeFile(candidate.context.explicitEnvPath, "");

      await runStage(candidate, "capture-compose-logs", { allowWhenAborted: true });

      expect(await readFile(`${candidate.context.receiptPath}.compose.log`, "utf8")).toContain("delayed compose log");
      expect(candidate.ledger.stages.at(-1)).toMatchObject({ name: "capture-compose-logs", status: "passed" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves cleanup inputs until resource emptiness is proven", async () => {
    const root = await mkdtemp(join(tmpdir(), "tanren-cleanup-inputs-"));
    try {
      const candidate = state(undefined, root);
      const buildBase = join(root, "build-base");
      const buildMarker = join(buildBase, "source", "compose.dev.yml");
      const runtimeMarker = join(candidate.context.runtimeDir, "compose.env");
      await mkdir(join(buildBase, "source"), { recursive: true });
      await mkdir(candidate.context.runtimeDir, { recursive: true });
      await writeFile(buildMarker, "services: {}\n");
      await writeFile(runtimeMarker, "TANREN_SMOKE=1\n");
      candidate.failure = new Error("cleanup has not converged");
      candidate.buildBase = buildBase;
      candidate.runtimeOwned = true;
      candidate.resourcesClean = false;

      await runStage(candidate, "remove-build-context", { allowWhenAborted: true });
      await runStage(candidate, "remove-runtime-dir", { allowWhenAborted: true });

      expect(await readFile(buildMarker, "utf8")).toBe("services: {}\n");
      expect(await readFile(runtimeMarker, "utf8")).toBe("TANREN_SMOKE=1\n");
      expect(candidate.buildBase).toBe(buildBase);
      expect(candidate.runtimeOwned).toBe(true);

      candidate.resourcesClean = true;
      await runStage(candidate, "remove-build-context", { allowWhenAborted: true });
      await runStage(candidate, "remove-runtime-dir", { allowWhenAborted: true });

      await expect(readFile(buildMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(runtimeMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(candidate.buildBase).toBeUndefined();
      expect(candidate.runtimeOwned).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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

// Fake compose runtime that reproduces the Podman 5.8.2 receipt: a `up --force-recreate`
// can exit 0 while printing hard-failure text, and `inspect` reports the orchestrator's
// actual `TANREN_PUBLIC_BASE_URL`. Drives bind-discovered-config without containers.
const REBIND_FAKE_RUNTIME = `
const argv = process.argv.slice(2);
if (argv.includes("up")) {
  const fs = require("fs");
  if (process.env.FAKE_REBIND_PROOF) fs.writeFileSync(process.env.FAKE_REBIND_PROOF, argv.join(" "));
  if (process.env.FAKE_UP_ERROR === "1") {
    console.error('>>>> Executing external compose provider "podman-compose".');
    console.error("podman-compose: error: cannot force-recreate a service with active dependents");
    console.error("Error: executing podman-compose: exit status 2");
  }
  process.exit(0);
}
if (argv.includes("ps")) { process.stdout.write("orchestrator-container-id\\n"); process.exit(0); }
if (argv[0] === "inspect") {
  const container = {
    Id: "orchestrator-container-id",
    Image: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    Config: {
      Labels: {
        "com.docker.compose.service": "orchestrator",
        "com.docker.compose.project": process.env.FAKE_PROJECT || "tanren-smoke-test",
        "com.docker.compose.project.working_dir": process.env.FAKE_EXECUTION_ROOT || process.cwd()
      },
      Env: ["TANREN_PUBLIC_BASE_URL=" + (process.env.FAKE_ORCHESTRATOR_URL || ""), "OTHER=value"]
    },
    State: { Status: "running", Running: true }
  };
  process.stdout.write(JSON.stringify([container]));
  process.exit(0);
}
process.exit(0);
`;

describe("bind-discovered-config provider-portable rebind", () => {
  async function rebindCandidate(options: {
    upError: boolean;
    orchestratorUrl: string;
    root: string;
  }): Promise<SmokeState> {
    const { root } = options;
    const runtime = join(root, "runtime.cjs");
    await writeFile(runtime, `#!${process.execPath}\n${REBIND_FAKE_RUNTIME}`, { mode: 0o755 });
    await chmod(runtime, 0o755);
    const candidate = state(undefined, root);
    candidate.runtime = { provider: "podman", executable: runtime, socket: join(root, "fake.sock") };
    candidate.context = withDiscoveredPorts(candidate.context, {
      ...candidate.context.requestedPorts,
      orchestrator: 37813,
    });
    await mkdir(candidate.context.runtimeDir, { recursive: true });
    // Node 24 resolves the `--env-file` argv compose emits, so it must exist.
    await writeFile(candidate.context.explicitEnvPath, "");
    candidate.env = {
      ...process.env,
      FAKE_UP_ERROR: options.upError ? "1" : "",
      FAKE_ORCHESTRATOR_URL: options.orchestratorUrl,
      FAKE_PROJECT: candidate.context.project,
      FAKE_EXECUTION_ROOT: candidate.context.executionRoot,
      FAKE_REBIND_PROOF: join(root, "rebind-proof.txt"),
    };
    return candidate;
  }

  it("rejects a podman wrapper false success (exit 0 with hard-failure text)", async () => {
    const root = await mkdtemp(join(tmpdir(), "tanren-rebind-false-success-"));
    try {
      const candidate = await rebindCandidate({
        upError: true,
        orchestratorUrl: "http://127.0.0.1:0",
        root,
      });
      await expect(runStage(candidate, "bind-discovered-config")).rejects.toThrow(
        /compose wrapper reported an error while exiting successfully.*provider=podman/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when an honest wrapper did not apply the discovered URL", async () => {
    const root = await mkdtemp(join(tmpdir(), "tanren-rebind-stale-url-"));
    try {
      const candidate = await rebindCandidate({
        upError: false,
        orchestratorUrl: "http://127.0.0.1:0",
        root,
      });
      await expect(runStage(candidate, "bind-discovered-config")).rejects.toThrow(
        /did not apply the discovered URL.*http:\/\/127\.0\.0\.1:0.*expected discovered candidate http:\/\/127\.0\.0\.1:37813/su,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes an honest rebind that adopts the discovered URL and drops --no-deps", async () => {
    const root = await mkdtemp(join(tmpdir(), "tanren-rebind-honest-"));
    try {
      const candidate = await rebindCandidate({
        upError: false,
        orchestratorUrl: "http://127.0.0.1:37813",
        root,
      });
      await runStage(candidate, "bind-discovered-config");
      const stage = candidate.ledger.stages.find((record) => record.name === "bind-discovered-config");
      expect(stage).toMatchObject({ status: "passed" });
      // The recorded stage command is the rebind (verification probes don't overwrite it).
      expect(stage?.command?.args.join(" ")).toContain("--force-recreate");
      const proof = await readFile(join(root, "rebind-proof.txt"), "utf8");
      // The dependent set is recreated together; the podman-conflicting --no-deps is gone.
      expect(proof).toContain("orchestrator");
      expect(proof).toContain("worker");
      expect(proof).toContain("dashboard");
      expect(proof).not.toContain("--no-deps");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
