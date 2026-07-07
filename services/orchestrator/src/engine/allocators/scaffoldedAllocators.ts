import type {
  AllocationRequest,
  Allocator,
  AllocatorTaxonomy,
  ReleaseReason,
  RunnerAllocation,
} from "../contracts/allocator.js";
import { allocatorTaxonomyFor } from "./poolPolicy.js";
import { AllocatorKind } from "./poolPolicy.js";

/**
 * Placeholder for a *real* allocator kind that the router registers but the
 * operator never routes to (so its credentials are not configured). Throws a
 * clear error if it is ever selected, instead of constructing a real allocator
 * with bogus credentials.
 *
 * Every allocator kind now has a real implementation; this stub is the only one
 * left. It exists purely so the router registry stays total over
 * {@link AllocatorKind} without loading credentials for kinds the operator did
 * not opt into via routing rules.
 */
export class UnconfiguredAllocator implements Allocator {
  /**
   * Report the taxonomy of the KIND this stub stands in for — so an operator
   * inspecting the registry (or a taxonomy-aware consumer) reads the correct
   * lifecycle class rather than a default. If the stub is ever `allocate()`d,
   * it throws before the taxonomy matters.
   */
  readonly taxonomy: AllocatorTaxonomy;

  constructor(private readonly kind: string) {
    // Best-effort: if the string is a known AllocatorKind, use its declared
    // taxonomy; if a caller constructed a stub for something outside the
    // catalog (an internal test synonym), degrade to `provisioning` — the
    // conservative default (destroys on release).
    const parsed = AllocatorKind.safeParse(kind);
    this.taxonomy = parsed.success ? allocatorTaxonomyFor(parsed.data) : "provisioning";
  }

  private fail(): never {
    throw new Error(
      `allocator kind '${this.kind}' was selected but is not configured ` +
        `(no routing rule references it, so its credentials were not loaded). ` +
        `Add it to TANREN_ALLOCATOR_ROUTING and supply its env to enable it.`,
    );
  }

  async allocate(_request: AllocationRequest): Promise<RunnerAllocation> {
    return this.fail();
  }

  async release(_runnerId: string, _reason?: ReleaseReason): Promise<void> {
    return this.fail();
  }
}
