// The RELEASE FINALIZER seam — the named boundary at which a run's runner is
// released and the release OUTCOME is recorded. Releasing a runner used to be a
// fire-and-forget call in the run loop's `finally` (best-effort, the leak
// swallowed); this seam makes the outcome a FACT: `release()` returns whether the
// runner was actually torn down (`released`) or LEAKED (`leaked`, carrying the
// reason). A leaked runner is real cost + capacity, so it is never silent — the
// caller logs it and the allocator's sweeper reconciles it (it reclaims any
// runner row still active past its max age, which is exactly a leaked release).
//
// This wraps an {@link Allocator}'s `release` — it does not replace it; the
// allocator still owns the destroy + credential wipe. The finalizer NAMES the
// "release + prove cleanup" step so the run loop asks for a finalize outcome
// rather than calling release blind.
import type { Allocator, ReleaseReason } from "./allocator.js";

// The outcome of finalizing a runner's release.
export type FinalizeOutcome =
  | { kind: "released"; runnerId: string; reason: ReleaseReason }
  // The release FAILED — the runner may still be alive (real cost). `message` is
  // the failure detail; the sweeper reconciles the leaked runner by age.
  | { kind: "leaked"; runnerId: string; reason: ReleaseReason; message: string };

export interface ReleaseFinalizer {
  // Release the runner and report the outcome. Never throws for a release
  // failure — a leak is reported as a `leaked` outcome the caller surfaces and
  // the sweeper reconciles, not an exception that derails the run's own
  // finalize. (Programmer errors still throw.)
  finalize(runnerId: string, reason: ReleaseReason): Promise<FinalizeOutcome>;
}

// The one concrete ReleaseFinalizer: it delegates to an Allocator's `release`,
// turning a thrown release error into a `leaked` outcome (so the caller logs the
// leak and the sweeper reclaims it) and a clean return into `released`.
export class AllocatorReleaseFinalizer implements ReleaseFinalizer {
  constructor(private readonly allocator: Allocator) {}

  async finalize(runnerId: string, reason: ReleaseReason): Promise<FinalizeOutcome> {
    try {
      await this.allocator.release(runnerId, reason);
      return { kind: "released", runnerId, reason };
    } catch (error) {
      // LOUD leak: a runner that did not release is real cost/capacity. We record
      // it as a leaked outcome (not a swallowed `.catch`) so the run loop logs it
      // and the allocator sweeper reconciles the still-active row by age.
      return {
        kind: "leaked",
        runnerId,
        reason,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
