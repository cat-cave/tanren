import type pg from "pg";
import type { Allocator } from "../contracts/allocator.js";
import type { SecretStore } from "../contracts/secretStore.js";
import { AllocatorRouter, type AllocatorRegistry } from "./allocatorRouter.js";
import { AwsEc2Allocator } from "./awsEc2Allocator.js";
import { DigitalOceanAllocator } from "./digitalOceanAllocator.js";
import { GcpAllocator } from "./gcpAllocator.js";
import { HetznerAllocator } from "./hetznerAllocator.js";
import { KubernetesAllocator } from "./kubernetesAllocator.js";
import { ManualSshAllocator, type ManualSshHost } from "./manualSshAllocator.js";
import { AllocatorRoutingConfig, type AllocatorKind } from "./poolPolicy.js";
import { PgRunnerStore, type RunnerStore } from "./runnerStore.js";
import { UnconfiguredAllocator } from "./scaffoldedAllocators.js";
import { SidecarHttpAllocator } from "./sidecarHttpAllocator.js";
import { StaticRunnerAllocator } from "./staticRunnerAllocator.js";

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

// Resolve a cloud-provider SECRET (API token / access key) through the SecretStore
// from a non-secret REF NAME carried in env (`<KIND>_..._REF`). The token VALUE is
// NEVER a plaintext env value — env names a Vault ref; the value is materialized
// here, at build time, from the same Vault seam the rest of Tanren uses. A ref
// that is unset OR resolves to nothing is a LOUD failure (no silent empty token):
// `whatRef` names the env var carrying the ref, `whatSecret` the credential.
async function resolveSecretRef(
  secrets: SecretStore,
  refEnvName: string,
  whatSecret: string,
): Promise<string | undefined> {
  const ref = env(refEnvName);
  if (ref === undefined) {
    return undefined;
  }
  const resolved = await secrets.get(ref);
  if (resolved === undefined || resolved.value === "") {
    throw new Error(
      `${refEnvName}=${ref} did not resolve to a ${whatSecret} in the secret store: the credential must be a ` +
        `Vault ref that resolves to a non-empty value (env carries the ref NAME, never the token VALUE).`,
    );
  }
  return resolved.value;
}

// Require a non-blank env var; throw a clear error when unset/blank (NO default).
// Mirrors the allocator-side `requireEnv` so both ends of the sidecar bearer-token
// pair fail loud rather than silently falling back to a `"dev"` token. Both
// compose profiles set TANREN_ALLOCATOR_TOKEN.
function requireEnv(name: string): string {
  const value = env(name);
  if (value === undefined) {
    throw new Error(`${name} is required (set it in the environment; there is no default)`);
  }
  return value;
}

function buildStatic(runners: RunnerStore): StaticRunnerAllocator {
  // Dev-only: route to the long-lived dev compose static runner. Preserves the
  // security boundary (no docker socket on orchestrator) while keeping
  // `just smoke` working. See docs/operator-guide/runners.md.
  return new StaticRunnerAllocator({
    host: env("TANREN_RUNNER_SSH_HOST") ?? "runner",
    port: Number(env("TANREN_RUNNER_SSH_PORT") ?? 22),
    username: env("TANREN_RUNNER_SSH_USER") ?? "tanren",
    hostKeyFingerprint: env("TANREN_RUNNER_SSH_HOST_FINGERPRINT"),
    runners,
  });
}

function buildSidecar(runners: RunnerStore): SidecarHttpAllocator {
  return new SidecarHttpAllocator({
    baseUrl: env("TANREN_ALLOCATOR_URL") ?? "http://allocator:3200",
    authToken: requireEnv("TANREN_ALLOCATOR_TOKEN"),
    runners,
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

async function buildHetzner(runners: RunnerStore, secrets: SecretStore): Promise<HetznerAllocator> {
  // The API token is a SECRET, resolved through the SecretStore from a Vault ref
  // named by TANREN_HETZNER_API_TOKEN_REF — never a plaintext env value. SSH is
  // fully Tanren-managed: the allocator generates an ephemeral per-run keypair
  // (stored in `secrets`, uploaded to Hetzner) and a known host key it pins itself
  // — so there is NO manual TANREN_HETZNER_SSH_KEYS and NO manual
  // TANREN_HETZNER_HOST_FINGERPRINT.
  const apiToken = await resolveSecretRef(secrets, "TANREN_HETZNER_API_TOKEN_REF", "Hetzner API token");
  if (apiToken === undefined) {
    throw new Error("hetzner allocator requires TANREN_HETZNER_API_TOKEN_REF (a Vault ref to the API token)");
  }
  return new HetznerAllocator({
    apiToken,
    serverType: env("TANREN_HETZNER_SERVER_TYPE") ?? "cx22",
    image: env("TANREN_HETZNER_IMAGE") ?? "docker-ce",
    location: env("TANREN_HETZNER_LOCATION"),
    extraWriteFiles: env("TANREN_HETZNER_EXTRA_CLOUD_INIT_WRITE_FILES"),
    sshUsername: env("TANREN_HETZNER_SSH_USER") ?? "root",
    secrets,
    runners,
  });
}

async function buildDigitalOcean(runners: RunnerStore, secrets: SecretStore): Promise<DigitalOceanAllocator> {
  // The API token is a SECRET, resolved through the SecretStore from a Vault ref
  // named by TANREN_DO_API_TOKEN_REF — never a plaintext env value. The host-key
  // fingerprint is non-secret config and stays a plain env value.
  const apiToken = await resolveSecretRef(secrets, "TANREN_DO_API_TOKEN_REF", "DigitalOcean API token");
  const hostKeyFingerprint = env("TANREN_DO_HOST_FINGERPRINT");
  if (apiToken === undefined || hostKeyFingerprint === undefined) {
    throw new Error("digitalocean allocator requires TANREN_DO_API_TOKEN_REF and TANREN_DO_HOST_FINGERPRINT");
  }
  return new DigitalOceanAllocator({
    apiToken,
    hostKeyFingerprint,
    region: env("TANREN_DO_REGION") ?? "nyc3",
    size: env("TANREN_DO_SIZE") ?? "s-1vcpu-1gb",
    image: env("TANREN_DO_IMAGE") ?? "docker-20-04",
    sshKeys: env("TANREN_DO_SSH_KEYS")
      ?.split(",")
      .map((s) => s.trim()),
    sshUsername: env("TANREN_DO_SSH_USER") ?? "root",
    runners,
  });
}

async function buildGcp(runners: RunnerStore, secrets: SecretStore): Promise<GcpAllocator> {
  // The access token is a SECRET, resolved through the SecretStore from a Vault
  // ref named by TANREN_GCP_ACCESS_TOKEN_REF — never a plaintext env value. The
  // project/zone/ssh-public-key/host-fingerprint are non-secret config.
  const accessToken = await resolveSecretRef(secrets, "TANREN_GCP_ACCESS_TOKEN_REF", "GCP access token");
  const project = env("TANREN_GCP_PROJECT");
  const zone = env("TANREN_GCP_ZONE");
  const sshPublicKey = env("TANREN_GCP_SSH_PUBLIC_KEY");
  const hostKeyFingerprint = env("TANREN_GCP_HOST_FINGERPRINT");
  if (
    accessToken === undefined ||
    project === undefined ||
    zone === undefined ||
    sshPublicKey === undefined ||
    hostKeyFingerprint === undefined
  ) {
    throw new Error(
      "gcp allocator requires TANREN_GCP_ACCESS_TOKEN_REF, TANREN_GCP_PROJECT, TANREN_GCP_ZONE, " +
        "TANREN_GCP_SSH_PUBLIC_KEY, and TANREN_GCP_HOST_FINGERPRINT",
    );
  }
  return new GcpAllocator({
    accessToken,
    project,
    zone,
    hostKeyFingerprint,
    sshPublicKey,
    machineType: env("TANREN_GCP_MACHINE_TYPE") ?? "e2-small",
    sourceImage: env("TANREN_GCP_IMAGE") ?? "projects/cos-cloud/global/images/family/cos-stable",
    sshUsername: env("TANREN_GCP_SSH_USER") ?? "tanren",
    runners,
  });
}

async function buildAwsEc2(runners: RunnerStore, secrets: SecretStore): Promise<AwsEc2Allocator> {
  // The access-key id + secret-access-key (and optional session token) are SECRETS,
  // each resolved through the SecretStore from a Vault ref (`*_REF`) — never
  // plaintext env values. The region/image/host-fingerprint are non-secret config.
  const accessKeyId = await resolveSecretRef(secrets, "TANREN_AWS_ACCESS_KEY_ID_REF", "AWS access key id");
  const secretAccessKey = await resolveSecretRef(secrets, "TANREN_AWS_SECRET_ACCESS_KEY_REF", "AWS secret access key");
  const sessionToken = await resolveSecretRef(secrets, "TANREN_AWS_SESSION_TOKEN_REF", "AWS session token");
  const region = env("TANREN_AWS_REGION");
  const imageId = env("TANREN_AWS_IMAGE_ID");
  const hostKeyFingerprint = env("TANREN_AWS_HOST_FINGERPRINT");
  if (
    accessKeyId === undefined ||
    secretAccessKey === undefined ||
    region === undefined ||
    imageId === undefined ||
    hostKeyFingerprint === undefined
  ) {
    throw new Error(
      "aws_ec2 allocator requires TANREN_AWS_ACCESS_KEY_ID_REF, TANREN_AWS_SECRET_ACCESS_KEY_REF, " +
        "TANREN_AWS_REGION, TANREN_AWS_IMAGE_ID, and TANREN_AWS_HOST_FINGERPRINT",
    );
  }
  return new AwsEc2Allocator({
    accessKeyId,
    secretAccessKey,
    sessionToken,
    region,
    imageId,
    hostKeyFingerprint,
    instanceType: env("TANREN_AWS_INSTANCE_TYPE") ?? "t3.small",
    keyName: env("TANREN_AWS_KEY_NAME"),
    subnetId: env("TANREN_AWS_SUBNET_ID"),
    securityGroupIds: env("TANREN_AWS_SECURITY_GROUP_IDS")
      ?.split(",")
      .map((s) => s.trim()),
    userData: env("TANREN_AWS_USER_DATA"),
    sshUsername: env("TANREN_AWS_SSH_USER") ?? "ec2-user",
    runners,
  });
}

async function buildKubernetes(runners: RunnerStore, secrets: SecretStore): Promise<KubernetesAllocator> {
  // The service-account token is a SECRET. TANREN_K8S_TOKEN_REF names a Vault ref;
  // the token VALUE is resolved through the SecretStore here — previously the env
  // was (mis)passed straight through as the token VALUE despite the `_REF` name.
  // The api-server/namespace/image/ssh-public-key/host-fingerprint are non-secret.
  const apiServer = env("TANREN_K8S_API_SERVER");
  const token = await resolveSecretRef(secrets, "TANREN_K8S_TOKEN_REF", "Kubernetes service-account token");
  const namespace = env("TANREN_K8S_NAMESPACE");
  const runnerImage = env("TANREN_K8S_RUNNER_IMAGE");
  const sshPublicKey = env("TANREN_K8S_SSH_PUBLIC_KEY");
  const hostKeyFingerprint = env("TANREN_K8S_HOST_FINGERPRINT");
  if (
    apiServer === undefined ||
    token === undefined ||
    namespace === undefined ||
    runnerImage === undefined ||
    sshPublicKey === undefined ||
    hostKeyFingerprint === undefined
  ) {
    throw new Error(
      "kubernetes allocator requires TANREN_K8S_API_SERVER, TANREN_K8S_TOKEN_REF, " +
        "TANREN_K8S_NAMESPACE, TANREN_K8S_RUNNER_IMAGE, TANREN_K8S_SSH_PUBLIC_KEY, " +
        "and TANREN_K8S_HOST_FINGERPRINT",
    );
  }
  return new KubernetesAllocator({
    apiServer,
    token,
    namespace,
    runnerImage,
    sshPublicKey,
    hostKeyFingerprint,
    caPem: env("TANREN_K8S_CA_PEM"),
    sshUsername: env("TANREN_K8S_SSH_USER") ?? "tanren",
    runners,
  });
}

/**
 * Builds the single allocator kind named by `kind`. This is the non-router path
 * used by the existing `static` / `sidecar` deployments. Async because the cloud
 * builders resolve their credential SECRETS through the SecretStore (Vault refs).
 */
async function buildSingle(kind: string, runners: RunnerStore, secrets: SecretStore): Promise<Allocator> {
  switch (kind) {
    case "static":
      return buildStatic(runners);
    case "manual_ssh":
      return buildManualSsh(runners);
    case "hetzner":
      return buildHetzner(runners, secrets);
    case "digitalocean":
      return buildDigitalOcean(runners, secrets);
    case "gcp":
      return buildGcp(runners, secrets);
    case "aws_ec2":
      return buildAwsEc2(runners, secrets);
    case "kubernetes":
      return buildKubernetes(runners, secrets);
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
 * Kinds the routing config never selects resolve to throwing UnconfiguredAllocator
 * stubs (their credentials are never loaded).
 */
async function buildRegistry(
  runners: RunnerStore,
  secrets: SecretStore,
  config: AllocatorRoutingConfig,
): Promise<AllocatorRegistry> {
  // Determine which kinds the routing config can actually select.
  const usedKinds = new Set<AllocatorKind>([config.defaultAllocator]);
  for (const rule of config.rules) {
    usedKinds.add(rule.allocator);
  }

  const build = async (kind: AllocatorKind): Promise<Allocator> => {
    switch (kind) {
      case "static":
        return buildStatic(runners);
      case "sidecar":
        return buildSidecar(runners);
      case "manual_ssh":
        return usedKinds.has("manual_ssh") ? buildManualSsh(runners) : new UnconfiguredAllocator("manual_ssh");
      case "hetzner":
        return usedKinds.has("hetzner") ? buildHetzner(runners, secrets) : new UnconfiguredAllocator("hetzner");
      case "digitalocean":
        return usedKinds.has("digitalocean")
          ? buildDigitalOcean(runners, secrets)
          : new UnconfiguredAllocator("digitalocean");
      case "gcp":
        return usedKinds.has("gcp") ? buildGcp(runners, secrets) : new UnconfiguredAllocator("gcp");
      case "aws_ec2":
        return usedKinds.has("aws_ec2") ? buildAwsEc2(runners, secrets) : new UnconfiguredAllocator("aws_ec2");
      case "kubernetes":
        return usedKinds.has("kubernetes")
          ? buildKubernetes(runners, secrets)
          : new UnconfiguredAllocator("kubernetes");
    }
  };

  const [staticA, sidecar, manual_ssh, hetzner, digitalocean, gcp, aws_ec2, kubernetes] = await Promise.all([
    build("static"),
    build("sidecar"),
    build("manual_ssh"),
    build("hetzner"),
    build("digitalocean"),
    build("gcp"),
    build("aws_ec2"),
    build("kubernetes"),
  ]);
  return { static: staticA, sidecar, manual_ssh, hetzner, digitalocean, gcp, aws_ec2, kubernetes };
}

/**
 * Selects and constructs the orchestrator allocator from environment.
 *
 * - `TANREN_ALLOCATOR_KIND=router` builds an {@link AllocatorRouter} over every
 *   kind, driven by `TANREN_ALLOCATOR_ROUTING` (a JSON {@link AllocatorRoutingConfig}).
 *   Label routing + pool policy live here.
 * - Any other kind (`static`, `sidecar`, `manual_ssh`, `hetzner`) builds that
 *   single allocator directly (backward compatible; default is `sidecar`).
 *
 * `secrets` is the SAME secret manager the SSH substrate reads from AND the seam
 * cloud-provider credentials are resolved through: a Hetzner/DO/GCP/AWS/K8s token
 * is a Vault REF in env, materialized to its VALUE here (never a plaintext env
 * value). Async for that resolution. Cloud allocators (Hetzner) also store the
 * ephemeral per-run SSH private key in `secrets`.
 */
export async function buildAllocatorFromEnv(pool: pg.Pool, secrets: SecretStore): Promise<Allocator> {
  const runners = new PgRunnerStore(pool);
  const kind = (env("TANREN_ALLOCATOR_KIND") ?? "sidecar").toLowerCase();

  if (kind === "router") {
    const raw = env("TANREN_ALLOCATOR_ROUTING");
    if (raw === undefined) {
      throw new Error("router allocator requires TANREN_ALLOCATOR_ROUTING (JSON routing config)");
    }
    const config = AllocatorRoutingConfig.parse(JSON.parse(raw));
    return new AllocatorRouter(await buildRegistry(runners, secrets, config), config);
  }

  return buildSingle(kind, runners, secrets);
}
