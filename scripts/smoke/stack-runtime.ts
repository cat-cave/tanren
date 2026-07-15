import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { PORT_SPECS, resolveHostPorts, type HostPorts, type PortName } from "./stack-context.js";
import { waitWhileProgressing } from "./stack-progress.js";
import { assertSemanticHealth } from "./stack-provenance.js";

export type { CommandEvidence, CommandOptions, CommandResult } from "./stack-process.js";
export {
  fenceProcessGroup,
  processGroupAbsent,
  ProcessGroupRegistry,
  runCommand,
  signalProcessGroup,
} from "./stack-process.js";
export { abortableDelay, progressCycleReached } from "./stack-progress.js";

export interface HttpEvidence {
  requestedUrl: string;
  finalUrl: string;
  requestedOrigin: string;
  finalOrigin: string;
}

export function attestResponseTarget(requested: string, response: Response): HttpEvidence {
  const requestedUrl = new URL(requested);
  if (response.url === "") throw new Error(`HTTP response omitted final URL for ${requestedUrl.href}`);
  const finalUrl = new URL(response.url);
  if (finalUrl.origin !== requestedUrl.origin || finalUrl.href !== requestedUrl.href) {
    throw new Error(`HTTP target escaped candidate: requested ${requestedUrl.href}, final ${finalUrl.href}`);
  }
  return {
    requestedUrl: requestedUrl.href,
    finalUrl: finalUrl.href,
    requestedOrigin: requestedUrl.origin,
    finalOrigin: finalUrl.origin,
  };
}

export async function fetchExact(
  url: string,
  options: { fetcher?: typeof fetch; signal?: AbortSignal; init?: RequestInit } = {},
): Promise<{ response: Response; evidence: HttpEvidence }> {
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(url, {
    ...options.init,
    redirect: "error",
    signal: options.signal,
  });
  return { response, evidence: attestResponseTarget(url, response) };
}

function parseExplicitPort(raw: string, name: string): number {
  if (!/^\d+$/u.test(raw)) throw new Error(`${name} must be an integer host port, got ${JSON.stringify(raw)}`);
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error(`${name} is outside 1..65535`);
  return port;
}

/**
 * Return publication requests, not reservations. Zero delegates allocation to
 * the container runtime, which owns the bind atomically and removes the old
 * check-then-bind race. Explicit ports remain exact and fail if the runtime
 * cannot claim them.
 */
export function findAvailablePorts(env: NodeJS.ProcessEnv, _runId: string): HostPorts {
  const explicitOffset = env["TANREN_PORT_OFFSET"]?.trim();
  if (explicitOffset !== undefined && explicitOffset !== "") {
    if (!/^\d+$/u.test(explicitOffset)) throw new Error("TANREN_PORT_OFFSET must be a non-negative integer");
    const offset = Number(explicitOffset);
    if (!Number.isSafeInteger(offset) || offset > 40_000) throw new Error("TANREN_PORT_OFFSET is outside 0..40000");
    return resolveHostPorts(env, offset);
  }
  const ports = {} as HostPorts;
  for (const [name, spec] of Object.entries(PORT_SPECS) as [PortName, (typeof PORT_SPECS)[PortName]][]) {
    const raw = env[spec.env]?.trim();
    ports[name] = raw === undefined || raw === "" ? 0 : parseExplicitPort(raw, spec.env);
  }
  const explicit = Object.values(ports).filter((port) => port !== 0);
  if (new Set(explicit).size !== explicit.length) throw new Error("explicit smoke host ports collide");
  return ports;
}

export function waitForJsonHealth(
  service: string,
  url: string,
  options: {
    delayMs?: number;
    fetcher?: typeof fetch;
    signal?: AbortSignal;
    onEvidence?: (evidence: HttpEvidence) => void;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<unknown> {
  return waitWhileProgressing({
    signal: options.signal,
    pollIntervalMs: options.delayMs ?? 2_000,
    sleep: options.sleep,
    probe: async () => {
      try {
        const { response, evidence } = await fetchExact(url, options);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body: unknown = await response.json();
        assertSemanticHealth(service, body);
        options.onEvidence?.(evidence);
        return { kind: "ready" as const, body };
      } catch (error) {
        if (options.signal?.aborted) throw error;
        return { kind: "waiting" as const, signature: String(error instanceof Error ? error.message : error) };
      }
    },
    classify: (observation) => {
      if (observation.kind === "ready") return { kind: "ready", value: observation.body };
      return { kind: "advancing", signature: `health:${service}:${observation.signature}` };
    },
  });
}

export type RuntimeProvider = "docker" | "podman";

export interface RuntimeBinding {
  provider: RuntimeProvider;
  executable: string;
  socket: string;
}

async function isSocket(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isSocket();
  } catch {
    return false;
  }
}

async function executableOnPath(name: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  for (const directory of (env["PATH"] ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through PATH.
    }
  }
  return undefined;
}

export async function resolveRuntimeBinding(
  env: NodeJS.ProcessEnv,
  probes: {
    isSocket?: (path: string) => Promise<boolean>;
    executable?: (name: string, env: NodeJS.ProcessEnv) => Promise<string | undefined>;
  } = {},
): Promise<RuntimeBinding> {
  const socketProbe = probes.isSocket ?? isSocket;
  const executableProbe = probes.executable ?? executableOnPath;
  const explicit = env["TANREN_SMOKE_RUNTIME"]?.trim();
  const requestedSocket = env["TANREN_SMOKE_RUNTIME_SOCKET"]?.trim();
  if (explicit === undefined || explicit === "" || requestedSocket === undefined || requestedSocket === "") {
    throw new Error("TANREN_SMOKE_RUNTIME and TANREN_SMOKE_RUNTIME_SOCKET are both required");
  }
  const provider = explicit!;
  const socket = requestedSocket!;
  if (provider !== "docker" && provider !== "podman") {
    throw new Error(`TANREN_SMOKE_RUNTIME must be docker or podman, got ${provider}`);
  }
  if (!(await socketProbe(socket))) throw new Error(`${provider} runtime socket is unavailable`);
  const executable = await executableProbe(provider, env);
  if (executable === undefined) throw new Error(`${provider} socket exists but executable is unavailable`);
  return { provider, executable, socket };
}

export function bindRuntimeEnvironment(env: NodeJS.ProcessEnv, runtime: RuntimeBinding): NodeJS.ProcessEnv {
  const bound = { ...env };
  for (const name of ["DOCKER_HOST", "DOCKER_CONTEXT", "CONTAINER_HOST", "CONTAINER_CONNECTION", "DOCKER_CONFIG"]) {
    delete bound[name];
  }
  bound["TANREN_DOCKER_SOCK"] = runtime.socket;
  if (runtime.provider === "docker") bound["DOCKER_HOST"] = `unix://${runtime.socket}`;
  else bound["CONTAINER_HOST"] = `unix://${runtime.socket}`;
  return bound;
}
