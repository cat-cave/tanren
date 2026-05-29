import type { AllocationRequest, Allocator, ReleaseReason, RunnerAllocation } from "../contracts/allocator.js";
import type { RunnerStore } from "./runnerStore.js";

const allocatorName = "digitalocean";
const digitalOceanApiBase = "https://api.digitalocean.com/v2";

/**
 * Typed error for DigitalOcean provisioning failures, so callers (and tests)
 * can distinguish allocator faults from generic errors.
 */
export class DigitalOceanAllocatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DigitalOceanAllocatorError";
  }
}

/**
 * Minimal injectable HTTP client over the DigitalOcean v2 API. Only the shapes
 * the allocator needs are modeled. Tests inject a fake; production uses
 * {@link fetchDigitalOceanClient}.
 */
export interface DigitalOceanClient {
  createDroplet(input: DigitalOceanCreateDropletInput): Promise<DigitalOceanDroplet>;
  getDroplet(dropletId: number): Promise<DigitalOceanDroplet>;
  deleteDroplet(dropletId: number): Promise<void>;
}

export interface DigitalOceanCreateDropletInput {
  name: string;
  region: string;
  size: string;
  image: string;
  /** DO SSH key ids/fingerprints authorized for root on the new droplet. */
  sshKeys?: ReadonlyArray<string | number>;
  /** cloud-init user data, e.g. to install the runner agent. */
  userData?: string;
  /** DO tags applied to the droplet (used to trace it back to a run). */
  tags?: ReadonlyArray<string>;
}

export interface DigitalOceanDroplet {
  id: number;
  status: string;
  publicIpv4?: string;
}

export interface DigitalOceanAllocatorOptions {
  /** Vault-resolved API token. Never hardcode; pass a resolved secret here. */
  apiToken: string;
  /** DigitalOcean region slug, e.g. `nyc3`. */
  region: string;
  /** Droplet size slug, e.g. `s-1vcpu-1gb`. */
  size: string;
  /** Droplet image slug or snapshot id, e.g. `docker-20-04`. */
  image: string;
  /** DO SSH key ids/fingerprints to authorize on the provisioned droplet. */
  sshKeys?: ReadonlyArray<string | number>;
  /** Optional cloud-init user data to bootstrap the runner agent. */
  userData?: string;
  /** SSH username to return in the target (DO default is `root`). */
  sshUsername?: string;
  /**
   * Pre-known host key fingerprint to pin. DO does not expose the host key via
   * API; in production this is derived from a baked image / cloud-init that
   * installs a known key. When unset, allocation fails so we never hand back
   * an unverifiable target.
   */
  hostKeyFingerprint: string;
  /** Orchestrator mirror of the runners table. */
  runners: RunnerStore;
  /** Injectable client (tests pass a mock). Defaults to the real fetch client. */
  client?: DigitalOceanClient;
  /** Poll interval while waiting for the droplet to become active. */
  pollIntervalMs?: number;
  /** Max time to wait for the droplet to become active + get an IP. */
  readyTimeoutMs?: number;
  /** Injectable sleep (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Cloud allocator that provisions a DigitalOcean Droplet on demand, waits for
 * it to become active and acquire a public IPv4, and returns it as an SSH
 * target. Release destroys the droplet (idempotent). All API calls go through
 * an injectable {@link DigitalOceanClient} so the lifecycle is unit-tested
 * against a mock with no live credentials.
 *
 * Mirrors the Hetzner reference allocator: it pins a pre-known host key
 * fingerprint rather than doing TOFU, because production deployments bake a
 * known host key into the image / cloud-init.
 */
export class DigitalOceanAllocator implements Allocator {
  private readonly client: DigitalOceanClient;
  private readonly sleep: (ms: number) => Promise<void>;
  /** runnerId -> DO droplet id, so release can destroy the right droplet. */
  private readonly droplets = new Map<string, number>();

  constructor(private readonly options: DigitalOceanAllocatorOptions) {
    if (options.apiToken === "") {
      throw new DigitalOceanAllocatorError("DigitalOceanAllocator requires a non-empty apiToken");
    }
    if (options.hostKeyFingerprint === "") {
      throw new DigitalOceanAllocatorError("DigitalOceanAllocator requires a pinned hostKeyFingerprint");
    }
    this.client = options.client ?? fetchDigitalOceanClient(options.apiToken);
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async allocate(request: AllocationRequest): Promise<RunnerAllocation> {
    const name = `tanren-${request.runId}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const created = await this.client.createDroplet({
      name,
      region: this.options.region,
      size: this.options.size,
      image: this.options.image,
      sshKeys: this.options.sshKeys,
      userData: this.options.userData,
      tags: [`tanren-run-${request.runId}`, `tanren-project-${request.projectId}`].map((t) =>
        t.toLowerCase().replace(/[^a-z0-9:_-]/g, "-"),
      ),
    });

    let droplet = created;
    try {
      droplet = await this.waitForActive(created.id);
    } catch (error) {
      // Best-effort destroy so a stuck droplet doesn't leak.
      await this.client.deleteDroplet(created.id).catch(() => undefined);
      throw error;
    }

    const ip = droplet.publicIpv4;
    if (ip === undefined || ip === "") {
      await this.client.deleteDroplet(droplet.id).catch(() => undefined);
      throw new DigitalOceanAllocatorError(`digitalocean droplet ${droplet.id} became active without a public IPv4`);
    }

    const port = 22;
    const username = this.options.sshUsername ?? "root";
    const runnerId = `runner_${request.runId}`;
    this.droplets.set(runnerId, droplet.id);

    const allocation: RunnerAllocation = {
      runnerId,
      imageSha: `${request.runnerImage}@sha256:digitalocean`,
      target: {
        host: ip,
        port,
        username,
        hostKeyFingerprint: this.options.hostKeyFingerprint,
        identitySecretRef: request.identitySecretRef,
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
        hostKeyFingerprint: this.options.hostKeyFingerprint,
        imageSha: allocation.imageSha,
        containerId: String(droplet.id),
      });
    } catch (error) {
      await this.client.deleteDroplet(droplet.id).catch(() => undefined);
      this.droplets.delete(runnerId);
      throw error;
    }

    return allocation;
  }

  async release(runnerId: string, _reason: ReleaseReason = "completed"): Promise<void> {
    const dropletId = this.droplets.get(runnerId);
    if (dropletId === undefined) {
      // Already released or unknown to this instance: no-op.
      return;
    }
    this.droplets.delete(runnerId);
    await this.client.deleteDroplet(dropletId);
    await this.options.runners.release(runnerId);
  }

  private async waitForActive(dropletId: number): Promise<DigitalOceanDroplet> {
    const pollIntervalMs = this.options.pollIntervalMs ?? 3_000;
    const readyTimeoutMs = this.options.readyTimeoutMs ?? 120_000;
    const deadline = Date.now() + readyTimeoutMs;
    for (;;) {
      const droplet = await this.client.getDroplet(dropletId);
      if (droplet.status === "active" && droplet.publicIpv4 !== undefined && droplet.publicIpv4 !== "") {
        return droplet;
      }
      if (Date.now() >= deadline) {
        throw new DigitalOceanAllocatorError(
          `digitalocean droplet ${dropletId} did not become active within ${readyTimeoutMs}ms ` +
            `(last status: ${droplet.status})`,
        );
      }
      await this.sleep(pollIntervalMs);
    }
  }
}

interface DigitalOceanNetworkV4 {
  ip_address?: string;
  type?: string;
}

interface DigitalOceanDropletResponse {
  droplet: {
    id: number;
    status: string;
    networks?: { v4?: ReadonlyArray<DigitalOceanNetworkV4> | null } | null;
  };
}

function publicIpv4Of(networks: ReadonlyArray<DigitalOceanNetworkV4> | null | undefined): string | undefined {
  if (networks === null || networks === undefined) {
    return undefined;
  }
  const match = networks.find((n) => n.type === "public" && n.ip_address !== undefined && n.ip_address !== "");
  return match?.ip_address;
}

function toDroplet(body: DigitalOceanDropletResponse): DigitalOceanDroplet {
  return {
    id: body.droplet.id,
    status: body.droplet.status,
    publicIpv4: publicIpv4Of(body.droplet.networks?.v4),
  };
}

/**
 * Production {@link DigitalOceanClient} backed by `fetch` against the DO v2
 * API. The token is supplied by the caller (resolved from Vault), never read
 * from the environment here.
 */
export function fetchDigitalOceanClient(apiToken: string, fetchImpl: typeof fetch = fetch): DigitalOceanClient {
  const authHeaders = {
    authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
  } as const;

  return {
    async createDroplet(input: DigitalOceanCreateDropletInput): Promise<DigitalOceanDroplet> {
      const response = await fetchImpl(`${digitalOceanApiBase}/droplets`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          name: input.name,
          region: input.region,
          size: input.size,
          image: input.image,
          ssh_keys: input.sshKeys,
          user_data: input.userData,
          tags: input.tags,
        }),
      });
      if (!response.ok) {
        throw new DigitalOceanAllocatorError(
          `digitalocean createDroplet failed: ${response.status} ${await response.text()}`,
        );
      }
      return toDroplet((await response.json()) as DigitalOceanDropletResponse);
    },

    async getDroplet(dropletId: number): Promise<DigitalOceanDroplet> {
      const response = await fetchImpl(`${digitalOceanApiBase}/droplets/${dropletId}`, {
        method: "GET",
        headers: authHeaders,
      });
      if (!response.ok) {
        throw new DigitalOceanAllocatorError(
          `digitalocean getDroplet failed: ${response.status} ${await response.text()}`,
        );
      }
      return toDroplet((await response.json()) as DigitalOceanDropletResponse);
    },

    async deleteDroplet(dropletId: number): Promise<void> {
      const response = await fetchImpl(`${digitalOceanApiBase}/droplets/${dropletId}`, {
        method: "DELETE",
        headers: authHeaders,
      });
      // 404 means already gone — treat as success (idempotent destroy).
      if (!response.ok && response.status !== 404) {
        throw new DigitalOceanAllocatorError(
          `digitalocean deleteDroplet failed: ${response.status} ${await response.text()}`,
        );
      }
    },
  };
}
