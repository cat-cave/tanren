import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createStackContext,
  environmentForContext,
  serializeExplicitEnv,
  withDiscoveredPorts,
  withExecutionRoot,
} from "./stack-context.js";
import { fingerprintTree, removeBuildBase } from "./stack-build.js";
import {
  attestOwnedResourcesEmpty,
  emergencyCleanup,
  removeRuntimeDir,
  teardownCandidateStack,
} from "./stack-cleanup.js";
import { STAGE_REGISTRY, type SmokeStage } from "./stack-gates.js";
import { DB_STAGE_RUNNERS, type StageRunner } from "./stack-db-stage-runners.js";
import {
  allocateRuntimeRoot,
  assertArtifactPathSafe,
  decodeTerminalCliStatus,
  fingerprintFile,
  inspectRuntimeIdentity,
  readCandidateIdentity,
  sanitizeComposeLogs,
  validateSmokePaths,
  writeFileAtomic,
} from "./stack-lifecycle.js";
import {
  commandOptions,
  composeArgs,
  discoverPorts,
  inspectBuiltImages,
  proveRunner,
  proveSemanticStack,
  stabilizeContainers,
} from "./stack-operations.js";
import {
  assertGitWorktreeClean,
  assertGitIdentity,
  assertStableContainers,
  type ProvenanceSnapshot,
} from "./stack-provenance.js";
import { bindRuntimeEnvironment, resolveRuntimeBinding, runCommand } from "./stack-runtime.js";
import { publishTerminalReceipt, synchronizeSignalFailure, type SmokeState } from "./stack-receipt.js";

const STAGE_RUNNERS_EXACT = {
  "preflight-git-identity": async (state) => {
    const candidate = await readCandidateIdentity(
      state.context.root,
      state.env,
      state.ledger.processGroups,
      state.ledger.abortController.signal,
    );
    state.candidate = candidate;
    if (candidate.porcelain !== "") {
      throw new Error(`smoke requires a clean committed worktree:\n${candidate.porcelain}`);
    }
    const refreshed = createStackContext({
      root: candidate.root,
      head: candidate.head,
      tree: candidate.tree,
      runId: state.context.runId,
      nonce: state.context.nonce,
      runtimeBase: state.runtimeBase,
      receiptPath: state.context.receiptPath,
      ports: state.context.requestedPorts,
    });
    const validated = await validateSmokePaths({
      checkoutRoot: refreshed.root,
      runtimeBase: state.runtimeBase,
      runtimeDir: refreshed.runtimeDir,
      receiptPath: refreshed.receiptPath,
    });
    state.context = withExecutionRoot(
      { ...refreshed, root: validated.checkoutRoot, receiptPath: validated.receiptPath },
      state.buildSource ?? refreshed.root,
    );
    await assertArtifactPathSafe(
      state.context.receiptPath,
      [state.context.runtimeDir, state.buildBase ?? ""],
      state.context.root,
    );
    state.env = environmentForContext(state.context, candidate.env, state.context.executionRoot, {
      seedCredential: state.seedCredential,
    });
  },
  "allocate-runtime-root": async (state) => {
    await allocateRuntimeRoot(state.context.runtimeDir);
    state.runtimeOwned = true;
    await mkdir(state.context.homeDir, { recursive: true, mode: 0o700 });
    await mkdir(join(state.context.runtimeDir, "xdg-runtime"), { recursive: true, mode: 0o700 });
  },
  "isolate-home": async (state) => {
    await writeFile(state.context.authFilePath, "{}\n", { mode: 0o600 });
    state.env = {
      ...state.env,
      HOME: state.context.homeDir,
      TANREN_AUTH_FILE: state.context.authFilePath,
    };
  },
  "resolve-runtime": async (state) => {
    let runtimeEnv = state.env;
    if (runtimeEnv["TANREN_SMOKE_RUNTIME"] === undefined || runtimeEnv["TANREN_SMOKE_RUNTIME_SOCKET"] === undefined) {
      const discovered = await runCommand(
        "just",
        ["smoke-runtime-binding"],
        commandOptions(state.context.executionRoot, runtimeEnv, state.ledger, true),
      );
      const parsed = JSON.parse(discovered.stdout) as { provider?: unknown; socket?: unknown };
      if (typeof parsed.provider !== "string" || typeof parsed.socket !== "string") {
        throw new TypeError("smoke-runtime-binding returned an invalid runtime identity");
      }
      runtimeEnv = {
        ...runtimeEnv,
        TANREN_SMOKE_RUNTIME: parsed.provider,
        TANREN_SMOKE_RUNTIME_SOCKET: parsed.socket,
      };
    }
    const runtime = await resolveRuntimeBinding(runtimeEnv);
    state.runtime = runtime;
    state.env = bindRuntimeEnvironment(runtimeEnv, runtime);
  },
  "attest-runtime": async (state) => {
    if (state.runtime === undefined) throw new Error("runtime unresolved");
    state.runtimeIdentity = await inspectRuntimeIdentity(
      state.runtime,
      state.context.executionRoot,
      state.env,
      state.ledger.abortController.signal,
      (evidence) => state.ledger.recordCommand(evidence),
      (pgid, childState) => state.ledger.recordGroup(pgid, childState),
    );
  },
  "archive-candidate": async (state) => {
    if (state.buildSource === undefined || state.buildBase === undefined || state.executionFingerprint === undefined) {
      throw new Error("verified bootstrap archive is missing");
    }
    if ((await fingerprintTree(state.buildSource)) !== state.executionFingerprint) {
      throw new Error("verified execution archive changed before smoke execution");
    }
    state.context = withExecutionRoot(state.context, state.buildSource);
    if (state.runtime === undefined) throw new Error("runtime unresolved");
    state.env = bindRuntimeEnvironment(
      environmentForContext(state.context, state.candidate?.env ?? process.env, state.buildSource, {
        seedCredential: state.seedCredential,
      }),
      state.runtime,
    );
  },
  "materialize-explicit-env": async (state) => {
    await writeFile(state.context.explicitEnvPath, serializeExplicitEnv(state.env), { mode: 0o600 });
    // Compose project resources may exist after this point; cleanup must own them.
    state.composeTouched = true;
  },
  "setup-runner-key": async (state) => {
    await runCommand("just", ["runner-key"], commandOptions(state.context.executionRoot, state.env, state.ledger));
  },
  "setup-mtls": async (state) => {
    await runCommand("just", ["gen-mtls-certs"], commandOptions(state.context.executionRoot, state.env, state.ledger));
    state.env["TANREN_RUNNER_AUTHORIZED_KEY"] = (
      await readFile(join(state.context.runtimeDir, "tanren_runner_key.pub"), "utf8")
    ).trim();
    state.credentials = {
      sshIdentity: await fingerprintFile(join(state.context.runtimeDir, "tanren_runner_key.pub")),
      ca: await fingerprintFile(join(state.context.runtimeDir, "mtls", "ca.crt")),
      sshHostKey: "pending",
      seedFingerprint: state.seedFingerprint,
    };
    await writeFile(state.context.explicitEnvPath, serializeExplicitEnv(state.env), { mode: 0o600 });
  },
  "snapshot-checkout": async (state) => {
    state.checkoutFingerprint = await fingerprintTree(state.context.root);
  },
  "build-images": async (state) => {
    if (state.runtime === undefined) throw new Error("runtime unresolved");
    state.composeTouched = true;
    await runCommand(
      state.runtime.executable,
      composeArgs(state.context, "build", "orchestrator", "worker", "allocator", "dashboard", "runner"),
      commandOptions(state.context.executionRoot, state.env, state.ledger),
    );
  },
  "attest-images": async (state) => {
    if (state.runtime === undefined) throw new Error("runtime unresolved");
    const images = await inspectBuiltImages(state.context, state.runtime, state.env, state.ledger);
    state.snapshot = { images, containers: {} as ProvenanceSnapshot["containers"] };
  },
  "start-stack": async (state) => {
    if (state.runtime === undefined) throw new Error("runtime unresolved");
    await runCommand(
      state.runtime.executable,
      composeArgs(
        state.context,
        "up",
        "-d",
        "--no-build",
        "postgres",
        "vault",
        "orchestrator",
        "worker",
        "allocator",
        "dashboard",
        "runner",
        "ntfy",
        "registry",
      ),
      commandOptions(state.context.executionRoot, state.env, state.ledger),
    );
  },
  "discover-published-ports": async (state) => {
    if (state.runtime === undefined) throw new Error("runtime unresolved");
    const published = await discoverPorts(state.context, state.runtime, state.env, state.ledger);
    state.context = withDiscoveredPorts(state.context, published);
    if (state.buildSource === undefined) throw new Error("build source missing");
    state.env = bindRuntimeEnvironment(
      environmentForContext(state.context, state.candidate?.env ?? process.env, state.buildSource, {
        seedCredential: state.seedCredential,
      }),
      state.runtime,
    );
    state.env["TANREN_RUNNER_AUTHORIZED_KEY"] = (
      await readFile(join(state.context.runtimeDir, "tanren_runner_key.pub"), "utf8")
    ).trim();
    await writeFile(state.context.explicitEnvPath, serializeExplicitEnv(state.env), { mode: 0o600 });
  },
  "bind-discovered-config": async (state) => {
    if (state.runtime === undefined) throw new Error("runtime unresolved");
    await runCommand(
      state.runtime.executable,
      composeArgs(state.context, "up", "-d", "--no-build", "--no-deps", "--force-recreate", "orchestrator"),
      commandOptions(state.context.executionRoot, state.env, state.ledger),
    );
  },
  "stabilize-containers": async (state) => {
    if (state.runtime === undefined || state.snapshot === undefined) throw new Error("images unresolved");
    const containers = await stabilizeContainers(
      state.context,
      state.runtime,
      state.env,
      state.snapshot.images,
      state.ledger,
    );
    state.snapshot = { images: state.snapshot.images, containers };
    state.env["TANREN_SMOKE_WORKER_CONTAINER_ID"] = containers.worker.containerId;
    state.env["TANREN_SMOKE_RUNTIME_EXECUTABLE"] = state.runtime.executable;
  },
  "semantic-stack": async (state) => {
    await proveSemanticStack(state.context, state.bindings, state.ledger.abortController.signal, state.ledger);
  },
  "runner-ssh": async (state) => {
    if (state.credentials === undefined) throw new Error("credentials unresolved");
    state.credentials.sshHostKey = await proveRunner(state.context, state.env, state.ledger, state.bindings);
  },
  "seed-platform-credentials": async (state) => {
    // Optional stage always entered; body no-ops unless the nonce sentinel is present.
    if (state.env["TANREN_E2E_MANAGED_ROUTER_KEY"] !== state.seedCredential) return;
    await runCommand(
      "just",
      ["seed-platform-creds"],
      commandOptions(state.context.executionRoot, state.env, state.ledger),
    );
    state.platformCredentials = "sentinel";
    if (state.credentials !== undefined) state.credentials.seedFingerprint = state.seedFingerprint;
  },
  "cli-doctor": async (state) => {
    await runCommand("corepack", ["pnpm", "--silent", "--filter", "@tanren/cli", "tanren", "doctor"], {
      ...commandOptions(state.context.executionRoot, state.env, state.ledger),
      onSpawn: (evidence) => {
        state.ledger.recordCommand(evidence);
        state.bindings.record("cliDoctor", state.env["TANREN_PUBLIC_BASE_URL"]!);
      },
    });
  },
  connectivity: async (state) => {
    await runCommand(
      "just",
      ["smoke-connectivity"],
      commandOptions(state.context.executionRoot, state.env, state.ledger),
    );
  },
  "ssh-integration": async (state) => {
    await runCommand(
      "just",
      ["smoke-ssh-integration"],
      commandOptions(state.context.executionRoot, state.env, state.ledger),
    );
  },
  "plane-split-worker": async (state) => {
    state.env["TANREN_SMOKE_PROOF_PATH"] = join(state.context.runtimeDir, "plane-split-proof.json");
    state.env["TANREN_PLANE_SPLIT_PROVE_DEPRIVILEGE"] = "1";
    await runCommand(
      "just",
      ["smoke-plane-split-worker"],
      commandOptions(state.context.executionRoot, state.env, state.ledger),
    );
    const planeProof = JSON.parse(await readFile(state.env["TANREN_SMOKE_PROOF_PATH"]!, "utf8")) as {
      runId?: unknown;
      claimEndpoint?: unknown;
    };
    if (typeof planeProof.runId !== "string" || planeProof.runId === "")
      throw new Error("plane split emitted no run ID");
    if (planeProof.claimEndpoint !== state.context.endpoints.internalMtls) {
      throw new Error("plane split proof targeted the wrong mTLS endpoint");
    }
    state.planeSplitRunId = planeProof.runId;
    state.bindings.record("mtls", planeProof.claimEndpoint);
  },
  "cli-status": async (state) => {
    if (state.planeSplitRunId === undefined) throw new Error("plane split run missing");
    const statusResult = await runCommand(
      "corepack",
      ["pnpm", "--silent", "--filter", "@tanren/cli", "tanren", "status", state.planeSplitRunId],
      {
        ...commandOptions(state.context.executionRoot, state.env, state.ledger, true),
        onSpawn: (evidence) => {
          state.ledger.recordCommand(evidence);
          state.bindings.record("cliStatus", state.env["TANREN_PUBLIC_BASE_URL"]!);
        },
      },
    );
    state.planeSplitStatus = decodeTerminalCliStatus(statusResult.stdout, state.planeSplitRunId);
  },
  "assert-checkout-unchanged": async (state) => {
    if (state.checkoutFingerprint === undefined || state.executionFingerprint === undefined) {
      throw new Error("checkout or execution fingerprint missing");
    }
    const after = await fingerprintTree(state.context.root);
    if (after !== state.checkoutFingerprint) throw new Error("checkout paths changed during smoke");
    if ((await fingerprintTree(state.context.executionRoot)) !== state.executionFingerprint) {
      throw new Error("verified execution archive changed during smoke");
    }
    const finalGit = await readCandidateIdentity(
      state.context.root,
      state.env,
      state.ledger.processGroups,
      state.ledger.abortController.signal,
    );
    assertGitIdentity(state.context, finalGit.head, finalGit.tree);
    assertGitWorktreeClean(finalGit.porcelain);
  },
  "final-container-attestation": async (state) => {
    if (state.runtime === undefined || state.snapshot === undefined) throw new Error("snapshot missing");
    const finalContainers = await stabilizeContainers(
      state.context,
      state.runtime,
      state.env,
      state.snapshot.images,
      state.ledger,
    );
    assertStableContainers(state.snapshot.containers, finalContainers);
  },
  "final-semantic-stack": async (state) => {
    await proveSemanticStack(state.context, state.bindings, state.ledger.abortController.signal, state.ledger);
  },
  "final-runner-ssh": async (state) => {
    await proveRunner(state.context, state.env, state.ledger, state.bindings);
    state.bindings.assertComplete(state.context);
  },
  "capture-compose-logs": async (state) => {
    if (state.failure === undefined || !state.composeTouched || state.runtime === undefined) return;
    if (state.ledger.abortController.signal.aborted) return;
    const logs = await runCommand(
      state.runtime.executable,
      composeArgs(state.context, "logs", "--no-color", "--tail", "200"),
      {
        cwd: state.context.executionRoot,
        env: state.env,
        capture: true,
        quiet: true,
        signal: state.ledger.abortController.signal,
        onGroup: (pgid, childState) => state.ledger.recordGroup(pgid, childState),
      },
    );
    await assertArtifactPathSafe(
      state.context.receiptPath,
      [state.context.runtimeDir, state.buildBase ?? ""],
      state.context.root,
    );
    state.composeLogsPath = `${state.context.receiptPath}.compose.log`;
    await assertArtifactPathSafe(
      state.composeLogsPath,
      [state.context.runtimeDir, state.buildBase ?? ""],
      state.context.root,
    );
    await writeFileAtomic(state.composeLogsPath, sanitizeComposeLogs(`${logs.stdout}\n${logs.stderr}`));
  },
  "teardown-stack": async (state) => {
    if (
      state.failure === undefined &&
      state.signalExitCode === undefined &&
      state.env["TANREN_SMOKE_KEEP_STACK"] === "1"
    ) {
      return;
    }
    if (!state.composeTouched || state.runtime === undefined) return;
    await teardownCandidateStack(state.context, state.runtime, state.env, state.ledger);
  },
  "attest-resource-leaks": async (state) => {
    if (state.resourcesClean) return;
    if (
      state.failure === undefined &&
      state.signalExitCode === undefined &&
      state.env["TANREN_SMOKE_KEEP_STACK"] === "1" &&
      !state.cleanupFailed
    ) {
      return;
    }
    if (state.composeTouched && state.runtime !== undefined) {
      await attestOwnedResourcesEmpty(state.context, state.runtime, state.env, state.ledger);
    }
    await state.ledger.processGroups.fenceAll();
    state.ledger.processGroups.assertEmpty();
    state.resourcesClean = true;
  },
  "remove-build-context": async (state) => {
    if (
      state.failure === undefined &&
      state.signalExitCode === undefined &&
      state.env["TANREN_SMOKE_KEEP_STACK"] === "1" &&
      !state.cleanupFailed
    ) {
      return;
    }
    if (!state.resourcesClean) return;
    await removeBuildBase(state.buildBase);
    state.buildBase = undefined;
  },
  "remove-runtime-dir": async (state) => {
    if (
      state.failure === undefined &&
      state.signalExitCode === undefined &&
      state.env["TANREN_SMOKE_KEEP_STACK"] === "1" &&
      !state.cleanupFailed
    ) {
      return;
    }
    if (!state.resourcesClean) return;
    await removeRuntimeDir(state.context.runtimeDir, state.runtimeOwned);
    state.runtimeOwned = false;
  },
  "publish-receipt": async (state) => {
    synchronizeSignalFailure(state);
    state.ledger.completeActiveForReceipt("passed");
    await publishTerminalReceipt(state, {
      keep: state.env["TANREN_SMOKE_KEEP_STACK"] === "1",
      onPrimaryFailure: () => emergencyCleanup(state),
    });
  },
  ...DB_STAGE_RUNNERS,
} satisfies Record<SmokeStage, StageRunner>;

/** Mutable exact map for tests; completeness pinned by `satisfies` above. */
export const STAGE_RUNNERS: Record<SmokeStage, StageRunner> = STAGE_RUNNERS_EXACT;

export async function runStage(
  state: SmokeState,
  name: SmokeStage,
  options: { allowWhenAborted?: boolean } = {},
): Promise<void> {
  await state.ledger.run(name, () => STAGE_RUNNERS[name](state), options);
}

export async function executeSmoke(state: SmokeState): Promise<void> {
  for (const stage of STAGE_REGISTRY) {
    if (stage.kind === "finalize") continue;
    if (state.ledger.abortController.signal.aborted) throw state.ledger.abortController.signal.reason;
    await runStage(state, stage.name);
  }
}
