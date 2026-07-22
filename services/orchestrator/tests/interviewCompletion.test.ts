// rv-21 — DB-free unit coverage for the deterministic interview-completion predicate.
// The route-level proof is RLS-gated (and so does not count toward coverage); these
// pure-function cases pin every required area + every invalid-reference arm.

import { describe, expect, it } from "vitest";
import {
  emptyCapture,
  evaluateInterviewCompletion,
  InterviewIncompleteError,
  type InterviewCapture,
} from "../src/engine/forge/interview/index.js";

const LIFECYCLE = {
  stack: "ts/pnpm",
  bootstrap: "pnpm install",
  tier1: "pnpm lint",
  tier2: "pnpm test",
  tier3: "pnpm build && pnpm test",
  build: "pnpm build",
  deploy: "flyctl deploy",
  toolchain: [],
};

/* eslint-disable unicorn/no-thenable -- Given/When/Then is the captured behavior vocabulary. */
function completeCapture(): InterviewCapture {
  return {
    ...emptyCapture(),
    identity: { slug: "acme", pitch: "a real product", repoHint: "" },
    personas: [{ name: "operator", description: "runs it", surface: "desktop" }],
    behaviors: [
      { persona: "operator", title: "see status", given: "a product", when: "they look", then: "status shows" },
    ],
    interfaces: [{ name: "dashboard", note: "" }],
    designContract: {
      domain: "saas-web",
      identity: "a clean surface",
      intent: "calm + dense",
      principles: [],
      constraints: [],
      personas: ["operator"],
      behaviors: ["operator::see status"],
      dimensions: [],
    },
    architecture: [{ layer: "web", choice: "next.js" }],
    lifecycle: LIFECYCLE,
    rulesets: [],
  };
}
/* eslint-enable unicorn/no-thenable */

describe("evaluateInterviewCompletion — the deterministic completion predicate", () => {
  it("accepts a complete capture (empty rulesets are a valid explicit result)", () => {
    const result = evaluateInterviewCompletion(completeCapture());
    expect(result).toEqual({ complete: true, missing: [], invalid: [] });
  });

  it("an empty capture is missing every required area (positive evidence required, never vacuous)", () => {
    const result = evaluateInterviewCompletion(emptyCapture());
    expect(result.complete).toBe(false);
    expect(result.missing).toEqual([
      "identity",
      "persona",
      "behavior",
      "interface",
      "designSeed",
      "architecture",
      "lifecycle",
    ]);
  });

  it("reports the single missing area for each otherwise-complete capture", () => {
    const cases: Array<[keyof InterviewCapture, unknown, string]> = [
      ["identity", null, "identity"],
      ["interfaces", [], "interface"],
      ["designContract", null, "designSeed"],
      ["architecture", [], "architecture"],
      ["lifecycle", null, "lifecycle"],
    ];
    for (const [field, value, area] of cases) {
      const result = evaluateInterviewCompletion({ ...completeCapture(), [field]: value } as InterviewCapture);
      expect(result.complete).toBe(false);
      expect(result.missing).toEqual([area]);
    }
  });

  it("Gap 1 — whitespace-only content counts as MISSING, never present (no blank-slip)", () => {
    const blankPitch = completeCapture();
    blankPitch.identity = { slug: "acme", pitch: "   ", repoHint: "" };
    expect(evaluateInterviewCompletion(blankPitch).missing).toContain("identity");

    const blankInterface = { ...completeCapture(), interfaces: [{ name: "   ", note: "" }] };
    expect(evaluateInterviewCompletion(blankInterface).missing).toContain("interface");

    const blankArchitecture = { ...completeCapture(), architecture: [{ layer: "   ", choice: "next.js" }] };
    expect(evaluateInterviewCompletion(blankArchitecture).missing).toContain("architecture");

    const blankSeed = completeCapture();
    blankSeed.designContract = { ...blankSeed.designContract!, intent: "   " };
    expect(evaluateInterviewCompletion(blankSeed).missing).toContain("designSeed");
  });

  it("Gap 3 — a behavior with a blank Given/When/Then is INVALID (incompleteBehavior), not merely uncounted", () => {
    /* eslint-disable-next-line unicorn/no-thenable */
    const behaviors = [{ persona: "operator", title: "half-formed", given: "a product", when: "  ", then: "" }];
    const result = evaluateInterviewCompletion({ ...completeCapture(), behaviors });
    expect(result.complete).toBe(false);
    expect(result.missing).toContain("behavior");
    expect(result.invalid).toContainEqual(
      expect.objectContaining({ kind: "incompleteBehavior", ref: "operator::half-formed" }),
    );
  });

  it("a captured persona that owns no fully-formed behavior is invalid (personaWithoutBehavior)", () => {
    /* eslint-disable-next-line unicorn/no-thenable */
    const behaviors = [{ persona: "operator", title: "see status", given: "g", when: "w", then: "t" }];
    const twoPersonas = {
      ...completeCapture(),
      personas: [
        { name: "operator", description: "runs it", surface: "" },
        { name: "auditor", description: "watches", surface: "" },
      ],
      behaviors,
    };
    const result = evaluateInterviewCompletion(twoPersonas);
    expect(result.invalid).toContainEqual(expect.objectContaining({ kind: "personaWithoutBehavior", ref: "auditor" }));
  });

  it("surfaces a behavior naming an uncaptured persona as invalid (no captured reference silently dropped)", () => {
    /* eslint-disable-next-line unicorn/no-thenable */
    const behaviors = [{ persona: "ghost", title: "haunt", given: "g", when: "w", then: "t" }];
    const result = evaluateInterviewCompletion({ ...completeCapture(), behaviors });
    expect(result.complete).toBe(false);
    expect(result.missing).toContain("behavior");
    expect(result.invalid).toContainEqual(expect.objectContaining({ kind: "behaviorPersona", ref: "ghost" }));
  });

  it("Gap 2 — an EMPTY design-seed MOAT does not vacuously complete (every persona + behavior must be covered)", () => {
    const base = completeCapture();
    const emptyMoat = {
      ...base,
      designContract: { ...base.designContract!, personas: [], behaviors: [] },
    };
    const result = evaluateInterviewCompletion(emptyMoat);
    expect(result.complete).toBe(false);
    expect(result.invalid).toContainEqual(expect.objectContaining({ kind: "uncoveredPersona", ref: "operator" }));
    expect(result.invalid).toContainEqual(
      expect.objectContaining({ kind: "uncoveredBehavior", ref: "operator::see status" }),
    );
  });

  it("surfaces dangling design-seed persona and behavior refs (and a dimension persona ref) as invalid", () => {
    const base = completeCapture();
    const result = evaluateInterviewCompletion({
      ...base,
      designContract: {
        ...base.designContract!,
        personas: ["operator", "phantom"],
        behaviors: ["operator::see status", "operator::missing"],
        dimensions: [{ key: "k", label: "L", intent: "i", guidance: "", personas: ["nobody"] }],
      },
    });
    expect(result.complete).toBe(false);
    expect(result.invalid).toContainEqual(expect.objectContaining({ kind: "designPersona", ref: "phantom" }));
    expect(result.invalid).toContainEqual(expect.objectContaining({ kind: "designPersona", ref: "nobody" }));
    expect(result.invalid).toContainEqual(
      expect.objectContaining({ kind: "designBehavior", ref: "operator::missing" }),
    );
  });

  it("InterviewIncompleteError carries the typed missing + invalid areas in its message", () => {
    const error = new InterviewIncompleteError(
      ["designSeed"],
      [{ kind: "behaviorPersona", ref: "ghost", detail: "x" }],
    );
    expect(error.name).toBe("InterviewIncompleteError");
    expect(error.missing).toEqual(["designSeed"]);
    expect(error.message).toContain("designSeed");
    expect(error.message).toContain("behaviorPersona:ghost");
  });
});
