// FRAGMENT-SUBSYSTEM SEAM EXERCISES.
//
// Exercise the integration seams shipped under engine/templates/fragments/ so
// knip stays satisfied and the seam contracts are pinned (a future PR cannot
// silently change them).

import { describe, expect, it } from "vitest";
import { loadFragmentLibraryForTests, mapDesignContractToTemplateConfig } from "../src/engine/templates/index.js";

describe("template-fragment seams — agentSchemaMapper (placeholder)", () => {
  it("throws on call (the body lands in a later PR; calling it now is a wiring mistake)", () => {
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
