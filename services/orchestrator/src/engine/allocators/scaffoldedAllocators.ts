import type {
  AllocationRequest,
  Allocator,
  ReleaseReason,
  RunnerAllocation
} from "../contracts/allocator.js";

/**
 * Error thrown by the scaffolded cloud allocators. These allocators exist to
 * prove the {@link Allocator} interface shape and the selector wiring; the
 * provider-specific provisioning logic is a P3-0027 follow-up.
 */
export class AllocatorNotImplementedError extends Error {
  constructor(public readonly provider: string) {
    super(
      `${provider} allocator is not yet implemented (P3-0027 follow-up). ` +
        `Implemented allocators: static, sidecar, manual_ssh, hetzner, digitalocean. ` +
        `See docs/operator-guide/runners.md.`
    );
    this.name = "AllocatorNotImplementedError";
  }
}

/**
 * Base for scaffolded cloud allocators. Each subclass fixes its provider name;
 * both methods throw {@link AllocatorNotImplementedError} so the shape is
 * proven and registered in the selector without pretending to provision.
 */
abstract class ScaffoldedAllocator implements Allocator {
  protected abstract readonly provider: string;

  async allocate(_request: AllocationRequest): Promise<RunnerAllocation> {
    throw new AllocatorNotImplementedError(this.provider);
  }

  async release(_runnerId: string, _reason?: ReleaseReason): Promise<void> {
    throw new AllocatorNotImplementedError(this.provider);
  }
}

/** Scaffold: provision an AWS EC2 instance on demand. */
export class AwsEc2Allocator extends ScaffoldedAllocator {
  protected readonly provider = "aws_ec2";
}

/** Scaffold: schedule a runner pod on a Kubernetes cluster. */
export class KubernetesAllocator extends ScaffoldedAllocator {
  protected readonly provider = "kubernetes";
}

/**
 * Placeholder for a *real* allocator kind that the router registers but the
 * operator never routes to (so its credentials are not configured). Throws a
 * clear error if it is ever selected, instead of constructing a real allocator
 * with bogus credentials. Distinct from the scaffolded stubs above, which
 * represent kinds with no implementation yet.
 */
export class UnconfiguredAllocator implements Allocator {
  constructor(private readonly kind: string) {}

  private fail(): never {
    throw new Error(
      `allocator kind '${this.kind}' was selected but is not configured ` +
        `(no routing rule references it, so its credentials were not loaded). ` +
        `Add it to TANREN_ALLOCATOR_ROUTING and supply its env to enable it.`
    );
  }

  async allocate(_request: AllocationRequest): Promise<RunnerAllocation> {
    return this.fail();
  }

  async release(_runnerId: string, _reason?: ReleaseReason): Promise<void> {
    return this.fail();
  }
}
