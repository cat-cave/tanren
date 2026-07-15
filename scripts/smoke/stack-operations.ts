import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDbPool } from "../../db/src/index.js";
import { parseComposePort, probeBindings, type HostPorts, type StackContext } from "./stack-context.js";
import { fingerprintFile, type ExecutedBindings, type LifecycleLedger } from "./stack-lifecycle.js";
import {
  assertDiscoveredPorts,
  assertRegistryHealth,
  BUILD_ID_LABEL,
  type ProvenanceSnapshot,
  validateBuiltImages,
  validateContainers,
} from "./stack-provenance.js";
import { waitWhileProgressing as progressWait } from "./stack-progress.js";
import { abortableDelay, fetchExact, runCommand, waitForJsonHealth } from "./stack-runtime.js";
import type { CommandEvidence, RuntimeBinding } from "./stack-runtime.js";

const COMPOSE_PORTS = {
  orchestrator: ["orchestrator", 3100],
  internalMtls: ["orchestrator", 3110],
  allocator: ["allocator", 3200],
  postgres: ["postgres", 5432],
  runnerSsh: ["runner", 22],
  vault: ["vault", 8200],
  dashboard: ["dashboard", 3000],
  ntfy: ["ntfy", 80],
  registry: ["registry", 5000],
} as const;

export function composeArgs(context: StackContext, ...args: string[]): string[] {
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

export function commandOptions(root: string, env: NodeJS.ProcessEnv, ledger: LifecycleLedger, capture = false) {
  return {
    cwd: root,
    env,
    capture,
    signal: ledger.abortController.signal,
    onSpawn: (evidence: CommandEvidence) => ledger.recordCommand(evidence),
    onGroup: (pgid: number, state: "started" | "exited") => ledger.recordGroup(pgid, state),
  };
}

export async function inspectBuiltImages(
  context: StackContext,
  runtime: RuntimeBinding,
  env: NodeJS.ProcessEnv,
  ledger: LifecycleLedger,
) {
  const ids = (
    await runCommand(
      runtime.executable,
      ["image", "ls", "--filter", `label=${BUILD_ID_LABEL}=${context.buildId}`, "--format", "{{.ID}}"],
      { ...commandOptions(context.executionRoot, env, ledger, true), quiet: true },
    )
  ).stdout
    .split(/\s+/u)
    .filter(Boolean);
  if (ids.length === 0) throw new Error(`build produced no images carrying build id ${context.buildId}`);
  const raw = (
    await runCommand(
      runtime.executable,
      ["image", "inspect", ...new Set(ids)],
      commandOptions(context.executionRoot, env, ledger, true),
    )
  ).stdout;
  return validateBuiltImages(context, raw);
}

export async function inspectContainers(
  context: StackContext,
  runtime: RuntimeBinding,
  env: NodeJS.ProcessEnv,
  images: ProvenanceSnapshot["images"],
  ledger: LifecycleLedger,
) {
  const ids = (
    await runCommand(runtime.executable, composeArgs(context, "ps", "-q"), {
      ...commandOptions(context.executionRoot, env, ledger, true),
      quiet: true,
    })
  ).stdout
    .split(/\s+/u)
    .filter(Boolean);
  if (ids.length === 0) throw new Error(`compose project ${context.project} has no running containers`);
  const raw = (
    await runCommand(runtime.executable, ["inspect", ...ids], {
      ...commandOptions(context.executionRoot, env, ledger, true),
      quiet: true,
    })
  ).stdout;
  return validateContainers(context, images, raw);
}

export async function discoverPorts(
  context: StackContext,
  runtime: RuntimeBinding,
  env: NodeJS.ProcessEnv,
  ledger: LifecycleLedger,
): Promise<HostPorts> {
  const discovered = {} as HostPorts;
  for (const [name, [service, internalPort]] of Object.entries(COMPOSE_PORTS) as [
    keyof HostPorts,
    readonly [string, number],
  ][]) {
    const result = await runCommand(runtime.executable, composeArgs(context, "port", service, String(internalPort)), {
      ...commandOptions(context.executionRoot, env, ledger, true),
      quiet: true,
    });
    discovered[name] = parseComposePort(result.stdout);
  }
  assertDiscoveredPorts(context.requestedPorts, discovered);
  return discovered;
}

async function provePostgres(
  context: StackContext,
  bindings: ExecutedBindings,
  signal: AbortSignal,
  ledger: LifecycleLedger,
): Promise<void> {
  const target = new URL(context.endpoints.postgresOwner);
  bindings.record("postgres", target.host);
  const pool = createDbPool(target.href);
  try {
    const database = await queryCurrentDatabase(pool, signal);
    if (database !== "tanren") throw new Error("candidate Postgres returned the wrong database");
    ledger.recordCommand({ command: "postgres", args: ["SELECT current_database()"], cwd: context.root });
  } finally {
    await pool.end().catch(() => {});
  }
}

interface ProbeClient {
  query(sql: string): Promise<{ rows: { database_name?: unknown }[] }>;
  release(destroy?: boolean): void;
}

interface ProbePool {
  connect(): Promise<ProbeClient>;
  end(): Promise<void>;
}

/** Destroy the active PG connection on abort so a silent query cannot pin finalization. */
export async function queryCurrentDatabase(pool: ProbePool, signal: AbortSignal): Promise<string> {
  let client: ProbeClient | undefined;
  let released = false;
  const release = (destroy: boolean) => {
    if (client === undefined || released) return;
    released = true;
    client.release(destroy);
  };
  const abort = () => release(true);
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) throw signal.reason;
    client = await pool.connect();
    if (signal.aborted) {
      release(true);
      throw signal.reason;
    }
    const result = await client.query("SELECT current_database() AS database_name");
    if (signal.aborted) throw signal.reason;
    const value = result.rows[0]?.database_name;
    if (typeof value !== "string" || value === "") throw new Error("Postgres probe returned no database identity");
    return value;
  } finally {
    signal.removeEventListener("abort", abort);
    release(signal.aborted);
  }
}

export async function proveRunner(
  context: StackContext,
  env: NodeJS.ProcessEnv,
  ledger: LifecycleLedger,
  bindings: ExecutedBindings,
): Promise<string> {
  const knownHosts = join(context.runtimeDir, "tanren_runner_known_hosts");
  const scanned = await progressWait({
    signal: ledger.abortController.signal,
    pollIntervalMs: 1_000,
    probe: async () => {
      try {
        const result = await runCommand(
          "ssh-keyscan",
          ["-T", "5", "-p", String(context.endpoints.runnerPort), "-t", "ed25519", context.endpoints.runnerHost],
          { ...commandOptions(context.executionRoot, env, ledger, true), quiet: true },
        );
        return { kind: "ready" as const, body: result.stdout };
      } catch (error) {
        if (ledger.abortController.signal.aborted) throw ledger.abortController.signal.reason;
        return { kind: "waiting" as const, signature: String(error instanceof Error ? error.message : error) };
      }
    },
    classify: (observation) => {
      if (observation.kind === "ready") {
        if (observation.body.trim() === "") return { kind: "advancing", signature: "ssh-keyscan:empty" };
        return { kind: "ready", value: observation.body };
      }
      return { kind: "advancing", signature: `ssh-keyscan:${observation.signature}` };
    },
  });
  await writeFile(knownHosts, scanned, { mode: 0o600 });
  bindings.record("ssh", `${context.endpoints.runnerHost}:${context.endpoints.runnerPort}`);
  const revision = await runCommand(
    "ssh",
    [
      "-F",
      "/dev/null",
      "-i",
      join(context.runtimeDir, "tanren_runner_key"),
      "-p",
      String(context.endpoints.runnerPort),
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      `UserKnownHostsFile=${knownHosts}`,
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=5",
      `tanren@${context.endpoints.runnerHost}`,
      "cat /etc/tanren-source-revision",
    ],
    commandOptions(context.executionRoot, env, ledger, true),
  );
  if (revision.stdout.trim() !== context.head) throw new Error("runner source revision does not match candidate");
  return fingerprintFile(knownHosts);
}

export async function proveSemanticStack(
  context: StackContext,
  bindings: ExecutedBindings,
  signal: AbortSignal,
  ledger: LifecycleLedger,
): Promise<void> {
  const expected = probeBindings(context);
  for (const service of ["vault", "orchestrator", "dashboard", "allocator", "ntfy"] as const) {
    await waitForJsonHealth(service, expected[service]!, {
      signal,
      onEvidence: (evidence) => bindings.recordHttp(service, evidence),
    });
  }
  const registry = await fetchExact(expected.registry!, { signal });
  assertRegistryHealth(registry.response);
  bindings.recordHttp("registry", registry.evidence);
  await provePostgres(context, bindings, signal, ledger);
}

export function stabilizeContainers(
  context: StackContext,
  runtime: RuntimeBinding,
  env: NodeJS.ProcessEnv,
  images: ProvenanceSnapshot["images"],
  ledger: LifecycleLedger,
): Promise<ProvenanceSnapshot["containers"]> {
  return progressWait({
    signal: ledger.abortController.signal,
    pollIntervalMs: 1_000,
    probe: async () => {
      try {
        return { kind: "ready" as const, body: await inspectContainers(context, runtime, env, images, ledger) };
      } catch (error) {
        if (ledger.abortController.signal.aborted) throw ledger.abortController.signal.reason;
        return { kind: "waiting" as const, signature: String(error instanceof Error ? error.message : error) };
      }
    },
    classify: (observation) => {
      if (observation.kind === "ready") return { kind: "ready", value: observation.body };
      return { kind: "advancing", signature: `containers:${observation.signature}` };
    },
  });
}

export { abortableDelay };
