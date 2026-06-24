import {
  persistedRunnerKeys,
  sshRunnerHandle,
  type AllocationRequest,
  type Allocator,
  type ReleaseReason,
  type RunnerAllocation,
} from "../contracts/allocator.js";
import type { SecretStore } from "../contracts/secretStore.js";
import {
  buildKnownHostKeyCloudInit,
  generateEd25519KeyPair,
  hostKeyFingerprintFromPublicKey,
  type KeyPairGenerator,
} from "../ssh/keygen.js";
import {
  PersistentProvisioningOutageError,
  ProvisioningTerminalStateError,
  UnknownProvisioningStateError,
  pollUntilReady,
  type ReadinessClassification,
} from "./readinessConvergence.js";
import type { RunnerStore } from "./runnerStore.js";

const allocatorName = "hetzner";
const hetznerApiBase = "https://api.hetzner.cloud/v1";

/**
 * Hetzner Cloud documented server lifecycle statuses the allocator EXPECTS to
 * see as an intermediate state on the path to `running`. Anything outside this
 * set OR {@link HETZNER_TERMINAL_STATUSES} is `unknown_state` (fail-closed
 * ratchet). Hetzner documents: `initializing`, `starting`, `running`, `stopping`,
 * `off`, `deleting`, `rebuilding`, `migrating`, `unknown`.
 */
const HETZNER_PROVISIONING_STATUSES: ReadonlySet<string> = new Set([
  "initializing",
  "starting",
  "running",
  "rebuilding",
  "migrating",
]);

/**
 * Hetzner Cloud documented terminal statuses — a server in these states cannot
 * recover by waiting (it is being torn down, already stopped, or the API has
 * lost visibility into it). Fires `terminal_error` IMMEDIATELY.
 */
const HETZNER_TERMINAL_STATUSES: ReadonlySet<string> = new Set(["stopping", "off", "deleting", "unknown"]);

/**
 * Minimal injectable HTTP client over the Hetzner Cloud API. Only the shapes
 * the allocator needs are modeled; everything else passes through untouched.
 * Tests inject a fake; production uses {@link fetchHetznerClient}.
 */
export interface HetznerClient {
  createSshKey(input: HetznerCreateSshKeyInput): Promise<HetznerSshKey>;
  deleteSshKey(sshKeyId: number): Promise<void>;
  createServer(input: HetznerCreateServerInput): Promise<HetznerServer>;
  getServer(serverId: number): Promise<HetznerServer>;
  deleteServer(serverId: number): Promise<void>;
}

export interface HetznerCreateSshKeyInput {
  name: string;
  /** The single-line `ssh-ed25519 AAAA...` authorized-keys form. */
  publicKey: string;
  labels?: Record<string, string>;
}

export interface HetznerSshKey {
  id: number;
}

export interface HetznerCreateServerInput {
  name: string;
  serverType: string;
  image: string;
  location?: string;
  /** Hetzner SSH key ids authorized for root on the new server. */
  sshKeys?: ReadonlyArray<string | number>;
  /** cloud-init user data, e.g. to install the runner agent + host key. */
  userData?: string;
  labels?: Record<string, string>;
}

export interface HetznerServer {
  id: number;
  status: string;
  publicIpv4?: string;
}

export interface HetznerAllocatorOptions {
  /** Vault-resolved API token. Never hardcode; pass a resolved secret here. */
  apiToken: string;
  /** Hetzner server type, e.g. `cx22`. */
  serverType: string;
  /** Hetzner image, e.g. `docker-ce` or a snapshot id. */
  image: string;
  /** Datacenter location, e.g. `nbg1`. */
  location?: string;
  /**
   * Optional extra cloud-init `write_files` entries (the operator's own
   * bootstrap) merged into the host-key-injection cloud-config. The allocator
   * always owns the host-key portion; this composes with it. No manual SSH key
   * or fingerprint is accepted — Tanren generates and pins them per run.
   */
  extraWriteFiles?: string;
  /** SSH username to return in the target (Hetzner default is `root`). */
  sshUsername?: string;
  /**
   * Secret manager. The per-run ephemeral SSH PRIVATE key is stored here under
   * a per-runner ref and wiped on release; it is never logged or returned in
   * config. The SSH substrate materializes the runner identity from this same
   * ref via the target's `identitySecretRef`.
   */
  secrets: SecretStore;
  /** Orchestrator mirror of the runners table. */
  runners: RunnerStore;
  /** Injectable client (tests pass a mock). Defaults to the real fetch client. */
  client?: HetznerClient;
  /** Injectable keypair generator (tests pass a deterministic fake). */
  generateKeyPair?: KeyPairGenerator;
  /** Poll interval while waiting for the server to become running. */
  pollIntervalMs?: number;
  /** Injectable sleep (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

/** Per-allocation resources the allocator owns and must tear down on release. */
interface HetznerAllocationResources {
  serverId: number;
  sshKeyId: number;
  identitySecretRef: string;
}

/**
 * Reference cloud allocator: provisions a Hetzner Cloud server on demand,
 * waits for it to come up and acquire a public IP, and returns it as an SSH
 * target. All API calls go through an injectable {@link HetznerClient} so the
 * lifecycle is unit-tested against a mock with no live credentials.
 *
 * SSH is fully Tanren-managed — no pre-uploaded key, no pre-known fingerprint:
 *
 * 1. Per allocation it generates an EPHEMERAL ed25519 client keypair, uploads
 *    the PUBLIC key to Hetzner (`POST /v1/ssh_keys`), references that key id in
 *    the server-create (so it lands in the server's `authorized_keys`), and
 *    stores the PRIVATE key in the secret manager under a per-run ref. The
 *    returned target's `identitySecretRef` points at that ref; the SSH
 *    substrate materializes the key from it.
 * 2. It also generates an ephemeral ed25519 HOST keypair and injects the host
 *    private key via cloud-init so the server presents a KNOWN host key on the
 *    first connection. It pins that host key's locally-computed SHA256
 *    fingerprint — deterministic, no TOFU, no manual fingerprint. The SSH
 *    substrate verifies every connection against the pinned value and rejects a
 *    mismatch.
 * 3. Release destroys the server, deletes the Hetzner ssh_key, and wipes the
 *    stored private key — nothing leaks past the run.
 */
export class HetznerAllocator implements Allocator {
  private readonly client: HetznerClient;
  private readonly generateKeyPair: KeyPairGenerator;
  private readonly sleep: (ms: number) => Promise<void>;
  /** runnerId -> the resources release must tear down. */
  private readonly resources = new Map<string, HetznerAllocationResources>();

  constructor(private readonly options: HetznerAllocatorOptions) {
    if (options.apiToken === "") {
      throw new Error("HetznerAllocator requires a non-empty apiToken");
    }
    this.client = options.client ?? fetchHetznerClient(options.apiToken);
    this.generateKeyPair = options.generateKeyPair ?? generateEd25519KeyPair;
    this.sleep =
      options.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }));
  }

  async allocate(request: AllocationRequest): Promise<RunnerAllocation> {
    const name = `tanren-${request.runId}`.toLowerCase().replaceAll(/[^a-z0-9-]/gu, "-");
    const runnerId = `runner_${request.runId}`;
    const labels = { tanren_run: request.runId, tanren_project: request.projectId };
    const identitySecretRef = `hetzner/${runnerId}/identity`;

    // PHASE 1 — all fallible LOCAL crypto, BEFORE any external side effect.
    // Generate both ephemeral keypairs and compute the pinned host-key
    // fingerprint + cloud-init up front. The generator validates each key's
    // round-trip and retries, but if anything here still throws (e.g. retry
    // exhausted), nothing has been stored or provisioned yet, so there is
    // nothing to leak.
    const clientKey = this.generateKeyPair();
    const hostKey = this.generateKeyPair();
    const hostKeyFingerprint = hostKeyFingerprintFromPublicKey(hostKey.publicKey);
    const userData = buildKnownHostKeyCloudInit(hostKey.privateKey, this.options.extraWriteFiles);

    // PHASE 2 — external side effects (secret store + Hetzner API). From the
    // first side effect onward, ANY throw funnels through cleanup() so the
    // stored client private key + the uploaded Hetzner ssh_key + any created
    // server are all torn down — no dangling resources.
    let sshKeyId: number | undefined;
    let serverId: number | undefined;
    try {
      await this.options.secrets.put({ ref: identitySecretRef, value: clientKey.privateKey });

      const sshKey = await this.client.createSshKey({ name, publicKey: clientKey.publicKey, labels });
      sshKeyId = sshKey.id;

      const created = await this.client.createServer({
        name,
        serverType: this.options.serverType,
        image: this.options.image,
        location: this.options.location,
        sshKeys: [sshKey.id],
        userData,
        labels,
      });
      serverId = created.id;

      const server = await this.waitForRunning(created.id);
      serverId = server.id;

      const ip = server.publicIpv4;
      if (ip === undefined || ip === "") {
        throw new Error(`hetzner server ${server.id} became running without a public IPv4`);
      }

      const port = 22;
      const username = this.options.sshUsername ?? "root";

      const allocation: RunnerAllocation = {
        runnerId,
        imageSha: `${request.runnerImage}@sha256:hetzner`,
        target: sshRunnerHandle({ host: ip, port, username, hostKeyFingerprint, identitySecretRef }),
      };

      await this.options.runners.claim({
        runnerId,
        // Persist FK-valid (run_id, project_id), or NULLs for a runless Forge
        // ideation allocation whose synthetic handle is not a real run/project.
        ...persistedRunnerKeys(request),
        orgId: request.orgId ?? null,
        allocator: allocatorName,
        sshHost: ip,
        sshPort: port,
        hostKeyFingerprint,
        imageSha: allocation.imageSha,
        containerId: String(server.id),
      });

      // Only record the runner for release AFTER the claim succeeds, so a failed
      // claim cleans up inline (below) without a half-tracked resource.
      this.resources.set(runnerId, { serverId: server.id, sshKeyId: sshKey.id, identitySecretRef });
      return allocation;
    } catch (error) {
      // serverId may be undefined (failed before/at create); cleanup tolerates
      // missing resources via the per-call best-effort catches.
      await this.cleanup({ serverId, sshKeyId, identitySecretRef });
      throw error;
    }
  }

  async release(runnerId: string, _reason: ReleaseReason = "completed"): Promise<void> {
    const resources = this.resources.get(runnerId);
    if (resources === undefined) {
      // Already released or unknown to this instance: no-op.
      return;
    }
    this.resources.delete(runnerId);
    await this.cleanup(resources);
    await this.options.runners.release(runnerId);
  }

  /**
   * Teardown of every per-allocation resource. Each id is optional so the
   * `allocate` failure path can call this no matter how far provisioning got (a
   * throw before `createServer` leaves `serverId` undefined, a throw before
   * `createSshKey` leaves `sshKeyId` undefined). Missing ids are skipped.
   *
   * SYSTEM-vs-USERLAND fail-closed: the EXTERNAL cloud teardown (deleteServer /
   * deleteSshKey) is best-effort — the cloud provider is an external system we
   * cannot guarantee, and a leaked Hetzner server is the operator's billing
   * concern, not a credential leak. But the INTERNAL secret-store delete of the
   * per-run SSH PRIVATE key is a credential we OWN: if it fails, the private key
   * is leaked in our own store. That is NOT best-effort — it throws LOUD so the
   * delete is run last (after the external best-effort cleanups) and its failure
   * blocks release completion / surfaces on the allocate-failure path.
   */
  private async cleanup(resources: { serverId?: number; sshKeyId?: number; identitySecretRef: string }): Promise<void> {
    if (resources.serverId !== undefined) {
      await this.client.deleteServer(resources.serverId).catch(() => {});
    }
    if (resources.sshKeyId !== undefined) {
      await this.client.deleteSshKey(resources.sshKeyId).catch(() => {});
    }
    try {
      await this.options.secrets.delete(resources.identitySecretRef);
    } catch (error) {
      throw new Error(
        `hetzner allocator failed to delete the per-run SSH private key from the secret store (ref ${resources.identitySecretRef}); the credential may be LEAKED and release cannot complete`,
        { cause: error },
      );
    }
  }

  /**
   * Wait for the server to reach `running` with a public IPv4. CONVERGENCE-BASED:
   * the loop runs UNBOUNDED while the structural signature
   * (`${status}|${ip-presence}`) keeps advancing — `initializing|no-ip` →
   * `starting|no-ip` → `running|no-ip` → `running|ip` (ready). It surfaces LOUD
   * on intelligent non-convergence (an IDENTICAL signature past the saturation
   * gate = a stuck server, `PersistentProvisioningOutageError`), a documented
   * Hetzner terminal status (`off`/`deleting`/`stopping`/`unknown`,
   * `ProvisioningTerminalStateError`), or a brand-new Hetzner status the
   * allowlist does not recognize (`UnknownProvisioningStateError`, fail-closed
   * ratchet). NO wall-clock deadline.
   */
  private async waitForRunning(serverId: number): Promise<HetznerServer> {
    const pollIntervalMs = this.options.pollIntervalMs ?? 3_000;
    try {
      return await pollUntilReady(() => this.client.getServer(serverId), {
        classify: (server) => classifyHetznerServer(server),
        signature: (server) => hetznerServerSignature(server),
        pollIntervalMs,
        sleep: this.sleep,
      });
    } catch (error) {
      throw wrapHetznerProvisioningError(serverId, error);
    }
  }
}

/**
 * Classify a Hetzner server observation. Terminal statuses
 * (`off`/`deleting`/`stopping`/`unknown`) fire IMMEDIATELY without waiting for
 * the saturation gate; `initializing`/`starting`/`running`/`rebuilding`/`migrating`
 * are `advancing`; only `running` + IPv4 is `ready`. A brand-new Hetzner status
 * is `unknown_state` (fail-closed).
 */
function classifyHetznerServer(server: HetznerServer): ReadinessClassification<HetznerServer> {
  if (server.status === "running" && server.publicIpv4 !== undefined && server.publicIpv4 !== "") {
    return { kind: "ready", observation: server };
  }
  if (HETZNER_TERMINAL_STATUSES.has(server.status)) {
    return {
      kind: "terminal_error",
      reason: `hetzner server ${server.id} entered terminal status '${server.status}' before running`,
    };
  }
  if (HETZNER_PROVISIONING_STATUSES.has(server.status)) {
    return { kind: "advancing", observation: server };
  }
  return { kind: "unknown_state", state: server.status };
}

/** The STRUCTURAL signature the convergence detector reads — server status + IP-presence. */
function hetznerServerSignature(server: HetznerServer): string {
  const ipPart = server.publicIpv4 !== undefined && server.publicIpv4 !== "" ? "ip" : "no-ip";
  return `${server.status}|${ipPart}`;
}

function wrapHetznerProvisioningError(serverId: number, error: unknown): Error {
  if (error instanceof PersistentProvisioningOutageError) {
    return new Error(`hetzner server ${serverId} did not become running: ${error.message}`, { cause: error });
  }
  if (error instanceof ProvisioningTerminalStateError) {
    return new Error(error.reason, { cause: error });
  }
  if (error instanceof UnknownProvisioningStateError) {
    return new Error(
      `hetzner server ${serverId} reported an UNKNOWN status '${error.observedState}' the allocator's allowlist does not recognize`,
      { cause: error },
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

interface HetznerServerResponse {
  server: {
    id: number;
    status: string;
    public_net?: { ipv4?: { ip?: string } | null } | null;
  };
}

interface HetznerSshKeyResponse {
  ssh_key: { id: number };
}

function toServer(body: HetznerServerResponse): HetznerServer {
  const ipv4 = body.server.public_net?.ipv4?.ip;
  return {
    id: body.server.id,
    status: body.server.status,
    publicIpv4: ipv4 === null ? undefined : ipv4,
  };
}

/**
 * Production {@link HetznerClient} backed by `fetch` against the Hetzner Cloud
 * API. The token is supplied by the caller (resolved from Vault), never read
 * from the environment here.
 */
export function fetchHetznerClient(apiToken: string, fetchImpl: typeof fetch = fetch): HetznerClient {
  const authHeaders = {
    authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
  } as const;

  return {
    async createSshKey(input: HetznerCreateSshKeyInput): Promise<HetznerSshKey> {
      const response = await fetchImpl(`${hetznerApiBase}/ssh_keys`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          name: input.name,
          public_key: input.publicKey,
          labels: input.labels,
        }),
      });
      if (!response.ok) {
        throw new Error(`hetzner createSshKey failed: ${response.status} ${await response.text()}`);
      }
      const body = (await response.json()) as HetznerSshKeyResponse;
      return { id: body.ssh_key.id };
    },

    async deleteSshKey(sshKeyId: number): Promise<void> {
      const response = await fetchImpl(`${hetznerApiBase}/ssh_keys/${sshKeyId}`, {
        method: "DELETE",
        headers: authHeaders,
      });
      // 404 means already gone — treat as success (idempotent destroy).
      if (!response.ok && response.status !== 404) {
        throw new Error(`hetzner deleteSshKey failed: ${response.status} ${await response.text()}`);
      }
    },

    async createServer(input: HetznerCreateServerInput): Promise<HetznerServer> {
      const response = await fetchImpl(`${hetznerApiBase}/servers`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          name: input.name,
          server_type: input.serverType,
          image: input.image,
          location: input.location,
          ssh_keys: input.sshKeys,
          user_data: input.userData,
          labels: input.labels,
          start_after_create: true,
        }),
      });
      if (!response.ok) {
        throw new Error(`hetzner createServer failed: ${response.status} ${await response.text()}`);
      }
      return toServer((await response.json()) as HetznerServerResponse);
    },

    async getServer(serverId: number): Promise<HetznerServer> {
      const response = await fetchImpl(`${hetznerApiBase}/servers/${serverId}`, {
        method: "GET",
        headers: authHeaders,
      });
      if (!response.ok) {
        throw new Error(`hetzner getServer failed: ${response.status} ${await response.text()}`);
      }
      return toServer((await response.json()) as HetznerServerResponse);
    },

    async deleteServer(serverId: number): Promise<void> {
      const response = await fetchImpl(`${hetznerApiBase}/servers/${serverId}`, {
        method: "DELETE",
        headers: authHeaders,
      });
      // 404 means already gone — treat as success (idempotent destroy).
      if (!response.ok && response.status !== 404) {
        throw new Error(`hetzner deleteServer failed: ${response.status} ${await response.text()}`);
      }
    },
  };
}
