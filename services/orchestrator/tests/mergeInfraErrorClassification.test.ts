// GitHub-5xx resilience (GAP #2d): the infra-error classification the merge coordinator
// branches on. `isRetriableInfraError` is structural — it reads the typed errors'
// readonly `retriable` flag, so the ref-reset transients AND the merge-PUT transients
// both route to the infra-hold, while the permanent/ambiguous ones do not.
// `isAmbiguousMergeError` singles out the unconfirmable-merge case (loud, no auto-retry).

import { describe, expect, it } from "vitest";
import {
  RefResetPermanentError,
  RefResetTransientError,
  isRetriableInfraError,
} from "../src/engine/providers/githubRefReset.js";
import {
  MergeAmbiguousError,
  MergeTransientError,
  isAmbiguousMergeError,
} from "../src/engine/providers/mergeOutcomeErrors.js";

describe("isRetriableInfraError — structural retriable classification", () => {
  it("is true for the typed RETRIABLE transients (ref-reset + merge-PUT)", () => {
    expect(isRetriableInfraError(new RefResetTransientError("racy 422"))).toBe(true);
    expect(isRetriableInfraError(new MergeTransientError("persistent 504, confirmed open"))).toBe(true);
  });

  it("is false for the typed NON-retriable errors (permanent + ambiguous)", () => {
    expect(isRetriableInfraError(new RefResetPermanentError("HTTP 404"))).toBe(false);
    expect(isRetriableInfraError(new MergeAmbiguousError("unconfirmable after 504"))).toBe(false);
  });

  it("defaults an UNTYPED thrown error to retriable (hold, never strand — bounded by the ceiling)", () => {
    expect(isRetriableInfraError(new Error("raw 504 from the merge stage"))).toBe(true);
    expect(isRetriableInfraError("a thrown string")).toBe(true);
    // A non-Error thrown value (the bare-default branch) is still treated retriable.
    expect(isRetriableInfraError({ some: "object" })).toBe(true);
  });

  it("honors an explicit retriable:false on an otherwise-untyped Error", () => {
    const e = Object.assign(new Error("typed-ish"), { retriable: false });
    expect(isRetriableInfraError(e)).toBe(false);
  });
});

describe("isAmbiguousMergeError — the unconfirmable-merge case", () => {
  it("is true only for MergeAmbiguousError", () => {
    expect(isAmbiguousMergeError(new MergeAmbiguousError("unconfirmable"))).toBe(true);
    expect(isAmbiguousMergeError(new MergeTransientError("confirmed open"))).toBe(false);
    expect(isAmbiguousMergeError(new RefResetTransientError("racy 422"))).toBe(false);
    expect(isAmbiguousMergeError(new Error("bare"))).toBe(false);
  });
});
