import type pg from "pg";
import type { Allocator } from "../contracts/allocator.js";
import { AllocatorRouter, type AllocatorRegistry } from "./allocatorRouter.js";
import { DigitalOceanAllocator } from "./digitalOceanAllocator.js";
import { HetznerAllocator } from "./hetznerAllocator.js";
import { ManualSshAllocator, type ManualSshHost } from "./manualSshAllocator.js";
import { AllocatorRoutingConfig, type AllocatorKind } from "./poolPolicy.js";
import { PgRunnerStore, type RunnerStore } from "./runnerStore.js";
import { AwsEc2Allocator, KubernetesAllocator, UnconfiguredAllocator } from "./scaffoldedAllocators.js";
import { SidecarHttpAllocator } from "./sidecarHttpAllocator.js";
import { StaticRunnerAllocator } from "./staticRunnerAllocator.js";

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

function buildStatic(runners: RunnerStore): StaticRunnerAllocator {
  // Dev-only: route to the long-lived dev compose static runner. Preserves the
  // P2A-0010 security boundary (no docker socket on orchestrator) while keeping
  // `just smoke` working. See docs/operator-guide/runners.md.
  return new StaticRunnerAllocator({
    host: env("TANREN_RUNNER_SSH_HOST") ?? "runner",
    port: Number(env("TANREN_RUNNER_SSH_PORT") ?? 22),
    username: env("TANREN_RUNNER_SSH_USER") ?? "tanren",
    hostKeyFingerprint: env("TANREN_RUNNER_SSH_HOST_FINGERPRINT"),
    runners
  });
}

function buildSidecar(runners: RunnerStore): SidecarHttpAllocator {
  return new SidecarHttpAllocator({
    baseUrl: env("TANREN_ALLOCATOR_URL") ?? "http://allocator:3200",
    authToken: env("TANREN_ALLOCATOR_TOKEN") ?? "dev",
    runners
  });
}

function buildManualSsh(runners: RunnerStore): ManualSshAllocator {
  const raw = env("TANREN_MANUAL_SSH_HOSTS");
  if (raw === undefined) {
    throw new Error("manual_ssh allocator requires TANREN_MANUAL_SSH_HOSTS (JSON array of hosts)");
  }
  const hosts = JSON.parse(raw) as ManualSshHost[];
  return new ManualSshAllocator({ hosts, runners });
}

function buildHetzner(runners: RunnerStore): HetznerAllocator {
  // The token is a resolved secret here. In production it is sourced from a
  // Vault ref by the operator's secret tooling, never hardcoded.
  const apiToken = env("TANREN_HETZNER_API_TOKEN");
  const hostKeyFingerprint = env("TANREN_HETZNER_HOST_FINGERPRINT");
  if (apiToken === undefined || hostKeyFingerprint === undefined) {
    throw new Error(
      "hetzner allocator requires TANREN_HETZNER_API_TOKEN and TANREN_HETZNER_HOST_FINGERPRINT"
    );
  }
  return new HetznerAllocator({
    apiToken,
    hostKeyFingerprint,
    serverType: env("TANREN_HETZNER_SERVER_TYPE") ?? "cx22",
    image: env("TANREN_HETZNER_IMAGE") ?? "docker-ce",
    location: env("TANREN_HETZNER_LOCATION"),
    sshKeys: env("TANREN_HETZNER_SSH_KEYS")?.split(",").map((s) => s.trim()),
    sshUsername: env("TANREN_HETZNER_SSH_USER") ?? "root",
    runners
  });
}

function buildDigitalOcean(runners: RunnerStore): DigitalOceanAllocator {
  // The token is a resolved secret here. In production it is sourced from a
  // Vault ref by the operator's secret tooling, never hardcoded.
  const apiToken = env("TANREN_DO_API_TOKEN");
  const hostKeyFingerprint = env("TANREN_DO_HOST_FINGERPRINT");
  if (apiToken === undefined || hostKeyFingerprint === undefined) {
    throw new Error(
      "digitalocean allocator requires TANREN_DO_API_TOKEN and TANREN_DO_HOST_FINGERPRINT"
    );
  }
  return new DigitalOceanAllocator({
    apiToken,
    hostKeyFingerprint,
    region: env("TANREN_DO_REGION") ?? "nyc3",
    size: env("TANREN_DO_SIZE") ?? "s-1vcpu-1gb",
    image: env("TANREN_DO_IMAGE") ?? "docker-20-04",
    sshKeys: env("TANREN_DO_SSH_KEYS")?.split(",").map((s) => s.trim()),
    sshUsername: env("TANREN_DO_SSH_USER") ?? "root",
    runners
  });
}

/**
 * Builds the single allocator kind named by `kind`, or throws for the
 * scaffolded kinds (which only exist behind the router registry). This is the
 * non-router path used by the existing `static` / `sidecar` deployments.
 */
function buildSingle(kind: string, runners: RunnerStore): Allocator {
  switch (kind) {
    case "static":
      return buildStatic(runners);
    case "manual_ssh":
      return buildManualSsh(runners);
    case "hetzner":
      return buildHetzner(runners);
    case "digitalocean":
      return buildDigitalOcean(runners);
    case "sidecar":
      return buildSidecar(runners);
    default:
      return buildSidecar(runners);
  }
}

/**
 * Builds the full registry over every allocator kind for the router. Cloud
 * kinds that need credentials are constructed lazily-ish: manual/hetzner throw
 * at build time if their env is missing, so the router is only assembled when
 * the operator opts into routing and has configured the kinds they route to.
 * Scaffolded kinds always resolve to throwing stubs.
 */
function buildRegistry(runners: RunnerStore, config: AllocatorRoutingConfig): AllocatorRegistry {
  // Determine which kinds the routing config can actually select.
  const usedKinds = new Set<AllocatorKind>([config.defaultAllocator]);
  for (const rule of config.rules) {
    usedKinds.add(rule.allocator);
  }

  const build = (kind: AllocatorKind): Allocator => {
    switch (kind) {
      case "static":
        return buildStatic(runners);
      case "sidecar":
        return buildSidecar(runners);
      case "manual_ssh":
        return usedKinds.has("manual_ssh") ? buildManualSsh(runners) : new UnconfiguredAllocator("manual_ssh");
      case "hetzner":
        return usedKinds.has("hetzner") ? buildHetzner(runners) : new UnconfiguredAllocator("hetzner");
      case "digitalocean":
        return usedKinds.has("digitalocean")
          ? buildDigitalOcean(runners)
          : new UnconfiguredAllocator("digitalocean");
      case "aws_ec2":
        return new AwsEc2Allocator();
      case "kubernetes":
        return new KubernetesAllocator();
    }
  };

  return {
    static: build("static"),
    sidecar: build("sidecar"),
    manual_ssh: build("manual_ssh"),
    hetzner: build("hetzner"),
    digitalocean: build("digitalocean"),
    aws_ec2: build("aws_ec2"),
    kubernetes: build("kubernetes")
  };
}

/**
 * Selects and constructs the orchestrator allocator from environment.
 *
 * - `TANREN_ALLOCATOR_KIND=router` builds an {@link AllocatorRouter} over every
 *   kind, driven by `TANREN_ALLOCATOR_ROUTING` (a JSON {@link AllocatorRoutingConfig}).
 *   Label routing + pool policy live here.
 * - Any other kind (`static`, `sidecar`, `manual_ssh`, `hetzner`) builds that
 *   single allocator directly (backward compatible; default is `sidecar`).
 */
export function buildAllocatorFromEnv(pool: pg.Pool): Allocator {
  const runners = new PgRunnerStore(pool);
  const kind = (env("TANREN_ALLOCATOR_KIND") ?? "sidecar").toLowerCase();

  if (kind === "router") {
    const raw = env("TANREN_ALLOCATOR_ROUTING");
    if (raw === undefined) {
      throw new Error("router allocator requires TANREN_ALLOCATOR_ROUTING (JSON routing config)");
    }
    const config = AllocatorRoutingConfig.parse(JSON.parse(raw));
    return new AllocatorRouter(buildRegistry(runners, config), config);
  }

  return buildSingle(kind, runners);
}
