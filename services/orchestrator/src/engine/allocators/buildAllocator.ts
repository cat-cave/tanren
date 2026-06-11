import type pg from "pg";
import type { Allocator } from "../contracts/allocator.js";
import type { SecretStore } from "../contracts/secretStore.js";
import { AllocatorRouter, type AllocatorRegistry } from "./allocatorRouter.js";
import { AwsEc2Allocator } from "./awsEc2Allocator.js";
import { DigitalOceanAllocator } from "./digitalOceanAllocator.js";
import { GcpAllocator } from "./gcpAllocator.js";
import { HetznerAllocator } from "./hetznerAllocator.js";
import { KubernetesAllocator } from "./kubernetesAllocator.js";
import { ManualSshAllocator, parseManualSshHosts } from "./manualSshAllocator.js";
import { AllocatorKind, AllocatorRoutingConfig } from "./poolPolicy.js";
import { PgRunnerStore, type RunnerStore } from "./runnerStore.js";
import { UnconfiguredAllocator } from "./scaffoldedAllocators.js";
import { resolveSidecarAuthToken, SidecarHttpAllocator } from "./sidecarHttpAllocator.js";
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

// Parse a runner SSH port from env. The host/port is DEPLOY INFRA (layer-1 env,
// correctly so — the runner topology is an operator-deployment concern, NOT
// per-org tenant config). But a malformed value must FAIL LOUD, not silently
// become NaN/0 (which the old `Number(env(...) ?? 22)` did — `Number("oops")` is
// NaN, passed straight to the SSH client). UNSET → the documented default; a SET
// value must parse to a valid TCP port (1..65535).
export function parseSshPort(name: string, fallback: number): number {
  const raw = env(name);
  if (raw === undefined) {
    return fallback;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `${name}='${raw}' is not a valid TCP port (expected an integer 1..65535). ` +
        "Unset it to use the default; a malformed port must NOT silently become NaN/0.",
    );
  }
  return port;
}

function buildStatic(runners: RunnerStore): StaticRunnerAllocator {
  // Dev-only: route to the long-lived dev compose static runner. Preserves the
  // security boundary (no docker socket on orchestrator) while keeping
  // `just smoke` working. See docs/operator-guide/runners.md. The host/port are
  // deploy-infra env (layer 1) — the port goes through a validated parse so a
  // malformed value fails loud (never a silent NaN).
  return new StaticRunnerAllocator({
    host: env("TANREN_RUNNER_SSH_HOST") ?? "runner",
    port: parseSshPort("TANREN_RUNNER_SSH_PORT", 22),
    username: env("TANREN_RUNNER_SSH_USER") ?? "tanren",
    hostKeyFingerprint: env("TANREN_RUNNER_SSH_HOST_FINGERPRINT"),
    runners,
  });
}

function buildSidecar(runners: RunnerStore): SidecarHttpAllocator {
  return new SidecarHttpAllocator({
    baseUrl: env("TANREN_ALLOCATOR_URL") ?? "http://allocator:3200",
    // File-preferred (Codex r5): prod mounts the sidecar bearer token as
    // `/run/secrets/tanren_allocator_token` (TANREN_ALLOCATOR_TOKEN_FILE), so the
    // token VALUE never lands in Docker env / `docker inspect`; dev sets the
    // plaintext env. File WINS; an empty mounted file fails loud.
    authToken: resolveSidecarAuthToken(),
    runners,
  });
}

function buildManualSsh(runners: RunnerStore): ManualSshAllocator {
  const raw = env("TANREN_MANUAL_SSH_HOSTS");
  if (raw === undefined) {
    throw new Error("manual_ssh allocator requires TANREN_MANUAL_SSH_HOSTS (JSON array of hosts)");
  }
  // Strict decode (Codex r4 §2): a bad host shape / blank field / out-of-range port
  // fails LOUD here at construction, never a cryptic later allocation/SSH failure.
  return new ManualSshAllocator({ hosts: parseManualSshHosts(raw), runners });
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
 *
 * `kind` MUST already be a parsed {@link AllocatorKind} (a closed enum value).
 * Parsing — and the loud throw on an unknown/typo'd value — happens at the entry
 * point ({@link buildAllocatorFromEnv}); the switch here is therefore exhaustive
 * over the enum with NO `default` fallthrough, so an unknown kind can NEVER
 * silently degrade to the sidecar allocator.
 */
async function buildSingle(kind: AllocatorKind, runners: RunnerStore, secrets: SecretStore): Promise<Allocator> {
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
    default: {
      const exhaustive: never = kind;
      throw new Error(`buildSingle: unhandled allocator kind ${String(exhaustive)}`);
    }
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
      default: {
        const exhaustive: never = kind;
        throw new Error(`build: unhandled allocator kind ${String(exhaustive)}`);
      }
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
 * - Any other kind (`static`, `sidecar`, `manual_ssh`, `hetzner`, …) builds that
 *   single allocator directly. The kind is parsed against the closed
 *   {@link AllocatorKind} enum: UNSET resolves to the documented default
 *   (`sidecar`), but a SET-yet-unknown/typo'd value is a LOUD config error — it
 *   NEVER silently degrades to the sidecar allocator.
 *
 * `secrets` is the SAME secret manager the SSH substrate reads from AND the seam
 * cloud-provider credentials are resolved through: a Hetzner/DO/GCP/AWS/K8s token
 * is a Vault REF in env, materialized to its VALUE here (never a plaintext env
 * value). Async for that resolution. Cloud allocators (Hetzner) also store the
 * ephemeral per-run SSH private key in `secrets`.
 */
/**
 * The closed `TANREN_ALLOCATOR_KIND` boot value: the parsed {@link AllocatorKind}
 * enum, or the sentinel `"router"`. UNSET → the documented default (`sidecar`);
 * a SET-yet-unknown/typo'd value is a LOUD config error — NEVER a silent
 * fall-through to the wrong allocator. This is the SINGLE parse both the
 * allocator builder AND the run-workspace reaper read through, so a typo can
 * never silently run the wrong allocator in one place and silently disable the
 * reaper in the other.
 */
export type BootedAllocatorKind = AllocatorKind | "router";

/**
 * Parse `TANREN_ALLOCATOR_KIND` into a {@link BootedAllocatorKind}, fail-loud on
 * an unknown/typo'd value (never a silent default). Used by both
 * {@link buildAllocatorFromEnv} (to pick the allocator) and the run-workspace
 * reaper (to decide whether the runner is a single long-lived `static` target it
 * can sweep). A typo must not silently run the wrong allocator NOR silently
 * disable the reaper.
 */
export function resolveBootedAllocatorKind(): BootedAllocatorKind {
  const rawKind = env("TANREN_ALLOCATOR_KIND");
  // UNSET → the documented default (`sidecar`), explicitly. A SET value is parsed
  // against the closed enum below — there is NO "unset = sidecar AND unknown =
  // sidecar" conflation: a typo'd kind must fail loud, not run the wrong allocator.
  if (rawKind === undefined) {
    return "sidecar";
  }
  const kind = rawKind.toLowerCase();
  if (kind === "router") {
    return "router";
  }
  // Parse the kind against the closed enum. An unknown/typo'd value is a LOUD
  // config error here (never a silent fall-through to the sidecar allocator).
  const parsed = AllocatorKind.safeParse(kind);
  if (!parsed.success) {
    const allowed = [...AllocatorKind.options, "router"].join(", ");
    throw new Error(
      `TANREN_ALLOCATOR_KIND='${rawKind}' is not a known allocator kind (expected one of: ${allowed}). ` +
        "Unset it to use the documented default (sidecar); a typo must NOT silently run the wrong allocator.",
    );
  }
  return parsed.data;
}

export async function buildAllocatorFromEnv(pool: pg.Pool, secrets: SecretStore): Promise<Allocator> {
  const runners = new PgRunnerStore(pool);
  const kind = resolveBootedAllocatorKind();

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
