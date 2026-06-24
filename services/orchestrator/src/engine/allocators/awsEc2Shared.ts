// Shared types + error class for the AWS EC2 allocator. Extracted from
// `awsEc2Allocator.ts` so the production fetch client (`awsEc2FetchClient.ts`)
// can import them without a circular `allocator ↔ client` dependency.

/**
 * Typed error for AWS EC2 provisioning failures, so callers (and tests) can
 * distinguish allocator faults from generic errors. Optionally carries a `cause`
 * so a convergence-class throw wrapped into this allocator's error keeps the
 * inner stuck-signature / probe-count diagnostic accessible.
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
 * `fetchAwsEc2Client`, a thin SigV4-signed `fetch` client (no AWS SDK).
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
