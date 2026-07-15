import { rm } from "node:fs/promises";
import { join } from "node:path";
import { removeBuildBase } from "./stack-build.js";
import type { StackContext } from "./stack-context.js";
import { safeError, type LifecycleLedger } from "./stack-lifecycle.js";
import { abortableDelay } from "./stack-progress.js";
import { BUILD_ID_LABEL } from "./stack-provenance.js";
import { runCommand, type CommandEvidence, type RuntimeBinding } from "./stack-runtime.js";
import { synchronizeSignalFailure, type SmokeState } from "./stack-receipt.js";

function composeArgs(context: StackContext, ...args: string[]): string[] {
  return [
    "compose",
    "-p",
    context.project,
    "-f",
    join(context.executionRoot, "compose.dev.yml"),
    "--env-file",
    context.explicitEnvPath,
    ...args,
  ];
}

export interface OwnedResourceSnapshot {
  containers: string[];
  networks: string[];
  volumes: string[];
  images: string[];
}

type ResourceClass = keyof OwnedResourceSnapshot;

function options(
  context: StackContext,
  env: NodeJS.ProcessEnv,
  ledger: LifecycleLedger,
  signal: AbortSignal,
  capture = true,
) {
  return {
    cwd: context.executionRoot,
    env,
    capture,
    quiet: capture,
    signal,
    onSpawn: (evidence: CommandEvidence) => ledger.recordCommand(evidence),
    onGroup: (pgid: number, state: "started" | "exited") => ledger.recordGroup(pgid, state),
  };
}

async function listIds(
  runtime: RuntimeBinding,
  args: string[],
  context: StackContext,
  env: NodeJS.ProcessEnv,
  ledger: LifecycleLedger,
  signal: AbortSignal,
): Promise<string[]> {
  const result = await runCommand(runtime.executable, args, options(context, env, ledger, signal));
  return [
    ...new Set(
      result.stdout
        .split(/\s+/u)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

export async function enumerateOwnedResources(
  context: StackContext,
  runtime: RuntimeBinding,
  env: NodeJS.ProcessEnv,
  ledger: LifecycleLedger,
  signal = new AbortController().signal,
): Promise<OwnedResourceSnapshot> {
  const project = context.project;
  const [containers, networks, volumes, images] = await Promise.all([
    listIds(
      runtime,
      ["ps", "-a", "--filter", `label=com.docker.compose.project=${project}`, "-q"],
      context,
      env,
      ledger,
      signal,
    ),
    listIds(
      runtime,
      ["network", "ls", "--filter", `label=com.docker.compose.project=${project}`, "-q"],
      context,
      env,
      ledger,
      signal,
    ),
    listIds(
      runtime,
      ["volume", "ls", "--filter", `label=com.docker.compose.project=${project}`, "-q"],
      context,
      env,
      ledger,
      signal,
    ),
    listIds(
      runtime,
      ["image", "ls", "--filter", `label=${BUILD_ID_LABEL}=${context.buildId}`, "-q"],
      context,
      env,
      ledger,
      signal,
    ),
  ]);
  return { containers, networks, volumes, images };
}

function labelsFromInspection(raw: string): Record<string, string> {
  const parsed = JSON.parse(raw) as unknown;
  const item = Array.isArray(parsed) ? parsed[0] : parsed;
  if (typeof item !== "object" || item === null) return {};
  const root = item as { Labels?: unknown; Config?: { Labels?: unknown }; labels?: unknown };
  const labels = root.Labels ?? root.Config?.Labels ?? root.labels;
  if (typeof labels !== "object" || labels === null || Array.isArray(labels)) return {};
  return Object.fromEntries(
    Object.entries(labels).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

async function stillOwned(
  kind: ResourceClass,
  id: string,
  context: StackContext,
  runtime: RuntimeBinding,
  env: NodeJS.ProcessEnv,
  ledger: LifecycleLedger,
  signal: AbortSignal,
): Promise<boolean> {
  const noun =
    kind === "containers" ? "container" : kind === "networks" ? "network" : kind === "volumes" ? "volume" : "image";
  let raw: string;
  try {
    raw = (await runCommand(runtime.executable, [noun, "inspect", id], options(context, env, ledger, signal))).stdout;
  } catch {
    return false;
  }
  const labels = labelsFromInspection(raw);
  return kind === "images"
    ? labels[BUILD_ID_LABEL] === context.buildId
    : labels["com.docker.compose.project"] === context.project;
}

function removalArgs(kind: ResourceClass, id: string): string[] {
  if (kind === "containers") return ["rm", "-f", id];
  if (kind === "networks") return ["network", "rm", id];
  if (kind === "volumes") return ["volume", "rm", "-f", id];
  return ["image", "rm", "-f", id];
}

export async function forceRemoveOwnedResources(
  context: StackContext,
  runtime: RuntimeBinding,
  env: NodeJS.ProcessEnv,
  ledger: LifecycleLedger,
  owned: OwnedResourceSnapshot,
  signal = new AbortController().signal,
): Promise<void> {
  const errors: Error[] = [];
  for (const kind of ["containers", "networks", "volumes", "images"] as const) {
    for (const id of owned[kind]) {
      if (!(await stillOwned(kind, id, context, runtime, env, ledger, signal))) continue;
      try {
        await runCommand(runtime.executable, removalArgs(kind, id), options(context, env, ledger, signal, false));
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "exact-label force removal failed");
}

export async function attestOwnedResourcesEmpty(
  context: StackContext,
  runtime: RuntimeBinding,
  env: NodeJS.ProcessEnv,
  ledger: LifecycleLedger,
  signal = new AbortController().signal,
): Promise<void> {
  const leftover = await enumerateOwnedResources(context, runtime, env, ledger, signal);
  const classes = Object.entries(leftover).filter(([, ids]) => ids.length > 0);
  if (classes.length > 0) {
    throw new Error(
      `owned resources remain after cleanup: ${classes.map(([name, ids]) => `${name}=${ids.join(",")}`).join("; ")}`,
    );
  }
}

/** Compose teardown plus exact-label fallback and final emptiness proof. */
export async function teardownCandidateStack(
  context: StackContext,
  runtime: RuntimeBinding,
  env: NodeJS.ProcessEnv,
  ledger: LifecycleLedger,
): Promise<void> {
  const downController = new AbortController();
  const watchController = new AbortController();
  const parentSignal = ledger.abortController.signal;
  const abortFromParent = () => downController.abort(parentSignal.reason);
  if (!parentSignal.aborted) parentSignal.addEventListener("abort", abortFromParent, { once: true });
  const down = runCommand(
    runtime.executable,
    composeArgs(context, "down", "-v", "--remove-orphans"),
    options(context, env, ledger, downController.signal, false),
  ).finally(() => {
    parentSignal.removeEventListener("abort", abortFromParent);
    watchController.abort(new Error("compose down reached a terminal result"));
  });
  const observed = new Set<string>();
  let previous: string | undefined;
  const watch = (async () => {
    while (!watchController.signal.aborted) {
      try {
        const owned = await enumerateOwnedResources(context, runtime, env, ledger);
        const signature =
          `c=${owned.containers.join(",")}|n=${owned.networks.join(",")}|` +
          `v=${owned.volumes.join(",")}|i=${owned.images.join(",")}`;
        if (signature !== previous) {
          if (observed.has(signature)) {
            downController.abort(new Error(`compose down entered an owned-resource cycle at ${signature}`));
            watchController.abort(new Error(`compose down entered an owned-resource cycle at ${signature}`));
            return;
          }
          observed.add(signature);
          previous = signature;
        }
      } catch {
        if (watchController.signal.aborted) return;
        // A provider read failure is not evidence about resource progress.
      }
      await abortableDelay(50, watchController.signal).catch(() => {});
    }
  })();
  await Promise.all([down.catch(() => {}), watch.catch(() => {})]);
  const recoveryController = new AbortController();
  const owned = await enumerateOwnedResources(context, runtime, env, ledger, recoveryController.signal);
  await forceRemoveOwnedResources(context, runtime, env, ledger, owned, recoveryController.signal);
  await attestOwnedResourcesEmpty(context, runtime, env, ledger, recoveryController.signal);
}

export async function removeRuntimeDir(runtimeDir: string | undefined, owned: boolean): Promise<void> {
  if (!owned || runtimeDir === undefined) return;
  await rm(runtimeDir, { recursive: true, force: true });
}

/** Idempotent best-effort cleanup used before every failure receipt is sealed. */
export async function emergencyCleanup(state: SmokeState): Promise<void> {
  synchronizeSignalFailure(state);
  const errors: Error[] = [];
  const attempt = async (label: string, operation: () => Promise<void>) => {
    try {
      await operation();
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      errors.push(failure);
      state.cleanupErrors.push(`${label}: ${safeError(failure)}`);
    }
  };
  if (!state.resourcesClean && state.composeTouched && state.runtime !== undefined) {
    await attempt("emergency stack teardown", () =>
      teardownCandidateStack(state.context, state.runtime!, state.env, state.ledger),
    );
    await attempt("emergency resource attestation", async () => {
      await attestOwnedResourcesEmpty(state.context, state.runtime!, state.env, state.ledger);
      state.resourcesClean = true;
    });
  } else if (!state.composeTouched || state.runtime === undefined) {
    state.resourcesClean = true;
  }
  await attempt("emergency process fence", async () => {
    await state.ledger.processGroups.fenceAll();
    state.ledger.processGroups.assertEmpty();
  });
  if (state.resourcesClean) {
    await attempt("emergency archive removal", async () => {
      await removeBuildBase(state.buildBase);
      state.buildBase = undefined;
    });
    await attempt("emergency runtime removal", async () => {
      await removeRuntimeDir(state.context.runtimeDir, state.runtimeOwned);
      state.runtimeOwned = false;
    });
  }
  if (errors.length > 0) {
    state.cleanupFailed = true;
    throw new AggregateError(errors, "smoke emergency cleanup did not converge");
  }
}
