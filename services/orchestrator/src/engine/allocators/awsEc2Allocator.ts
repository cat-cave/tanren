import { createHash, createHmac } from "node:crypto";
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

const allocatorName = "aws_ec2";
const ec2ApiVersion = "2016-11-15";

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

/**
 * Typed error for AWS EC2 provisioning failures, so callers (and tests) can
 * distinguish allocator faults from generic errors. Optionally carries a `cause`
 * so a convergence-class throw (`PersistentProvisioningOutageError` /
 * `ProvisioningTerminalStateError` / `UnknownProvisioningStateError`) wrapped
 * into this allocator's error keeps the inner stuck-signature / probe-count
 * diagnostic accessible to callers + the debugger.
 */
export class AwsEc2AllocatorError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AwsEc2AllocatorError";
  }
}

/**
 * Minimal injectable client over the EC2 query API. Only the shapes the
 * allocator needs are modeled. Tests inject a fake; production uses
 * {@link fetchAwsEc2Client}, a thin SigV4-signed `fetch` client (no AWS SDK).
 *
 * EC2 provisioning is asynchronous: `runInstances` returns the new instance id
 * in a `pending` state; `describeInstance` must be polled until the instance is
 * `running` with a public IP.
 */
export interface AwsEc2Client {
  runInstances(input: AwsRunInstancesInput): Promise<AwsEc2Instance>;
  describeInstance(instanceId: string): Promise<AwsEc2Instance>;
  terminateInstance(instanceId: string): Promise<void>;
}

export interface AwsRunInstancesInput {
  /** AMI image id, e.g. `ami-0abcd1234`. */
  imageId: string;
  /** Instance type, e.g. `t3.small`. */
  instanceType: string;
  /** EC2 key pair name authorized for SSH on the instance (optional). */
  keyName?: string;
  /** Subnet to launch into (optional; account default subnet if omitted). */
  subnetId?: string;
  /** Security group ids controlling inbound SSH (optional). */
  securityGroupIds?: ReadonlyArray<string>;
  /** Resource tags applied to the instance (used to trace it back to a run). */
  tags?: Readonly<Record<string, string>>;
  /** base64-encoded cloud-init user data to bootstrap the runner agent. */
  userData?: string;
}

export interface AwsEc2Instance {
  instanceId: string;
  /** pending | running | shutting-down | terminated | stopping | stopped */
  state: string;
  publicIp?: string;
}

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
      });
    } catch (error) {
      await this.client.terminateInstance(instanceId).catch(() => {});
      this.instances.delete(runnerId);
      throw error;
    }

    return allocation;
  }

  async release(runnerId: string, _reason: ReleaseReason = "completed"): Promise<void> {
    const instanceId = this.instances.get(runnerId);
    if (instanceId === undefined) {
      // Already released or unknown to this instance: no-op.
      return;
    }
    this.instances.delete(runnerId);
    await this.client.terminateInstance(instanceId);
    await this.options.runners.release(runnerId);
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

// --- response mapping --------------------------------------------------------

/** Pulls the first capture of `tag` out of EC2's XML response, if present. */
function xmlValue(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([^<]*)</${tag}>`, "u").exec(xml);
  return match?.[1];
}

/** Maps a `RunInstances` / `DescribeInstances` XML body to our instance shape. */
function toInstance(xml: string): AwsEc2Instance {
  const instanceId = xmlValue(xml, "instanceId");
  if (instanceId === undefined || instanceId === "") {
    throw new AwsEc2AllocatorError(`aws ec2 response missing instanceId: ${xml.slice(0, 200)}`);
  }
  // EC2 nests the state name as <instanceState>...<name>running</name>...
  const state = xmlValue(xml, "name") ?? "unknown";
  const publicIp = xmlValue(xml, "ipAddress");
  return { instanceId, state, publicIp };
}

// --- SigV4 query signing -----------------------------------------------------

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function signingKey(secretKey: string, date: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${secretKey}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

/** RFC-3986 encode for canonical query strings (encodeURIComponent + extras). */
function rfc3986(value: string): string {
  return encodeURIComponent(value).replaceAll(
    /[!'()*]/gu,
    (c) => `%${(c.codePointAt(0) ?? 0).toString(16).toUpperCase()}`,
  );
}

function canonicalQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((key) => `${rfc3986(key)}=${rfc3986(params[key] ?? "")}`)
    .join("&");
}

interface SigV4Context {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  host: string;
  amzDate: string;
  dateStamp: string;
}

/** Builds the SigV4 `Authorization` header value for a signed GET query. */
function authorizationHeader(ctx: SigV4Context, query: string): string {
  const service = "ec2";
  const canonicalHeaders = `host:${ctx.host}\nx-amz-date:${ctx.amzDate}\n`;
  const signedHeaders = "host;x-amz-date";
  const canonicalRequest = ["GET", "/", query, canonicalHeaders, signedHeaders, sha256Hex("")].join("\n");
  const scope = `${ctx.dateStamp}/${ctx.region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", ctx.amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const key = signingKey(ctx.secretAccessKey, ctx.dateStamp, ctx.region, service);
  const signature = createHmac("sha256", key).update(stringToSign, "utf8").digest("hex");
  return (
    `AWS4-HMAC-SHA256 Credential=${ctx.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`
  );
}

// --- query parameter builders ----------------------------------------------

function runInstancesParams(input: AwsRunInstancesInput): Record<string, string> {
  const params: Record<string, string> = {
    Action: "RunInstances",
    ImageId: input.imageId,
    InstanceType: input.instanceType,
    MinCount: "1",
    MaxCount: "1",
  };
  if (input.keyName !== undefined) {
    params["KeyName"] = input.keyName;
  }
  if (input.subnetId !== undefined) {
    params["SubnetId"] = input.subnetId;
  }
  (input.securityGroupIds ?? []).forEach((id, index) => {
    params[`SecurityGroupId.${index + 1}`] = id;
  });
  if (input.userData !== undefined) {
    params["UserData"] = input.userData;
  }
  Object.entries(input.tags ?? {}).forEach(([k, v], index) => {
    params["TagSpecification.1.ResourceType"] = "instance";
    params[`TagSpecification.1.Tag.${index + 1}.Key`] = k;
    params[`TagSpecification.1.Tag.${index + 1}.Value`] = v;
  });
  return params;
}

// --- production client -------------------------------------------------------

/**
 * Production {@link AwsEc2Client} backed by `fetch` against the EC2 query API,
 * signed with AWS Signature V4. Credentials are supplied by the caller
 * (resolved from Vault), never read from the environment here. A thin signed
 * client is used instead of `@aws-sdk/client-ec2` to keep the allocator small,
 * dependency-free, and injectable/mockable like the DO/GCP allocators.
 */
export function fetchAwsEc2Client(
  options: Pick<AwsEc2AllocatorOptions, "accessKeyId" | "secretAccessKey" | "sessionToken" | "region">,
  fetchImpl: typeof fetch = fetch,
): AwsEc2Client {
  const host = `ec2.${options.region}.amazonaws.com`;
  const endpoint = `https://${host}/`;

  async function send(params: Record<string, string>): Promise<string> {
    const now = new Date();
    const amzDate = now.toISOString().replaceAll(/[:-]|\.\d{3}/gu, "");
    const dateStamp = amzDate.slice(0, 8);
    const allParams: Record<string, string> = { ...params, Version: ec2ApiVersion };
    if (options.sessionToken !== undefined) {
      allParams["X-Amz-Security-Token"] = options.sessionToken;
    }
    const query = canonicalQuery(allParams);
    const authorization = authorizationHeader(
      {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
        region: options.region,
        host,
        amzDate,
        dateStamp,
      },
      query,
    );
    const headers: Record<string, string> = { authorization, "x-amz-date": amzDate };
    if (options.sessionToken !== undefined) {
      headers["x-amz-security-token"] = options.sessionToken;
    }
    const response = await fetchImpl(`${endpoint}?${query}`, { method: "GET", headers });
    const body = await response.text();
    if (!response.ok) {
      throw new AwsEc2AllocatorError(`aws ec2 ${params["Action"]} failed: ${response.status} ${body}`);
    }
    return body;
  }

  return {
    async runInstances(input: AwsRunInstancesInput): Promise<AwsEc2Instance> {
      return toInstance(await send(runInstancesParams(input)));
    },

    async describeInstance(instanceId: string): Promise<AwsEc2Instance> {
      return toInstance(await send({ Action: "DescribeInstances", "InstanceId.1": instanceId }));
    },

    async terminateInstance(instanceId: string): Promise<void> {
      // EC2 TerminateInstances is idempotent: terminating an already-gone
      // instance returns InvalidInstanceID.NotFound, which we treat as success.
      try {
        await send({ Action: "TerminateInstances", "InstanceId.1": instanceId });
      } catch (error) {
        if (error instanceof AwsEc2AllocatorError && /InvalidInstanceID\.NotFound/u.test(error.message)) {
          return;
        }
        throw error;
      }
    },
  };
}
