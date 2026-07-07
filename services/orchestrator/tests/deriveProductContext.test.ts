// fix/f2-prompt-hardening — `buildProductContextFromCapture` unit tests.
//
// The derive path calls this to turn the accumulated `InterviewCapture` into the
// semi-structured product-context the F2 writer prompt renders. Asserts:
//   - An empty capture ⇒ `undefined` (the writer prompt then omits the section).
//   - A capture with design-contract intent/principles/constraints ⇒ acceptance
//     criteria lines with the shape the writer expects.
//   - Personas + behaviors flow through with their natural keys preserved.
//   - Empty-string surface/given/when/then fields are elided (no noisy prompts).
//
// The `then:` field on the behavior shape is BDD Given/When/Then vocabulary
// (mirroring the CaptureBehavior schema); the thenable-object lint does not apply.
/* eslint-disable unicorn/no-thenable */

import { describe, expect, it } from "vitest";
import { buildProductContextFromCapture, emptyCapture } from "../src/engine/forge/interview/index.js";
import type { InterviewCapture } from "../src/engine/forge/interview/index.js";

describe("buildProductContextFromCapture", () => {
  it("returns undefined for an empty capture (writer prompt omits the section)", () => {
    const capture = emptyCapture();
    expect(buildProductContextFromCapture(capture)).toBeUndefined();
  });

  it("emits identity/intent/principle/constraint acceptance-criteria lines from the design contract", () => {
    const capture: InterviewCapture = {
      ...emptyCapture(),
      designContract: {
        domain: "saas-web",
        identity: "personal link shortener with click counts",
        intent: "a clean, calm surface an operator trusts at a glance",
        principles: ["minimalist admin surface"],
        constraints: ["no third-party analytics"],
        personas: [],
        behaviors: [],
        dimensions: [],
      },
    };
    const context = buildProductContextFromCapture(capture);
    expect(context).toBeDefined();
    expect(context?.acceptanceCriteria).toEqual([
      "identity: personal link shortener with click counts",
      "intent: a clean, calm surface an operator trusts at a glance",
      "principle: minimalist admin surface",
      "constraint: no third-party analytics",
    ]);
  });

  it("appends any captured rulesets to the acceptance-criteria list (durable rulesets → acceptance)", () => {
    const capture: InterviewCapture = {
      ...emptyCapture(),
      rulesets: ["accessibility: WCAG AA", "privacy: no PII outside of session"],
    };
    const context = buildProductContextFromCapture(capture);
    expect(context?.acceptanceCriteria).toEqual([
      "ruleset: accessibility: WCAG AA",
      "ruleset: privacy: no PII outside of session",
    ]);
  });

  it("carries personas + behaviors through, eliding empty surface/given/when/then", () => {
    const capture: InterviewCapture = {
      ...emptyCapture(),
      personas: [
        { name: "Owner", description: "creates links + reads stats", surface: "handheld" },
        { name: "Guest", description: "clicks a shared link", surface: "" },
      ],
      behaviors: [
        {
          persona: "Owner",
          title: "shorten a link",
          given: "an active session",
          when: "they paste a URL",
          then: "a short code is returned",
        },
        // Behavior with empty given/when/then — the empty ones should be elided.
        { persona: "Guest", title: "resolve a short code", given: "", when: "", then: "" },
      ],
    };
    const context = buildProductContextFromCapture(capture);
    expect(context?.personas).toEqual([
      { name: "Owner", description: "creates links + reads stats", surface: "handheld" },
      // No `surface` key on the guest (empty string was elided).
      { name: "Guest", description: "clicks a shared link" },
    ]);
    expect(context?.behaviors).toEqual([
      {
        persona: "Owner",
        title: "shorten a link",
        given: "an active session",
        when: "they paste a URL",
        then: "a short code is returned",
      },
      { persona: "Guest", title: "resolve a short code" },
    ]);
  });
});
