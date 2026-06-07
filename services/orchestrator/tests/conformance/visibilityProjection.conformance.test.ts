// Drives the VisibilityProjection conformance suite (the BEST-EFFORT boundary,
// tanren-owns-the-engine.md §0/§6) against trivial in-memory projections: one that
// throws, one that provides no methods. Wave 1 adds a sibling driver pointing the
// SAME suite at the real GitHub PR/check/comment projection impl.

import type { VisibilityProjection } from "../../src/engine/contracts/visibilityProjection.js";
import { describeVisibilityProjectionConformance } from "./visibilityProjectionConformance.js";

class ThrowingProjection implements VisibilityProjection {
  async openOrUpdateChangeRequest(): Promise<{ url: string; number: number }> {
    throw new Error("forge unreachable");
  }
}

// An empty projection provides NO methods — every projection call is skipped.
const emptyProjection: VisibilityProjection = {};

describeVisibilityProjectionConformance("in-memory projections (throwing + empty)", {
  makeThrowing: () => new ThrowingProjection(),
  makeEmpty: () => emptyProjection,
});
