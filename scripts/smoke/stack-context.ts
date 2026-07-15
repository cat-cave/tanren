import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { join } from "node:path";

// cspell:ignore PGDATABASE PGHOST PGPASSWORD PGPORT PGSERVICE PGSERVICEFILE PGSSLMODE PGUSER

export const PORT_SPECS = {
  orchestrator: { base: 3100, env: "TANREN_ORCHESTRATOR_HOST_PORT" },
  internalMtls: { base: 3110, env: "TANREN_INTERNAL_MTLS_HOST_PORT" },
  allocator: { base: 3200, env: "TANREN_ALLOCATOR_HOST_PORT" },
  postgres: { base: 5432, env: "TANREN_POSTGRES_HOST_PORT" },
  runnerSsh: { base: 2222, env: "TANREN_RUNNER_SSH_HOST_PORT" },
  vault: { base: 18_200, env: "TANREN_VAULT_HOST_PORT" },
  dashboard: { base: 3000, env: "DASHBOARD_HOST_PORT" },
  ntfy: { base: 18_080, env: "TANREN_NTFY_HOST_PORT" },
  registry: { base: 5000, env: "TANREN_REGISTRY_HOST_PORT" },
} as const;

export type PortName = keyof typeof PORT_SPECS;
export type HostPorts = Record<PortName, number>;

export interface StackEndpoints {
  orchestrator: string;
  internalMtls: string;
  allocator: string;
  postgresOwner: string;
  postgresApp: string;
  postgresDataPlane: string;
  runnerHost: string;
  runnerPort: number;
  vault: string;
  dashboard: string;
  ntfy: string;
  registry: string;
}

export interface StackContext {
  root: string;
  executionRoot: string;
  head: string;
  tree: string;
  runId: string;
  nonce: string;
  project: string;
  buildId: string;
  runtimeDir: string;
  homeDir: string;
  explicitEnvPath: string;
  authFilePath: string;
  receiptPath: string;
  requestedPorts: HostPorts;
  publishedPorts?: HostPorts;
  endpoints: StackEndpoints;
}

export interface CreateStackContextInput {
  root: string;
  head: string;
  tree: string;
  runId: string;
  nonce: string;
  runtimeBase: string;
  receiptPath: string;
  ports: HostPorts;
}

type Environment = Readonly<Record<string, string | undefined>>;

const AMBIENT_EXACT_KEYS = new Set([
  "ALL_PROXY",
  "BASH_ENV",
  "COMPOSE_DISABLE_ENV_FILE",
  "COMPOSE_ENV_FILES",
  "COMPOSE_FILE",
  "COMPOSE_PATH_SEPARATOR",
  "COMPOSE_PROFILES",
  "COMPOSE_PROJECT_NAME",
  "CONTAINER_CONNECTION",
  "CONTAINER_HOST",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "ENV",
  "HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NODE_OPTIONS",
  "NO_PROXY",
  "PGDATABASE",
  "PGHOST",
  "PGPASSWORD",
  "PGPORT",
  "PGSERVICE",
  "PGSERVICEFILE",
  "PGSSLMODE",
  "PGUSER",
  "SSH_ASKPASS",
  "SSH_AUTH_SOCK",
  "TANREN_AUTH_FILE",
  "TANREN_DOCKER_SOCK",
  "TANREN_RUNTIME_DIR",
  "TANREN_SECRETS_DIR",
  "TANREN_SECRET_ENV_FILE",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_STATE_HOME",
  "all_proxy",
  "http_proxy",
  "https_proxy",
  "no_proxy",
]);

const AMBIENT_PREFIXES = [
  "GIT_",
  "DOCKER_",
  "COMPOSE_",
  "CONTAINER_",
  "PODMAN_",
  "BUILDKIT_",
  "BUILDX_",
  "PG",
  "XDG_",
  "NPM_",
  "PNPM_",
];

/** Remove ambient selectors that can redirect Git, local probes, credentials, or the runtime. */
export function sanitizeAmbientEnvironment(ambient: Environment): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(ambient)) {
    if (AMBIENT_PREFIXES.some((prefix) => name.startsWith(prefix)) || AMBIENT_EXACT_KEYS.has(name)) continue;
    // Drop ambient auth/credential surfaces; smoke re-injects only nonce-scoped sentinels.
    if (/^(.*_)?(TOKEN|SECRET|PASSWORD|API_KEY|AUTH|CREDENTIAL)(_.*)?$/iu.test(name) && name !== "PATH") continue;
    if (value !== undefined) clean[name] = value;
  }
  clean["NO_PROXY"] = "127.0.0.1,localhost,::1";
  clean["no_proxy"] = clean["NO_PROXY"];
  return clean;
}

export function createRunNonce(): string {
  return randomBytes(16).toString("hex");
}

function parsePort(raw: string, name: string): number {
  if (!/^\d+$/u.test(raw)) throw new Error(`${name} must be an integer host port, got ${JSON.stringify(raw)}`);
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be in 1..65535, got ${raw}`);
  }
  return port;
}

export function requestedOffset(env: Environment, runId: string): number {
  const explicit = env["TANREN_PORT_OFFSET"]?.trim();
  if (explicit !== undefined && explicit !== "") {
    if (!/^\d+$/u.test(explicit)) throw new Error(`TANREN_PORT_OFFSET must be a non-negative integer, got ${explicit}`);
    const offset = Number(explicit);
    if (!Number.isSafeInteger(offset) || offset > 40_000) {
      throw new Error(`TANREN_PORT_OFFSET is outside the supported range 0..40000: ${explicit}`);
    }
    return offset;
  }
  const digest = createHash("sha256").update(runId).digest();
  return 1000 + (digest.readUInt32BE(0) % 20_000);
}

export function resolveHostPorts(env: Environment, offset: number): HostPorts {
  const resolved = {} as HostPorts;
  for (const [name, spec] of Object.entries(PORT_SPECS) as [PortName, (typeof PORT_SPECS)[PortName]][]) {
    const override = env[spec.env]?.trim();
    const raw = override === undefined || override === "" ? String(spec.base + offset) : override;
    resolved[name] = parsePort(raw, spec.env);
  }
  const duplicates = new Map<number, PortName[]>();
  for (const [name, port] of Object.entries(resolved) as [PortName, number][]) {
    duplicates.set(port, [...(duplicates.get(port) ?? []), name]);
  }
  const collisions = [...duplicates.entries()].filter(([, names]) => names.length > 1);
  if (collisions.length > 0) {
    throw new Error(
      `smoke host ports collide: ${collisions.map(([port, names]) => `${port}=${names.join("+")}`).join(", ")}`,
    );
  }
  return resolved;
}

function slug(raw: string, max: number): string {
  const normalized = raw
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-|-$/gu, "");
  return (normalized || "run").slice(0, max).replace(/-$/u, "");
}

export function endpointsForPorts(ports: HostPorts): StackEndpoints {
  return {
    orchestrator: `http://127.0.0.1:${ports.orchestrator}`,
    internalMtls: `https://127.0.0.1:${ports.internalMtls}`,
    allocator: `http://127.0.0.1:${ports.allocator}`,
    postgresOwner: `postgres://tanren:tanren@127.0.0.1:${ports.postgres}/tanren`,
    postgresApp: `postgres://tanren_app:tanren_app@127.0.0.1:${ports.postgres}/tanren`,
    postgresDataPlane: `postgres://tanren_dataplane:tanren_dataplane@127.0.0.1:${ports.postgres}/tanren`,
    runnerHost: "127.0.0.1",
    runnerPort: ports.runnerSsh,
    vault: `http://127.0.0.1:${ports.vault}`,
    dashboard: `http://127.0.0.1:${ports.dashboard}`,
    ntfy: `http://127.0.0.1:${ports.ntfy}`,
    registry: `http://127.0.0.1:${ports.registry}`,
  };
}

export function createStackContext(input: CreateStackContextInput): StackContext {
  if (!/^[0-9a-f]{40}$/u.test(input.head) || !/^[0-9a-f]{40}$/u.test(input.tree)) {
    throw new Error("smoke requires full lowercase Git commit and tree object IDs");
  }
  if (!/^[0-9a-f]{32}$/u.test(input.nonce)) throw new Error("smoke run nonce must be 128-bit lowercase hex");
  const runSlug = slug(input.runId, 18);
  const project = `tanren-smoke-${input.head.slice(0, 10)}-${input.nonce}`;
  const buildId = `${input.head.slice(0, 12)}-${input.nonce}`;
  const runtimeDir = join(input.runtimeBase, "smoke", `${runSlug}-${input.nonce}`);
  return {
    root: input.root,
    executionRoot: input.root,
    head: input.head,
    tree: input.tree,
    runId: input.runId,
    nonce: input.nonce,
    project,
    buildId,
    runtimeDir,
    homeDir: join(runtimeDir, "home"),
    explicitEnvPath: join(runtimeDir, "compose.env"),
    authFilePath: join(runtimeDir, "auth.json"),
    receiptPath: input.receiptPath,
    requestedPorts: input.ports,
    endpoints: endpointsForPorts(input.ports),
  };
}

export function withExecutionRoot(context: StackContext, executionRoot: string): StackContext {
  return { ...context, executionRoot };
}

export function withDiscoveredPorts(context: StackContext, ports: HostPorts): StackContext {
  return { ...context, publishedPorts: ports, endpoints: endpointsForPorts(ports) };
}

function composePublishedPort(port: number): string {
  return port === 0 ? "" : String(port);
}

export function parseComposePort(output: string): number {
  const bindings = output
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const bare = /^(\d+)$/u.exec(line);
      if (bare !== null) return parsePort(bare[1]!, "compose port");
      const ipv4 = /^([^:[\]]+):(\d+)$/u.exec(line);
      if (ipv4?.[1] !== undefined && ipv4[2] !== undefined && isIP(ipv4[1]) === 4) {
        return parsePort(ipv4[2], "compose port");
      }
      const ipv6 = /^\[([^\]]+)\]:(\d+)$/u.exec(line);
      if (ipv6?.[1] !== undefined && ipv6[2] !== undefined && isIP(ipv6[1]) === 6) {
        return parsePort(ipv6[2], "compose port");
      }
      throw new Error(`could not parse compose port binding: ${JSON.stringify(line)}`);
    });
  const unique = [...new Set(bindings)];
  if (unique.length !== 1) throw new Error(`expected one compose host port, got ${JSON.stringify(bindings)}`);
  return unique[0]!;
}

export function environmentForContext(
  context: StackContext,
  ambient: NodeJS.ProcessEnv,
  buildContext: string,
  options: { seedCredential?: string } = {},
): NodeJS.ProcessEnv {
  const p = context.publishedPorts ?? context.requestedPorts;
  const e = context.endpoints;
  const resolved: NodeJS.ProcessEnv = {
    ...sanitizeAmbientEnvironment(ambient),
    HOME: context.homeDir,
    XDG_CONFIG_HOME: join(context.homeDir, "xdg-config"),
    XDG_CACHE_HOME: join(context.homeDir, "xdg-cache"),
    XDG_DATA_HOME: join(context.homeDir, "xdg-data"),
    XDG_STATE_HOME: join(context.homeDir, "xdg-state"),
    XDG_RUNTIME_DIR: join(context.runtimeDir, "xdg-runtime"),
    TANREN_AUTH_FILE: context.authFilePath,
    COMPOSE_PROJECT_NAME: context.project,
    COMPOSE_DISABLE_ENV_FILE: "1",
    COMPOSE_ENV_FILES: context.explicitEnvPath,
    TANREN_SMOKE_PROJECT: context.project,
    TANREN_SMOKE_BUILD_ID: context.buildId,
    TANREN_SOURCE_REVISION: context.head,
    TANREN_SOURCE_TREE: context.tree,
    TANREN_BUILD_CONTEXT: buildContext,
    TANREN_RUNTIME_DIR: context.runtimeDir,
    TANREN_MTLS_DIR: join(context.runtimeDir, "mtls"),
    TANREN_PORT_OFFSET: "0",
    TANREN_ORCHESTRATOR_HOST_PORT: composePublishedPort(p.orchestrator),
    TANREN_INTERNAL_MTLS_HOST_PORT: composePublishedPort(p.internalMtls),
    TANREN_ALLOCATOR_HOST_PORT: composePublishedPort(p.allocator),
    TANREN_POSTGRES_HOST_PORT: composePublishedPort(p.postgres),
    TANREN_RUNNER_SSH_HOST_PORT: composePublishedPort(p.runnerSsh),
    TANREN_VAULT_HOST_PORT: composePublishedPort(p.vault),
    DASHBOARD_HOST_PORT: composePublishedPort(p.dashboard),
    TANREN_NTFY_HOST_PORT: composePublishedPort(p.ntfy),
    TANREN_REGISTRY_HOST_PORT: composePublishedPort(p.registry),
    TANREN_PUBLIC_BASE_URL: e.orchestrator,
    TANREN_DASHBOARD_URL: e.dashboard,
    TANREN_SEED_VAULT_ADDR: e.vault,
    VAULT_ADDR: e.vault,
    DATABASE_URL: e.postgresOwner,
    TANREN_APP_DATABASE_URL: e.postgresApp,
    TANREN_DATAPLANE_DATABASE_URL: e.postgresDataPlane,
    TANREN_CLAIM_ENDPOINT_SMOKE_URL: e.internalMtls,
    TANREN_SSH_HOST: e.runnerHost,
    TANREN_SSH_PORT: String(e.runnerPort),
    TANREN_SSH_USER: "tanren",
    TANREN_GITHUB_OAUTH_CLIENT_ID: "",
    TANREN_GITHUB_OAUTH_CLIENT_SECRET: "",
    TANREN_DEV_LOGIN: "0",
    TANREN_REQUIRE_AUTH: "0",
    TANREN_RUN_WORKER_CONCURRENCY: "2",
    TANREN_DATA_PLANE_REMOTE_WRITES: "1",
    TANREN_NTFY_BASE_URL: "http://ntfy:80",
    TANREN_NOTIFICATION_DEFAULT_CHANNEL: "ntfy",
    TANREN_NOTIFICATION_DEFAULT_DESTINATION: "tanren-smoke-alerts",
    TANREN_FLY_IMAGE_BUILDER: "0",
    TANREN_GITHUB_APP_CREDENTIAL_REF: "",
    TANREN_SECRETS_MODE: "dev-defaults",
  };
  if (options.seedCredential !== undefined) {
    resolved["TANREN_E2E_MANAGED_ROUTER_KEY"] = options.seedCredential;
  }
  return resolved;
}

/** Serialize the complete explicit Compose env (no implicit .env loading). */
export function serializeExplicitEnv(env: NodeJS.ProcessEnv): string {
  return `${Object.entries(env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value.replaceAll("\n", "\\n")}`)
    .join("\n")}\n`;
}

export function nonceScopedSeedCredential(nonce: string): string {
  return `smoke-sentinel-${nonce}`;
}

export function probeBindings(context: StackContext): Record<string, string> {
  const e = context.endpoints;
  const ports = context.publishedPorts ?? context.requestedPorts;
  return {
    orchestrator: `${e.orchestrator}/healthz`,
    dashboard: `${e.dashboard}/healthz`,
    allocator: `${e.allocator}/healthz`,
    vault: `${e.vault}/v1/sys/health`,
    ntfy: `${e.ntfy}/v1/health`,
    registry: `${e.registry}/v2/`,
    postgres: `127.0.0.1:${ports.postgres}`,
    ssh: `${e.runnerHost}:${e.runnerPort}`,
    mtls: e.internalMtls,
    cliDoctor: e.orchestrator,
    cliStatus: e.orchestrator,
  };
}
