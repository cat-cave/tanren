import type { AllocationRequest, Allocator, ReleaseReason, RunnerAllocation } from "../contracts/allocator.js";
import type { SecretStore } from "../contracts/secretStore.js";
import {
  buildKnownHostKeyCloudInit,
  generateEd25519KeyPair,
  hostKeyFingerprintFromPublicKey,
  type KeyPairGenerator,
} from "../ssh/keygen.js";
import type { RunnerStore } from "./runnerStore.js";

const allocatorName = "hetzner";
const hetznerApiBase = "https://api.hetzner.cloud/v1";

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
  /** Max time to wait for the server to become running + get an IP. */
  readyTimeoutMs?: number;
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

    // 1. Ephemeral CLIENT keypair: upload the public key, store the private key.
    const clientKey = this.generateKeyPair();
    const identitySecretRef = `hetzner/${runnerId}/identity`;
    await this.options.secrets.put({ ref: identitySecretRef, value: clientKey.privateKey });

    let sshKey: HetznerSshKey;
    try {
      sshKey = await this.client.createSshKey({ name, publicKey: clientKey.publicKey, labels });
    } catch (error) {
      // Nothing provisioned yet beyond the stored private key — wipe it.
      await this.options.secrets.delete(identitySecretRef).catch(() => {});
      throw error;
    }

    // 2. Ephemeral HOST keypair: pin the public key's fingerprint, inject the
    //    private key via cloud-init so the server presents the known host key.
    const hostKey = this.generateKeyPair();
    const hostKeyFingerprint = hostKeyFingerprintFromPublicKey(hostKey.publicKey);
    const userData = buildKnownHostKeyCloudInit(hostKey.privateKey, this.options.extraWriteFiles);

    const created = await this.createServerOrCleanup(
      { name, sshKeyId: sshKey.id, userData, labels },
      identitySecretRef,
    );

    let server = created;
    try {
      server = await this.waitForRunning(created.id);
    } catch (error) {
      await this.cleanup({ serverId: created.id, sshKeyId: sshKey.id, identitySecretRef });
      throw error;
    }

    const ip = server.publicIpv4;
    if (ip === undefined || ip === "") {
      await this.cleanup({ serverId: server.id, sshKeyId: sshKey.id, identitySecretRef });
      throw new Error(`hetzner server ${server.id} became running without a public IPv4`);
    }

    const port = 22;
    const username = this.options.sshUsername ?? "root";
    this.resources.set(runnerId, { serverId: server.id, sshKeyId: sshKey.id, identitySecretRef });

    const allocation: RunnerAllocation = {
      runnerId,
      imageSha: `${request.runnerImage}@sha256:hetzner`,
      target: {
        host: ip,
        port,
        username,
        hostKeyFingerprint,
        identitySecretRef,
      },
    };

    try {
      await this.options.runners.claim({
        runnerId,
        runId: request.runId,
        projectId: request.projectId,
        allocator: allocatorName,
        sshHost: ip,
        sshPort: port,
        hostKeyFingerprint,
        imageSha: allocation.imageSha,
        containerId: String(server.id),
      });
    } catch (error) {
      this.resources.delete(runnerId);
      await this.cleanup({ serverId: server.id, sshKeyId: sshKey.id, identitySecretRef });
      throw error;
    }

    return allocation;
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
   * Create the server; on failure tear down the ssh_key + stored private key so
   * a failed create never leaks the uploaded key or the secret.
   */
  private async createServerOrCleanup(
    input: { name: string; sshKeyId: number; userData: string; labels: Record<string, string> },
    identitySecretRef: string,
  ): Promise<HetznerServer> {
    try {
      return await this.client.createServer({
        name: input.name,
        serverType: this.options.serverType,
        image: this.options.image,
        location: this.options.location,
        sshKeys: [input.sshKeyId],
        userData: input.userData,
        labels: input.labels,
      });
    } catch (error) {
      await this.client.deleteSshKey(input.sshKeyId).catch(() => {});
      await this.options.secrets.delete(identitySecretRef).catch(() => {});
      throw error;
    }
  }

  /** Best-effort teardown of every per-allocation resource. */
  private async cleanup(resources: HetznerAllocationResources): Promise<void> {
    await this.client.deleteServer(resources.serverId).catch(() => {});
    await this.client.deleteSshKey(resources.sshKeyId).catch(() => {});
    await this.options.secrets.delete(resources.identitySecretRef).catch(() => {});
  }

  private async waitForRunning(serverId: number): Promise<HetznerServer> {
    const pollIntervalMs = this.options.pollIntervalMs ?? 3_000;
    const readyTimeoutMs = this.options.readyTimeoutMs ?? 120_000;
    const deadline = Date.now() + readyTimeoutMs;
    for (;;) {
      const server = await this.client.getServer(serverId);
      if (server.status === "running" && server.publicIpv4 !== undefined && server.publicIpv4 !== "") {
        return server;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `hetzner server ${serverId} did not become running within ${readyTimeoutMs}ms (last status: ${server.status})`,
        );
      }
      await this.sleep(pollIntervalMs);
    }
  }
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
