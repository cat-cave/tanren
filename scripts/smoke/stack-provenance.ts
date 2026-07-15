import type { HostPorts, PortName, StackContext } from "./stack-context.js";
import { probeBindings } from "./stack-context.js";

// cspell:ignore opencontainers

export const BUILD_ID_LABEL = "io.tanren.smoke.build-id";
export const SERVICE_LABEL = "io.tanren.smoke.service";
export const REVISION_LABEL = "org.opencontainers.image.revision";
export const TREE_LABEL = "io.tanren.source-tree";

export const BUILT_SERVICES = ["orchestrator", "worker", "allocator", "dashboard", "runner"] as const;
export const STACK_SERVICES = [
  "postgres",
  "vault",
  "orchestrator",
  "worker",
  "allocator",
  "dashboard",
  "runner",
  "ntfy",
  "registry",
] as const;

export type BuiltService = (typeof BUILT_SERVICES)[number];
export type StackService = (typeof STACK_SERVICES)[number];

interface InspectImage {
  Id?: unknown;
  ID?: unknown;
  Config?: { Labels?: unknown };
  Labels?: unknown;
}

interface InspectContainer {
  Id?: unknown;
  ID?: unknown;
  Image?: unknown;
  Config?: { Labels?: unknown; Image?: unknown; Env?: unknown };
  State?: { Status?: unknown; Running?: unknown };
}

export interface ImageEvidence {
  service: BuiltService;
  imageId: string;
  revision: string;
  tree: string;
  buildId: string;
}

export interface ContainerEvidence {
  service: StackService;
  containerId: string;
  imageId: string;
  project: string;
  workingDir: string;
  publicBaseUrl?: string;
}

export interface ProvenanceSnapshot {
  images: Record<BuiltService, ImageEvidence>;
  containers: Record<StackService, ContainerEvidence>;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function labels(value: unknown): Record<string, string> {
  const raw = object(value ?? {}, "inspect labels");
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is missing from runtime inspect`);
  return value;
}

function normalizeId(value: unknown, label: string): string {
  return requiredString(value, label)
    .replace(/^sha256:/u, "")
    .toLowerCase();
}

function parseInspectArray<T>(raw: string, label: string): T[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} was not JSON: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  if (!Array.isArray(parsed)) throw new Error(`${label} must be a JSON array`);
  return parsed as T[];
}

function isBuiltService(value: string): value is BuiltService {
  return (BUILT_SERVICES as readonly string[]).includes(value);
}

function isStackService(value: string): value is StackService {
  return (STACK_SERVICES as readonly string[]).includes(value);
}

export function validateBuiltImages(context: StackContext, rawInspect: string): Record<BuiltService, ImageEvidence> {
  const result = {} as Record<BuiltService, ImageEvidence>;
  for (const image of parseInspectArray<InspectImage>(rawInspect, "image inspect")) {
    const imageLabels = labels(image.Config?.Labels ?? image.Labels);
    if (imageLabels[BUILD_ID_LABEL] !== context.buildId) continue;
    const service = imageLabels[SERVICE_LABEL] ?? "";
    if (!isBuiltService(service)) throw new Error(`image has invalid ${SERVICE_LABEL}: ${JSON.stringify(service)}`);
    if (result[service] !== undefined)
      throw new Error(`build produced duplicate ${service} images for ${context.buildId}`);
    const revision = imageLabels[REVISION_LABEL];
    const tree = imageLabels[TREE_LABEL];
    if (revision !== context.head || tree !== context.tree) {
      throw new Error(
        `${service} image provenance mismatch: revision=${String(revision)} tree=${String(tree)} ` +
          `expected=${context.head}/${context.tree}`,
      );
    }
    result[service] = {
      service,
      imageId: normalizeId(image.Id ?? image.ID, `${service} image id`),
      revision,
      tree,
      buildId: context.buildId,
    };
  }
  const missing = BUILT_SERVICES.filter((service) => result[service] === undefined);
  if (missing.length > 0) throw new Error(`build provenance missing services: ${missing.join(", ")}`);
  return result;
}

function composeLabel(containerLabels: Record<string, string>, suffix: string): string | undefined {
  return containerLabels[`com.docker.compose.${suffix}`] ?? containerLabels[`io.podman.compose.${suffix}`];
}

function environmentValue(value: unknown, name: string): string | undefined {
  if (!Array.isArray(value)) throw new Error("container environment must be an array");
  const prefix = `${name}=`;
  const matches = value.filter((entry): entry is string => typeof entry === "string" && entry.startsWith(prefix));
  if (matches.length > 1) throw new Error(`container environment repeats ${name}`);
  return matches[0]?.slice(prefix.length);
}

export function validateContainers(
  context: StackContext,
  images: Record<BuiltService, ImageEvidence>,
  rawInspect: string,
): Record<StackService, ContainerEvidence> {
  const result = {} as Record<StackService, ContainerEvidence>;
  for (const container of parseInspectArray<InspectContainer>(rawInspect, "container inspect")) {
    const containerLabels = labels(container.Config?.Labels);
    const project = composeLabel(containerLabels, "project");
    if (project !== context.project) continue;
    const service = composeLabel(containerLabels, "service") ?? "";
    if (!isStackService(service))
      throw new Error(`container has unexpected compose service ${JSON.stringify(service)}`);
    if (result[service] !== undefined) throw new Error(`compose project has duplicate ${service} containers`);
    const status = container.State?.Status;
    const running = container.State?.Running;
    if (status !== "running" || running !== true) {
      throw new Error(
        `${service} container state inconsistent or not running (status=${String(status)}, running=${String(running)})`,
      );
    }
    const workingDir = composeLabel(containerLabels, "project.working_dir");
    if (workingDir !== context.executionRoot) {
      throw new Error(
        `${service} belongs to working directory ${String(workingDir)}, expected ${context.executionRoot}`,
      );
    }
    const imageId = normalizeId(container.Image, `${service} container image id`);
    if (isBuiltService(service) && imageId !== images[service].imageId) {
      throw new Error(`${service} runs image ${imageId}, expected freshly built ${images[service].imageId}`);
    }
    const publicBaseUrl =
      service === "orchestrator" ? environmentValue(container.Config?.Env, "TANREN_PUBLIC_BASE_URL") : undefined;
    if (service === "orchestrator" && publicBaseUrl !== context.endpoints.orchestrator) {
      throw new Error(
        `orchestrator public URL is ${String(publicBaseUrl)}, expected discovered candidate ${context.endpoints.orchestrator}`,
      );
    }
    result[service] = {
      service,
      containerId: normalizeId(container.Id ?? container.ID, `${service} container id`),
      imageId,
      project,
      workingDir,
      ...(publicBaseUrl === undefined ? {} : { publicBaseUrl }),
    };
  }
  const missing = STACK_SERVICES.filter((service) => result[service] === undefined);
  if (missing.length > 0) throw new Error(`compose provenance missing running services: ${missing.join(", ")}`);
  return result;
}

/**
 * Read the orchestrator's effective `TANREN_PUBLIC_BASE_URL` from raw container
 * inspect output. Returns `undefined` when no orchestrator container is present.
 * Used by `bind-discovered-config` to prove a rebind actually took effect rather
 * than trusting a compose wrapper's exit code (podman-compose returns 0 while
 * printing dependency errors when force-recreating a service that has dependents).
 */
export function orchestratorPublicBaseUrlFromInspect(rawInspect: string): string | undefined {
  for (const container of parseInspectArray<InspectContainer>(rawInspect, "orchestrator inspect")) {
    const containerLabels = labels(container.Config?.Labels);
    if (composeLabel(containerLabels, "service") === "orchestrator") {
      return environmentValue(container.Config?.Env, "TANREN_PUBLIC_BASE_URL");
    }
  }
  return undefined;
}

export function assertDiscoveredPorts(requested: HostPorts, discovered: HostPorts): void {
  const published = Object.values(discovered);
  if (published.some((port) => !Number.isSafeInteger(port) || port < 1 || port > 65_535)) {
    throw new Error(`runtime returned an invalid published port set: ${JSON.stringify(discovered)}`);
  }
  if (new Set(published).size !== published.length) {
    throw new Error(`runtime reused a published port inside one smoke stack: ${JSON.stringify(discovered)}`);
  }
  for (const name of Object.keys(requested) as PortName[]) {
    if (requested[name] !== 0 && requested[name] !== discovered[name]) {
      throw new Error(`${name} published on ${discovered[name]}, expected requested candidate port ${requested[name]}`);
    }
  }
}

export function assertGitIdentity(context: StackContext, head: string, tree: string): void {
  if (head !== context.head || tree !== context.tree) {
    throw new Error(`Git identity changed during smoke: ${head}/${tree}, expected ${context.head}/${context.tree}`);
  }
}

export function assertGitWorktreeClean(porcelain: string): void {
  if (porcelain.trim() !== "") {
    throw new Error(`Git worktree changed during smoke:\n${porcelain}`);
  }
}

export function assertStableContainers(
  initial: Record<StackService, ContainerEvidence>,
  final: Record<StackService, ContainerEvidence>,
): void {
  for (const service of STACK_SERVICES) {
    if (
      initial[service].containerId !== final[service].containerId ||
      initial[service].imageId !== final[service].imageId
    ) {
      throw new Error(`${service} container/image changed during smoke`);
    }
  }
}

export function assertSemanticHealth(service: string, value: unknown): void {
  const body = object(value, `${service} health body`);
  switch (service) {
    case "orchestrator": {
      const vault = object(body["vault"], "orchestrator vault health");
      if (body["ok"] !== true || body["database"] !== "ok" || vault["ok"] !== true) {
        throw new Error(`orchestrator health is not semantically green: ${JSON.stringify(body)}`);
      }
      return;
    }
    case "dashboard":
      if (body["ok"] !== true || body["orchestrator"] !== true) {
        throw new Error(`dashboard health is not semantically green: ${JSON.stringify(body)}`);
      }
      return;
    case "allocator":
      if (body["ok"] !== true) {
        throw new Error(`allocator health is not semantically green: ${JSON.stringify(body)}`);
      }
      return;
    case "vault":
      if (body["initialized"] !== true || body["sealed"] !== false) {
        throw new Error(`vault health is not ready: ${JSON.stringify(body)}`);
      }
      return;
    case "ntfy":
      if (body["healthy"] !== true) {
        throw new Error(`ntfy health is not green: ${JSON.stringify(body)}`);
      }
      return;
    default:
      throw new Error(`unsupported semantic health probe ${service}`);
  }
}

export function assertRegistryHealth(response: Pick<Response, "headers" | "ok" | "status">): void {
  const apiVersion = response.headers.get("docker-distribution-api-version");
  if (!response.ok || apiVersion?.toLowerCase() !== "registry/2.0") {
    throw new Error(
      `candidate registry health is not semantic: HTTP ${response.status}, ` +
        `Docker-Distribution-Api-Version=${JSON.stringify(apiVersion)}`,
    );
  }
}

export function assertProbeBindings(context: StackContext, actual: Record<string, string>): void {
  const expected = probeBindings(context);
  for (const [probe, target] of Object.entries(expected)) {
    if (actual[probe] !== target) {
      throw new Error(`${probe} probe targeted ${String(actual[probe])}, expected candidate ${target}`);
    }
  }
}
