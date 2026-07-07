import {
  persistedRunnerKeys,
  sshRunnerHandle,
  type AllocationRequest,
  type Allocator,
  type AllocatorTaxonomy,
  type ReleaseReason,
  type RunnerAllocation,
} from "../contracts/allocator.js";
import { fetchAwsEc2Client } from "./awsEc2FetchClient.js";
import { AwsEc2AllocatorError, type AwsEc2Client, type AwsEc2Instance } from "./awsEc2Shared.js";
import {
  PersistentProvisioningOutageError,
  ProvisioningTerminalStateError,
  UnknownProvisioningStateError,
  pollUntilReady,
  type ReadinessClassification,
} from "./readinessConvergence.js";
import type { RunnerStore } from "./runnerStore.js";

const allocatorName = "aws_ec2";

/**
 * EC2 documented instance lifecycle states the allocator EXPECTS to see as an
 * intermediate state on the path to `running` (and `running` itself). Anything
 * outside this set OR {@link AWS_EC2_TERMINAL_STATES} is treated as
 * `unknown_state` — fail-closed ratchet (a new EC2 state forces a code change
 * here, never a silent infinite loop). EC2 documents: `pending`, `running`,
 * `shutting-down`, `terminated`, `stopping`, `stopped`.
 */
const AWS_EC2_PROVISIONING_STATES: ReadonlySet<string> = new Set(["pending", "running"]);

/**
 * EC2 documented terminal states — an instance in these states cannot recover
 * by waiting (the instance is being torn down or already stopped). Fires the
 * `terminal_error` arm immediately, never via the fixed-point gate.
 */
const AWS_EC2_TERMINAL_STATES: ReadonlySet<string> = new Set(["terminated", "shutting-down", "stopping", "stopped"]);

// The typed error class + minimal-client + types live in `./awsEc2Shared.ts` so
// the production fetch-client and the allocator can both import them without a
// circular dependency. Re-exported here for back-compat with existing imports.
export {
  AwsEc2AllocatorError,
  type AwsEc2Client,
  type AwsEc2Instance,
  type AwsRunInstancesInput,
} from "./awsEc2Shared.js";

export interface AwsEc2AllocatorOptions {
  /** AWS access key id. Never hardcode; pass a Vault-resolved secret here. */
  accessKeyId: string;
  /** AWS secret access key. Never hardcode; pass a Vault-resolved secret here. */
  secretAccessKey: string;
  /** Optional STS session token when using temporary credentials. */
  sessionToken?: string;
  /** AWS region, e.g. `us-east-1`. */
  region: string;
  /** AMI image id to launch, e.g. `ami-0abcd1234`. */
  imageId: string;
  /** Instance type, e.g. `t3.small`. */
  instanceType: string;
  /** EC2 key pair name authorized for SSH on the instance. */
  keyName?: string;
  /** Subnet to launch into. */
  subnetId?: string;
  /** Security group ids controlling inbound SSH. */
  securityGroupIds?: ReadonlyArray<string>;
  /** base64-encoded cloud-init user data to bootstrap the runner agent. */
  userData?: string;
  /** SSH username to return in the target (e.g. `ec2-user` / `ubuntu`). */
  sshUsername?: string;
  /**
   * Pre-known host key fingerprint to pin. EC2 does not expose the host key
   * via the API; in production this is derived from a baked AMI / user-data
   * that installs a known key. When unset, allocation fails so we never hand
   * back an unverifiable target.
   */
  hostKeyFingerprint: string;
  /** Orchestrator mirror of the runners table. */
  runners: RunnerStore;
  /** Injectable client (tests pass a mock). Defaults to the real fetch client. */
  client?: AwsEc2Client;
  /** Poll interval while waiting for the instance to become running. */
  pollIntervalMs?: number;
  /** Injectable sleep (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Cloud allocator that provisions an AWS EC2 instance on demand, waits for it
 * to reach the `running` state with a public IP, and returns it as an SSH
 * target. Release terminates the instance (idempotent). All API calls go
 * through an injectable {@link AwsEc2Client} so the lifecycle is unit-tested
 * against a mock with no live credentials.
 *
 * Mirrors the DigitalOcean / GCP reference allocators: it pins a pre-known host
 * key fingerprint rather than doing TOFU, because production deployments bake a
 * known host key into the AMI / user-data.
 */
export class AwsEc2Allocator implements Allocator {
  // PROVISIONING: allocate() launches a fresh EC2 instance; release()
  // terminates it.
  readonly taxonomy: AllocatorTaxonomy = "provisioning";
  private readonly client: AwsEc2Client;
  private readonly sleep: (ms: number) => Promise<void>;
  /** runnerId -> EC2 instance id, so release can terminate the right instance. */
  private readonly instances = new Map<string, string>();

  constructor(private readonly options: AwsEc2AllocatorOptions) {
    if (options.accessKeyId === "" || options.secretAccessKey === "") {
      throw new AwsEc2AllocatorError("AwsEc2Allocator requires non-empty AWS credentials");
    }
    if (options.hostKeyFingerprint === "") {
      throw new AwsEc2AllocatorError("AwsEc2Allocator requires a pinned hostKeyFingerprint");
    }
    this.client = options.client ?? fetchAwsEc2Client(options);
    this.sleep =
      options.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }));
  }

  async allocate(request: AllocationRequest): Promise<RunnerAllocation> {
    const created = await this.client.runInstances({
      imageId: this.options.imageId,
      instanceType: this.options.instanceType,
      keyName: this.options.keyName,
      subnetId: this.options.subnetId,
      securityGroupIds: this.options.securityGroupIds,
      userData: this.options.userData,
      tags: {
        Name: `tanren-${request.runId}`.toLowerCase().replaceAll(/[^a-z0-9-]/gu, "-"),
        "tanren-run": request.runId,
        "tanren-project": request.projectId,
      },
    });

    let instance: AwsEc2Instance;
    try {
      instance = await this.waitForRunning(created.instanceId);
    } catch (error) {
      // Best-effort terminate so a stuck instance doesn't leak.
      await this.client.terminateInstance(created.instanceId).catch(() => {});
      throw error;
    }

    const ip = instance.publicIp;
    if (ip === undefined || ip === "") {
      await this.client.terminateInstance(instance.instanceId).catch(() => {});
      throw new AwsEc2AllocatorError(`aws ec2 instance ${instance.instanceId} became running without a public IP`);
    }

    return this.claim(request, instance.instanceId, ip);
  }

  private async claim(request: AllocationRequest, instanceId: string, ip: string): Promise<RunnerAllocation> {
    const port = 22;
    const username = this.options.sshUsername ?? "ec2-user";
    const runnerId = `runner_${request.runId}`;
    this.instances.set(runnerId, instanceId);

    const allocation: RunnerAllocation = {
      runnerId,
      imageSha: `${request.runnerImage}@sha256:aws-ec2`,
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
        containerId: instanceId,
        // Codex H3 #13: persist the EC2 instance id so a fresh allocator
        // instance (post-restart) can reconstruct the terminate call without
        // the in-memory `instances` map.
        providerMetadata: { kind: "aws_ec2", instanceId },
      });
    } catch (error) {
      await this.client.terminateInstance(instanceId).catch(() => {});
      this.instances.delete(runnerId);
      throw error;
    }

    return allocation;
  }

  async release(runnerId: string, _reason: ReleaseReason = "completed"): Promise<void> {
    const instanceId = await this.resolveInstanceId(runnerId);
    if (instanceId === undefined) {
      // Already released, unknown to this instance AND unpersisted, or the
      // persisted row belongs to a different provider (kind mismatch). No-op.
      return;
    }
    this.instances.delete(runnerId);
    await this.client.terminateInstance(instanceId);
    await this.options.runners.release(runnerId);
  }

  /**
   * Codex H3 #13: resolve the EC2 instance id for a release, tolerating the
   * process-restart shape. In-memory first (fast path); DB fallback via
   * `runners.provider_metadata` (durable) when the map has been lost.
   */
  private async resolveInstanceId(runnerId: string): Promise<string | undefined> {
    const cached = this.instances.get(runnerId);
    if (cached !== undefined) {
      return cached;
    }
    const persisted = await this.options.runners.readTeardownDescriptor(runnerId);
    if (persisted?.kind === "aws_ec2") {
      return persisted.instanceId;
    }
    return undefined;
  }

  /**
   * Wait for the instance to become `running` with a public IP. CONVERGENCE-BASED:
   * the loop runs UNBOUNDED while the structural signature (`${state}|${ip-presence}`)
   * keeps advancing — `pending|no-ip` → `running|no-ip` → `running|ip` (ready). It
   * surfaces LOUD only on intelligent non-convergence (an IDENTICAL signature past
   * the saturation gate = a stuck instance, `PersistentProvisioningOutageError`), a
   * documented EC2 terminal state (`terminated`/`shutting-down`/`stopping`/`stopped`,
   * `ProvisioningTerminalStateError`), or a brand-new EC2 state the allowlist does
   * not recognize (`UnknownProvisioningStateError`, fail-closed ratchet). NO
   * wall-clock deadline.
   */
  private async waitForRunning(instanceId: string): Promise<AwsEc2Instance> {
    const pollIntervalMs = this.options.pollIntervalMs ?? 3_000;
    try {
      return await pollUntilReady(() => this.client.describeInstance(instanceId), {
        classify: (instance) => classifyAwsEc2Instance(instance),
        signature: (instance) => awsEc2InstanceSignature(instance),
        pollIntervalMs,
        sleep: this.sleep,
      });
    } catch (error) {
      throw wrapAwsEc2ProvisioningError(instanceId, error);
    }
  }
}

/**
 * Classify an EC2 instance observation. The terminal arms
 * (`terminated`/`shutting-down`/`stopping`/`stopped`) fire IMMEDIATELY without
 * waiting for the saturation gate — the instance is being torn down. `pending`
 * + `running|no-ip` are `advancing`; only `running|ip` is `ready`. A state the
 * allowlist does not know is `unknown_state` (fail-closed).
 */
function classifyAwsEc2Instance(instance: AwsEc2Instance): ReadinessClassification<AwsEc2Instance> {
  if (instance.state === "running" && instance.publicIp !== undefined && instance.publicIp !== "") {
    return { kind: "ready", observation: instance };
  }
  if (AWS_EC2_TERMINAL_STATES.has(instance.state)) {
    return {
      kind: "terminal_error",
      reason: `aws ec2 instance ${instance.instanceId} entered terminal state '${instance.state}' before running`,
    };
  }
  if (AWS_EC2_PROVISIONING_STATES.has(instance.state)) {
    return { kind: "advancing", observation: instance };
  }
  return { kind: "unknown_state", state: instance.state };
}

/** The STRUCTURAL signature the convergence detector reads — instance state + IP-presence. */
function awsEc2InstanceSignature(instance: AwsEc2Instance): string {
  const ipPart = instance.publicIp !== undefined && instance.publicIp !== "" ? "ip" : "no-ip";
  return `${instance.state}|${ipPart}`;
}

function wrapAwsEc2ProvisioningError(instanceId: string, error: unknown): Error {
  if (error instanceof PersistentProvisioningOutageError) {
    return new AwsEc2AllocatorError(`aws ec2 instance ${instanceId} did not become running: ${error.message}`, {
      cause: error,
    });
  }
  if (error instanceof ProvisioningTerminalStateError) {
    return new AwsEc2AllocatorError(error.reason, { cause: error });
  }
  if (error instanceof UnknownProvisioningStateError) {
    return new AwsEc2AllocatorError(
      `aws ec2 instance ${instanceId} reported an UNKNOWN state '${error.observedState}' the allocator's allowlist does not recognize`,
      { cause: error },
    );
  }
  return error instanceof Error ? error : new AwsEc2AllocatorError(String(error));
}

// `fetchAwsEc2Client` (the SigV4-signed thin client + the XML response mapper)
// lives in `./awsEc2FetchClient.ts` to keep this file under the line cap.
// Re-exported here so existing call sites keep their existing import.
export { fetchAwsEc2Client } from "./awsEc2FetchClient.js";
