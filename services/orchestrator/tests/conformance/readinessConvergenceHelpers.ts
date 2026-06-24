// Shared helpers for per-allocator readiness convergence test wiring (task #31).
// Each cloud allocator wraps a convergence-class throw
// (`PersistentProvisioningOutageError` / `ProvisioningTerminalStateError` /
// `UnknownProvisioningStateError`) into its own typed allocator error with the
// inner cause preserved. The shared conformance harness reads the inner
// surface via `instanceof`, so a per-allocator unwrap adapter strips the
// outer wrapper for the conformance suite while preserving the typed wrapper
// for the per-allocator native tests.

import type { Allocator } from "../../src/engine/contracts/allocator.js";

/**
 * Build an unwrap adapter for a per-allocator typed error class. The adapter's
 * `allocate()` catches any throw whose constructor matches `errorClass` AND
 * carries a `cause`, then rethrows the cause so the conformance suite's
 * `instanceof PersistentProvisioningOutageError` etc. checks read the inner
 * convergence-class error. Non-wrapped throws pass through untouched.
 */
export function unwrapCauseAllocator<E extends abstract new (...args: never[]) => Error>(
  allocator: Allocator,
  errorClass: E,
): Allocator {
  return {
    async allocate(request) {
      try {
        return await allocator.allocate(request);
      } catch (error) {
        if (error instanceof errorClass && (error as Error & { cause?: unknown }).cause !== undefined) {
          throw (error as Error & { cause: unknown }).cause;
        }
        throw error;
      }
    },
    release: allocator.release.bind(allocator),
  };
}
