// FRAGMENT-SUBSYSTEM SEAM EXERCISES.
//
// PR-A ships three integration seams that are NOT instantiated by the production
// code-path yet (they ship for the next PRs in the series). Knip flags an unused
// export, which is a strong default. We exercise the seams here so:
//   1. knip is satisfied (the seams are reachable from the test entry tree).
//   2. the seams' CONTRACTS are pinned (a future PR cannot silently change them).
//   3. the PR-E placeholder's `throw` is the documented behavior (a runtime call
//      before PR-E is INCORRECT and must surface loudly).

import { describe, expect, it } from "vitest";
import {
  assertComposedTemplateEvidenceDeclared,
  loadFragmentLibraryForTests,
  mapDesignContractToTemplateConfig,
} from "../src/engine/templates/index.js";
import { DEFAULT_CI_CONFIG } from "../src/engine/ci/index.js";

describe("template-fragment seams — agentSchemaMapper (PR-E placeholder)", () => {
  it("throws on call (the body lands in PR-E; calling it now is a wiring mistake)", () => {
    expect(() => mapDesignContractToTemplateConfig({ placeholder: true })).toThrow(/PR-A is the seam claim only/u);
  });
});

describe("template-fragment seams — loadFragmentLibraryForTests", () => {
  it("returns the production library plus any caller-supplied extras", () => {
    const library = loadFragmentLibraryForTests([
      {
        id: "addon-test-only",
        version: "0.0.0",
        kind: "addon",
        contract: {},
        async apply() {},
      },
    ]);
    expect(library.has("addon-test-only")).toBe(true);
    expect(library.has("base")).toBe(true);
  });
});

describe("template-fragment seams — assertComposedTemplateEvidenceDeclared", () => {
  it("accepts a config with positive evidence declared on the merge-gating tier", () => {
    // The DEFAULT_CI_CONFIG ships positive evidence; the seam should accept it.
    expect(() => assertComposedTemplateEvidenceDeclared(DEFAULT_CI_CONFIG)).not.toThrow();
  });
});
