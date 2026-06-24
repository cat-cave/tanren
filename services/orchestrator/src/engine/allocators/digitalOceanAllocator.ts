import {
  persistedRunnerKeys,
  sshRunnerHandle,
  type AllocationRequest,
  type Allocator,
  type ReleaseReason,
  type RunnerAllocation,
} from "../contracts/allocator.js";
import {
  PersistentProvisioningOutageError,
  ProvisioningTerminalStateError,
  UnknownProvisioningStateError,
  pollUntilReady,
  type ReadinessClassification,
} from "./readinessConvergence.js";
import type { RunnerStore } from "./runnerStore.js";

const allocatorName = "digitalocean";
const digitalOceanApiBase = "https://api.digitalocean.com/v2";

/**
 * DigitalOcean documented droplet lifecycle statuses the allocator EXPECTS to see
 * as an intermediate state on the path to `active`. Anything outside this set OR
 * {@link DO_TERMINAL_STATUSES} is treated as `unknown_state` — fail-closed ratchet
 * (a new DO status forces a code change here, never a silent infinite loop).
 */
const DO_PROVISIONING_STATUSES: ReadonlySet<string> = new Set(["new", "active"]);

/**
 * DigitalOcean documented terminal statuses — a droplet in these states cannot
 * recover by waiting (powered down / archived). Fires the `terminal_error` arm
 * immediately, never via the fixed-point gate.
 */
const DO_TERMINAL_STATUSES: ReadonlySet<string> = new Set(["off", "archive"]);

/**
 * Typed error for DigitalOcean provisioning failures, so callers (and tests)
 * can distinguish allocator faults from generic errors. Optionally carries a
 * `cause` so a convergence-class throw (`PersistentProvisioningOutageError` /
 * `ProvisioningTerminalStateError` / `UnknownProvisioningStateError`) wrapped
 * into this allocator's error keeps the inner stuck-signature / probe-count
 * diagnostic accessible to callers + the debugger.
 */
export class DigitalOceanAllocatorError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
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
    this.sleep =
      options.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }));
  }

  async allocate(request: AllocationRequest): Promise<RunnerAllocation> {
    const name = `tanren-${request.runId}`.toLowerCase().replaceAll(/[^a-z0-9-]/gu, "-");
    const created = await this.client.createDroplet({
      name,
      region: this.options.region,
      size: this.options.size,
      image: this.options.image,
      sshKeys: this.options.sshKeys,
      userData: this.options.userData,
      tags: [`tanren-run-${request.runId}`, `tanren-project-${request.projectId}`].map((t) =>
        t.toLowerCase().replaceAll(/[^a-z0-9:_-]/gu, "-"),
      ),
    });

    let droplet = created;
    try {
      droplet = await this.waitForActive(created.id);
    } catch (error) {
      // Best-effort destroy so a stuck droplet doesn't leak.
      await this.client.deleteDroplet(created.id).catch(() => {});
      throw error;
    }

    const ip = droplet.publicIpv4;
    if (ip === undefined || ip === "") {
      await this.client.deleteDroplet(droplet.id).catch(() => {});
      throw new DigitalOceanAllocatorError(`digitalocean droplet ${droplet.id} became active without a public IPv4`);
    }

    const port = 22;
    const username = this.options.sshUsername ?? "root";
    const runnerId = `runner_${request.runId}`;
    this.droplets.set(runnerId, droplet.id);

    const allocation: RunnerAllocation = {
      runnerId,
      imageSha: `${request.runnerImage}@sha256:digitalocean`,
      target: sshRunnerHandle({
        host: ip,
        port,
        username,
        hostKeyFingerprint: this.options.hostKeyFingerprint,
        identitySecretRef: request.identitySecretRef,
      }),
    };

    try {
      await this.options.runners.claim({
        runnerId,
        // Persist FK-valid (run_id, project_id), or NULLs for a runless Forge
        // ideation allocation whose synthetic handle is not a real run/project.
        ...persistedRunnerKeys(request),
        orgId: request.orgId ?? null,
        allocator: allocatorName,
        sshHost: ip,
        sshPort: port,
        hostKeyFingerprint: this.options.hostKeyFingerprint,
        imageSha: allocation.imageSha,
        containerId: String(droplet.id),
      });
    } catch (error) {
      await this.client.deleteDroplet(droplet.id).catch(() => {});
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

  /**
   * Wait for the droplet to become `active` with a public IPv4. CONVERGENCE-BASED:
   * the loop runs UNBOUNDED while the structural signature (`${status}|${ip-presence}`)
   * keeps advancing — `new|no-ip` → `new|ip` → `active|no-ip` → `active|ip` (ready).
   * It surfaces LOUD only on intelligent non-convergence (an IDENTICAL signature past
   * the saturation gate = a stuck droplet, `PersistentProvisioningOutageError`), a
   * documented terminal status (`off`/`archive`, `ProvisioningTerminalStateError`),
   * or a brand-new DO status the allowlist does not recognize
   * (`UnknownProvisioningStateError`, fail-closed ratchet). NO wall-clock deadline.
   */
  private async waitForActive(dropletId: number): Promise<DigitalOceanDroplet> {
    const pollIntervalMs = this.options.pollIntervalMs ?? 3_000;
    try {
      return await pollUntilReady(() => this.client.getDroplet(dropletId), {
        classify: (droplet) => classifyDigitalOceanDroplet(droplet),
        signature: (droplet) => digitalOceanDropletSignature(droplet),
        pollIntervalMs,
        sleep: this.sleep,
      });
    } catch (error) {
      // Wrap each convergence-class surface into the per-allocator typed error so
      // existing callers (and the surface tests) keep their `instanceof
      // DigitalOceanAllocatorError` discriminator. Carries the cause so the inner
      // signature / state / probe count remain diagnosable.
      throw wrapDigitalOceanProvisioningError(dropletId, error);
    }
  }
}

/**
 * Classify a DigitalOcean droplet observation. Each allowlisted status maps to a
 * deliberate convergence outcome — `ready` (active + IPv4), `advancing` (still on the
 * documented `new`/`active` path), `terminal_error` (a documented terminal status),
 * or `unknown_state` (a NEW provider status the allowlist does NOT recognize, fail
 * closed). The signature is the STRUCTURAL pair `${status}|${ip-presence}` — so
 * `new|no-ip` → `new|ip` → `active|no-ip` → `active|ip` traces the genuine lifecycle
 * advance, never identical when the droplet is actually progressing.
 */
function classifyDigitalOceanDroplet(droplet: DigitalOceanDroplet): ReadinessClassification<DigitalOceanDroplet> {
  if (droplet.status === "active" && droplet.publicIpv4 !== undefined && droplet.publicIpv4 !== "") {
    return { kind: "ready", observation: droplet };
  }
  if (DO_TERMINAL_STATUSES.has(droplet.status)) {
    return {
      kind: "terminal_error",
      reason: `digitalocean droplet ${droplet.id} entered terminal status '${droplet.status}'`,
    };
  }
  if (DO_PROVISIONING_STATUSES.has(droplet.status)) {
    return { kind: "advancing", observation: droplet };
  }
  return { kind: "unknown_state", state: droplet.status };
}

/** The STRUCTURAL signature the convergence detector reads — droplet status + IP-presence. */
function digitalOceanDropletSignature(droplet: DigitalOceanDroplet): string {
  const ipPart = droplet.publicIpv4 !== undefined && droplet.publicIpv4 !== "" ? "ip" : "no-ip";
  return `${droplet.status}|${ipPart}`;
}

/** Wrap a convergence-class throw into the per-allocator typed error (with cause). */
function wrapDigitalOceanProvisioningError(dropletId: number, error: unknown): Error {
  if (error instanceof PersistentProvisioningOutageError) {
    return new DigitalOceanAllocatorError(
      `digitalocean droplet ${dropletId} did not become active: ${error.message}`,
      { cause: error },
    );
  }
  if (error instanceof ProvisioningTerminalStateError) {
    return new DigitalOceanAllocatorError(error.reason, { cause: error });
  }
  if (error instanceof UnknownProvisioningStateError) {
    return new DigitalOceanAllocatorError(
      `digitalocean droplet ${dropletId} reported an UNKNOWN status '${error.observedState}' the allocator's allowlist does not recognize`,
      { cause: error },
    );
  }
  return error instanceof Error ? error : new DigitalOceanAllocatorError(String(error));
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
