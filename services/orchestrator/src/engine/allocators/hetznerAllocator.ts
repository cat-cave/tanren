import type {
  AllocationRequest,
  Allocator,
  ReleaseReason,
  RunnerAllocation
} from "../contracts/allocator.js";
import type { RunnerStore } from "./runnerStore.js";

const allocatorName = "hetzner";
const hetznerApiBase = "https://api.hetzner.cloud/v1";

/**
 * Minimal injectable HTTP client over the Hetzner Cloud API. Only the shapes
 * the allocator needs are modeled; everything else passes through untouched.
 * Tests inject a fake; production uses {@link fetchHetznerClient}.
 */
export interface HetznerClient {
  createServer(input: HetznerCreateServerInput): Promise<HetznerServer>;
  getServer(serverId: number): Promise<HetznerServer>;
  deleteServer(serverId: number): Promise<void>;
}

export interface HetznerCreateServerInput {
  name: string;
  serverType: string;
  image: string;
  location?: string;
  /** Hetzner SSH key ids/names authorized for root on the new server. */
  sshKeys?: ReadonlyArray<string | number>;
  /** cloud-init user data, e.g. to install the runner agent. */
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
  /** Hetzner SSH key ids/names to authorize on the provisioned server. */
  sshKeys?: ReadonlyArray<string | number>;
  /** Optional cloud-init user data to bootstrap the runner agent. */
  userData?: string;
  /** SSH username to return in the target (Hetzner default is `root`). */
  sshUsername?: string;
  /**
   * Pre-known host key fingerprint to pin. Hetzner does not expose the host
   * key via API; in production this is derived from a baked image / cloud-init
   * that installs a known key. When unset, allocation fails so we never hand
   * back an unverifiable target.
   */
  hostKeyFingerprint: string;
  /** Orchestrator mirror of the runners table. */
  runners: RunnerStore;
  /** Injectable client (tests pass a mock). Defaults to the real fetch client. */
  client?: HetznerClient;
  /** Poll interval while waiting for the server to become running. */
  pollIntervalMs?: number;
  /** Max time to wait for the server to become running + get an IP. */
  readyTimeoutMs?: number;
  /** Injectable sleep (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Reference cloud allocator: provisions a Hetzner Cloud server on demand,
 * waits for it to come up and acquire a public IP, and returns it as an SSH
 * target. Release destroys the server. All API calls go through an injectable
 * {@link HetznerClient} so the lifecycle is unit-tested against a mock with no
 * live credentials.
 *
 * This is intentionally a *reference* implementation of the cloud-allocator
 * shape (create -> wait -> target; release -> destroy). It pins a pre-known
 * host key fingerprint rather than doing TOFU because production deployments
 * bake a known host key into the image / cloud-init.
 */
export class HetznerAllocator implements Allocator {
  private readonly client: HetznerClient;
  private readonly sleep: (ms: number) => Promise<void>;
  /** runnerId -> hetzner server id, so release can destroy the right server. */
  private readonly servers = new Map<string, number>();

  constructor(private readonly options: HetznerAllocatorOptions) {
    if (options.apiToken === "") {
      throw new Error("HetznerAllocator requires a non-empty apiToken");
    }
    if (options.hostKeyFingerprint === "") {
      throw new Error("HetznerAllocator requires a pinned hostKeyFingerprint");
    }
    this.client = options.client ?? fetchHetznerClient(options.apiToken);
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async allocate(request: AllocationRequest): Promise<RunnerAllocation> {
    const name = `tanren-${request.runId}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const created = await this.client.createServer({
      name,
      serverType: this.options.serverType,
      image: this.options.image,
      location: this.options.location,
      sshKeys: this.options.sshKeys,
      userData: this.options.userData,
      labels: { tanren_run: request.runId, tanren_project: request.projectId }
    });

    let server = created;
    try {
      server = await this.waitForRunning(created.id);
    } catch (error) {
      // Best-effort destroy so a stuck server doesn't leak.
      await this.client.deleteServer(created.id).catch(() => undefined);
      throw error;
    }

    const ip = server.publicIpv4;
    if (ip === undefined || ip === "") {
      await this.client.deleteServer(server.id).catch(() => undefined);
      throw new Error(`hetzner server ${server.id} became running without a public IPv4`);
    }

    const port = 22;
    const username = this.options.sshUsername ?? "root";
    const runnerId = `runner_${request.runId}`;
    this.servers.set(runnerId, server.id);

    const allocation: RunnerAllocation = {
      runnerId,
      imageSha: `${request.runnerImage}@sha256:hetzner`,
      target: {
        host: ip,
        port,
        username,
        hostKeyFingerprint: this.options.hostKeyFingerprint,
        identitySecretRef: request.identitySecretRef
      }
    };

    try {
      await this.options.runners.claim({
        runnerId,
        runId: request.runId,
        projectId: request.projectId,
        allocator: allocatorName,
        sshHost: ip,
        sshPort: port,
        hostKeyFingerprint: this.options.hostKeyFingerprint,
        imageSha: allocation.imageSha,
        containerId: String(server.id)
      });
    } catch (error) {
      await this.client.deleteServer(server.id).catch(() => undefined);
      this.servers.delete(runnerId);
      throw error;
    }

    return allocation;
  }

  async release(runnerId: string, _reason: ReleaseReason = "completed"): Promise<void> {
    const serverId = this.servers.get(runnerId);
    if (serverId === undefined) {
      // Already released or unknown to this instance: no-op.
      return;
    }
    this.servers.delete(runnerId);
    await this.client.deleteServer(serverId);
    await this.options.runners.release(runnerId);
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
          `hetzner server ${serverId} did not become running within ${readyTimeoutMs}ms (last status: ${server.status})`
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

function toServer(body: HetznerServerResponse): HetznerServer {
  const ipv4 = body.server.public_net?.ipv4?.ip;
  return {
    id: body.server.id,
    status: body.server.status,
    publicIpv4: ipv4 === null ? undefined : ipv4
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
    "Content-Type": "application/json"
  } as const;

  return {
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
          start_after_create: true
        })
      });
      if (!response.ok) {
        throw new Error(`hetzner createServer failed: ${response.status} ${await response.text()}`);
      }
      return toServer((await response.json()) as HetznerServerResponse);
    },

    async getServer(serverId: number): Promise<HetznerServer> {
      const response = await fetchImpl(`${hetznerApiBase}/servers/${serverId}`, {
        method: "GET",
        headers: authHeaders
      });
      if (!response.ok) {
        throw new Error(`hetzner getServer failed: ${response.status} ${await response.text()}`);
      }
      return toServer((await response.json()) as HetznerServerResponse);
    },

    async deleteServer(serverId: number): Promise<void> {
      const response = await fetchImpl(`${hetznerApiBase}/servers/${serverId}`, {
        method: "DELETE",
        headers: authHeaders
      });
      // 404 means already gone — treat as success (idempotent destroy).
      if (!response.ok && response.status !== 404) {
        throw new Error(`hetzner deleteServer failed: ${response.status} ${await response.text()}`);
      }
    }
  };
}
